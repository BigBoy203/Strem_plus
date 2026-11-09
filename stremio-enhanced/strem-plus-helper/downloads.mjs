// Download Ahead: the helper side of the Download Ahead plugin.
//
// Downloads an episode ahead of time into a folder you pick, serves it back to Stremio as a local
// stream, and deletes it once you've watched it. Torrents are downloaded through Stremio's own
// streaming server (http://127.0.0.1:11470/<infoHash>/<fileIdx>), so the same engine, trackers and
// VPN are used; that also means downloads only progress while Stremio is open. They pause when it
// closes and resume (HTTP Range) on the next launch.
//
// Endpoints (all under /dl, plus a tiny Stremio addon under /addon):
//   GET  /dl/state                  -> { folder, engineUp, items: [...] }
//   POST /dl/add      {item}        -> queue a download
//   POST /dl/remove   {key}         -> cancel/delete a download
//   POST /dl/watched  {videoId}     -> mark watched; deleted once the player lets go, unless the
//                                      item is kept or "delete after watching" is off
//   POST /dl/keep     {key, keep}   -> keep one episode (never auto-deleted)
//   POST /dl/settings {autoDelete}  -> turn "delete after watching" on/off
//   POST /dl/left     {videoId}     -> the player for that episode closed
//   GET  /dl/browse?path=           -> folders inside path (drives + Videos/Downloads/Desktop if empty)
//   POST /dl/set-folder {path}      -> set the download folder (must exist and be writable)
//   POST /dl/mkdir {path, name}     -> create a folder (for the in-app folder picker)
//   POST /dl/pick-folder            -> Windows folder picker (unused: it opens behind fullscreen Stremio)
//   POST /dl/open-folder {key?}     -> open the folder in Explorer (or select one download's file)
//   GET  /dl/file/<key>             -> the downloaded file (Range supported) for the player
//   GET  /addon/manifest.json, /addon/stream/<type>/<id>.json -> "📁 Downloaded" streams

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENGINE = "http://127.0.0.1:11470";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(HERE, "downloads.json");
const RETRY_MS = 20_000;          // wait before retrying when the engine is down or a download fails
const STALL_MS = 120_000;         // abort and retry a download that received nothing for this long
const IDLE_DELETE_MS = 10 * 60_000; // watched but the player never said it left: delete after this idle

// autoDelete: delete episodes once watched (per-item `keep` overrides it).
let state = { folder: "", autoDelete: true, items: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8").replace(/^﻿/, "")) }; } catch {}
// A download that was running when the helper stopped resumes from its .part file.
for (const it of Object.values(state.items)) if (it.status === "downloading") it.status = "queued";

const live = {};   // key -> { speed, req, lastData, reads, lastRead, left }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fsp.writeFile(STATE_FILE + ".tmp", JSON.stringify(state, null, 1)).then(() => fsp.rename(STATE_FILE + ".tmp", STATE_FILE)).catch(() => {});
  }, 500);
}
const L = (key) => (live[key] ||= { speed: 0, reads: 0, lastRead: 0, left: false });

// ---------------------------------------------------------------- helpers
const safeName = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 180) || "video";
const MIME = { ".mkv": "video/x-matroska", ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".avi": "video/x-msvideo", ".ts": "video/mp2t", ".mov": "video/quicktime" };

function engineUp() {
  return new Promise((resolve) => {
    const r = http.get(ENGINE + "/settings", { timeout: 3000, agent: false }, (res) => { res.resume(); resolve(res.statusCode < 500); });
    r.on("error", () => resolve(false)); r.on("timeout", () => { r.destroy(); resolve(false); });
  });
}

function sourceUrl(it) {
  return it.infoHash ? `${ENGINE}/${it.infoHash}/${it.fileIdx}` : it.url;
}

async function removeFiles(it) {
  for (const f of [it.file, it.file + ".part"]) {
    try { await fsp.unlink(f); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}

// ---------------------------------------------------------------- downloader (one at a time)
let active = null;

function publicItem(it) {
  const l = live[it.key] || {};
  return { ...it, speed: it.status === "downloading" ? Math.round(l.speed || 0) : 0 };
}

async function pump() {
  if (active) return;
  const next = Object.values(state.items)
    .filter((it) => ["queued", "downloading", "waiting", "error"].includes(it.status) && !(it.retryAt > Date.now()))
    .sort((a, b) => a.addedAt - b.addedAt)[0];
  if (!next) return;
  if (next.infoHash && !(await engineUp())) {
    next.status = "waiting"; next.error = "Waiting for Stremio to be open"; next.retryAt = Date.now() + RETRY_MS; save();
    return;
  }
  active = next.key;
  try { await download(next); }
  catch (e) {
    if (state.items[next.key]) {
      next.status = next.cancelled ? next.status : "error";
      next.error = String(e.message || e).slice(0, 160);
      next.retryAt = Date.now() + RETRY_MS;
      save();
    }
  } finally { active = null; setImmediate(pump); }
}

function download(it) {
  // The async body runs inside .catch so a failing await (mkdir, stat...) becomes a normal
  // download error instead of an unhandled rejection.
  return new Promise((resolve, reject) => { downloadBody(it, resolve, reject).catch(reject); });
}

async function downloadBody(it, resolve, reject) {
  {
    const part = it.file + ".part";
    await fsp.mkdir(path.dirname(it.file), { recursive: true });
    let have = 0;
    try { have = (await fsp.stat(part)).size; } catch {}
    if (it.size && have >= it.size) return finish();

    // Make sure there's room for what's left (plus 1 GB to spare).
    try {
      const sf = await fsp.statfs(path.dirname(it.file));
      const free = sf.bavail * sf.bsize;
      if (it.size && free < it.size - have + 1024 ** 3) return reject(new Error("Not enough free space in the download folder"));
    } catch {}

    it.status = "downloading"; it.error = ""; it.done = have; save();
    const l = L(it.key);
    // Follows redirects (debrid links usually redirect to a CDN).
    const get = (url, hops, cb) => {
      const lib = url.protocol === "https:" ? https : http;
      // agent:false = a fresh connection each time. Stremio Service gets restarted between sessions,
      // and a pooled keep-alive socket to the old process fails with ECONNRESET.
      const r = lib.get(url, { agent: false, headers: { "user-agent": "DownloadAhead/1.0", ...(have ? { Range: `bytes=${have}-` } : {}) } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
          res.resume();
          l.req = get(new URL(res.headers.location, url), hops + 1, cb);
          return;
        }
        cb(res);
      });
      r.on("error", (e) => reject(it.cancelled ? new Error("cancelled") : e));
      return r;
    };
    const req = get(new URL(sourceUrl(it)), 0, (res) => {
      if (res.statusCode >= 300) { res.resume(); return reject(new Error("Source answered HTTP " + res.statusCode)); }
      if (have && res.statusCode === 200) have = 0; // source ignored the Range; start over
      const total = res.statusCode === 206
        ? Number((res.headers["content-range"] || "").split("/")[1]) || it.size
        : Number(res.headers["content-length"]) || it.size;
      if (total) it.size = total;
      const out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
      l.out = out;
      let windowBytes = 0, windowStart = Date.now();
      l.lastData = Date.now();
      const stall = setInterval(() => {
        if (Date.now() - l.lastData > STALL_MS) l.req?.destroy(new Error("No data for 2 minutes"));
        const dt = (Date.now() - windowStart) / 1000;
        if (dt >= 2) { l.speed = windowBytes / dt; windowBytes = 0; windowStart = Date.now(); save(); }
      }, 1000);
      res.on("data", (chunk) => { windowBytes += chunk.length; it.done = (it.done || 0) + chunk.length; l.lastData = Date.now(); });
      res.pipe(out);
      const fail = (e) => { clearInterval(stall); out.destroy(); l.speed = 0; reject(e); };
      res.on("error", fail);
      out.on("error", fail);
      out.on("finish", async () => {
        clearInterval(stall); l.speed = 0;
        if (it.cancelled) return resolve();
        let size = 0; try { size = (await fsp.stat(part)).size; } catch {}
        if (it.size && size < it.size) return reject(new Error("Connection ended early; will resume"));
        finish().catch(reject);
      });
    });
    l.req = req;

    async function finish() {
      await fsp.rename(part, it.file);
      it.status = "done"; it.done = it.size; it.finishedAt = Date.now(); it.error = ""; save();
      resolve();
    }
  }
}

// Deletes watched files once the player has let go of them.
async function sweep() {
  for (const it of Object.values(state.items)) {
    if (it.status !== "watched" || it.keep) continue;
    const l = L(it.key);
    const idle = Date.now() - Math.max(l.lastRead || 0, it.watchedAt || 0);
    if (l.reads > 0) continue;
    if (!l.left && idle < IDLE_DELETE_MS) continue;
    try { await removeFiles(it); delete state.items[it.key]; delete live[it.key]; save(); }
    catch { /* still locked; try again next sweep */ }
  }
}
setInterval(() => { pump(); sweep(); }, 5000).unref();
setTimeout(pump, 1000);

// ---------------------------------------------------------------- folder picker
function pickFolder() {
  const ps = `Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose where Download Ahead saves episodes'
$d.ShowNewFolderButton = $true
${state.folder ? `$d.SelectedPath = '${state.folder.replace(/'/g, "''")}'` : ""}
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }`;
  return new Promise((resolve) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", ps], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out.trim()));
    p.on("error", () => resolve(""));
  });
}

// ---------------------------------------------------------------- HTTP
const readBody = (req) => new Promise((resolve, reject) => {
  let s = ""; req.on("data", (d) => { s += d; if (s.length > 100_000) req.destroy(); });
  req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  req.on("error", reject);
});

function serveFile(req, res, it) {
  const l = L(it.key);
  let size;
  try { size = fs.statSync(it.file).size; } catch { res.writeHead(404); return res.end(); }
  const type = MIME[path.extname(it.file).toLowerCase()] || "application/octet-stream";
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  let start = 0, end = size - 1, code = 200;
  if (m) { start = m[1] ? Number(m[1]) : size - Number(m[2]); end = m[1] && m[2] ? Number(m[2]) : size - 1; code = 206; }
  if (start >= size || start > end) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
  const headers = { "content-type": type, "accept-ranges": "bytes", "content-length": end - start + 1, "access-control-allow-origin": "*" };
  if (code === 206) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  res.writeHead(code, headers);
  if (req.method === "HEAD") return res.end();
  l.reads++; l.lastRead = Date.now(); l.left = false;
  const s = fs.createReadStream(it.file, { start, end });
  let counted = false;
  const done = () => { if (counted) return; counted = true; l.reads = Math.max(0, l.reads - 1); l.lastRead = Date.now(); };
  s.on("error", () => { res.destroy(); done(); }); // e.g. file locked or removed mid-read
  s.pipe(res);
  s.on("close", done); res.on("close", () => { s.destroy(); done(); });
}

function addonStreams(id) {
  return Object.values(state.items).filter((it) => it.status === "done" && it.videoId === id).map((it) => ({
    url: `http://127.0.0.1:48760/dl/file/${it.key}`,
    name: `📁 Downloaded${it.quality ? "\n" + it.quality : ""}`,
    description: `${it.release || it.filename}\n💾 ${(it.size / 1024 ** 3).toFixed(2)} GB · plays from ${path.dirname(it.file)}`,
    behaviorHints: { filename: it.filename, bingeGroup: "downloadahead" },
  }));
}

const MANIFEST = {
  id: "local.downloadahead", version: "1.0.0", name: "Download Ahead",
  description: "Episodes you downloaded ahead with the Download Ahead plugin. They're deleted after you watch them.",
  resources: ["stream"], types: ["movie", "series"], idPrefixes: ["tt"], catalogs: [],
};

// Returns true if it handled the request.
export async function handle(req, res, u, headers, origin) {
  const p = u.pathname;
  if (p === "/addon/manifest.json") { res.writeHead(200, { ...headers, "access-control-allow-origin": "*" }); res.end(JSON.stringify(MANIFEST)); return true; }
  let m = p.match(/^\/addon\/stream\/(movie|series)\/(.+)\.json$/);
  if (m) { res.writeHead(200, { ...headers, "access-control-allow-origin": "*" }); res.end(JSON.stringify({ streams: addonStreams(decodeURIComponent(m[2])) })); return true; }
  m = p.match(/^\/dl\/file\/([0-9a-f]{16})$/);
  if (m) { const it = state.items[m[1]]; if (!it || !["done", "watched"].includes(it.status)) { res.writeHead(404); res.end(); } else serveFile(req, res, it); return true; }
  if (!p.startsWith("/dl/")) return false;

  const send = (code, obj) => { res.writeHead(code, headers); res.end(JSON.stringify(obj)); };
  if (p === "/dl/state" && req.method === "GET") {
    let free = null;
    if (state.folder) { try { const sf = await fsp.statfs(state.folder); free = sf.bavail * sf.bsize; } catch {} }
    send(200, { folder: state.folder, free, autoDelete: state.autoDelete !== false, engineUp: await engineUp(), items: Object.values(state.items).sort((a, b) => a.addedAt - b.addedAt).map(publicItem) });
    return true;
  }
  // Folder browser for the in-app folder picker (a Windows dialog can't appear over Stremio's
  // fullscreen window). Lists drives when no path is given.
  if (p === "/dl/browse" && req.method === "GET") {
    const fromStremio = origin === "https://web.stremio.com" || (!origin && /\bstremio-enhanced\//i.test(req.headers["user-agent"] || ""));
    if (!fromStremio) return send(403, { error: "forbidden" }), true;
    const want = u.searchParams.get("path") || "";
    if (!want) {
      const drives = [];
      for (const l of "CDEFGHIJKLMNOPQRSTUVWXYZ") { try { await fsp.access(l + ":\\"); drives.push({ name: l + ":", path: l + ":\\" }); } catch {} }
      const home = process.env.USERPROFILE || "";
      const quick = ["Videos", "Downloads", "Desktop"].map((n) => ({ name: n, path: path.join(home, n) })).filter((q) => fs.existsSync(q.path));
      return send(200, { path: "", parent: null, dirs: [...quick, ...drives] }), true;
    }
    try {
      const abs = path.resolve(want);
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory() && !/^[.$]/.test(e.name) && !/^(System Volume Information|Recovery|PerfLogs|Config\.Msi)$/i.test(e.name))
        .map((e) => ({ name: e.name, path: path.join(abs, e.name) })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      const root = path.parse(abs).root;
      let free = null; try { const sf = await fsp.statfs(abs); free = sf.bavail * sf.bsize; } catch {}
      return send(200, { path: abs, parent: abs === root ? "" : path.dirname(abs), dirs, free }), true;
    } catch (e) { return send(400, { error: e.code === "EPERM" || e.code === "EACCES" ? "No access to that folder" : "Can't open that folder" }), true; }
  }

  // Everything below changes things on disk: only Stremio may ask. Web pages in a normal browser
  // always send an Origin on these requests and can't remove it, so: web.stremio.com, or no
  // Origin from Stremio Enhanced (its webSecurity:false window sends none; its user agent says
  // "stremio-enhanced/").
  const fromStremio = origin === "https://web.stremio.com" ||
    (!origin && /\bstremio-enhanced\//i.test(req.headers["user-agent"] || ""));
  if (req.method !== "POST" || !fromStremio) { send(403, { error: "forbidden" }); return true; }
  const body = await readBody(req).catch(() => null);
  if (!body) { send(400, { error: "bad JSON" }); return true; }

  if (p === "/dl/pick-folder") {
    const folder = await pickFolder();
    if (folder) { state.folder = folder; save(); }
    send(200, { folder: state.folder, picked: !!folder });
    return true;
  }
  if (p === "/dl/set-folder") {
    try {
      const abs = path.resolve(String(body.path || ""));
      if (!(await fsp.stat(abs)).isDirectory()) throw new Error();
      // Make sure we can write there.
      const probe = path.join(abs, `.downloadahead-${process.pid}.tmp`);
      await fsp.writeFile(probe, ""); await fsp.unlink(probe);
      state.folder = abs; save();
      send(200, { folder: abs });
    } catch { send(400, { error: "Can't save to that folder (it doesn't exist or isn't writable)" }); }
    return true;
  }
  if (p === "/dl/mkdir") {
    try {
      const name = safeName(body.name || "");
      if (!name || name === "video") throw new Error();
      const abs = path.join(path.resolve(String(body.path || "")), name);
      await fsp.mkdir(abs, { recursive: false });
      send(200, { path: abs });
    } catch (e) { send(400, { error: e.code === "EEXIST" ? "A folder with that name already exists" : "Couldn't create that folder" }); }
    return true;
  }
  if (p === "/dl/open-folder") {
    // Opens the download folder in Explorer, or selects one download's file.
    const it = body.key ? state.items[body.key] : null;
    let args = null;
    if (it && fs.existsSync(it.file)) args = ["/select,", it.file];
    else if (state.folder && fs.existsSync(state.folder)) args = [state.folder];
    if (!args) return send(404, { error: "folder not found" }), true;
    spawn("explorer.exe", args, { detached: true, stdio: "ignore" }).unref();
    send(200, { ok: true });
    return true;
  }
  if (p === "/dl/add") {
    if (!state.folder) return send(400, { error: "Choose a download folder first" }), true;
    const hash = String(body.infoHash || "").toLowerCase();
    const isTorrent = /^[0-9a-f]{40}$/.test(hash) && Number.isInteger(body.fileIdx);
    const isUrl = /^https?:\/\//i.test(body.url || "");
    if ((!isTorrent && !isUrl) || !body.videoId) return send(400, { error: "missing stream or episode" }), true;
    const key = crypto.createHash("sha1").update(body.videoId + "|" + (isTorrent ? hash + ":" + body.fileIdx : body.url)).digest("hex").slice(0, 16);
    if (!state.items[key]) {
      const filename = safeName(body.filename || (body.title || body.videoId) + ".mkv");
      state.items[key] = {
        key, videoId: String(body.videoId), metaId: String(body.metaId || ""), type: body.type === "movie" ? "movie" : "series",
        title: String(body.title || body.videoId).slice(0, 200), release: String(body.release || "").slice(0, 300),
        quality: String(body.quality || "").slice(0, 40), filename,
        file: path.join(state.folder, safeName(body.show || "Stremio"), filename),
        ...(isTorrent ? { infoHash: hash, fileIdx: body.fileIdx } : { url: body.url }),
        size: Number(body.size) || 0, done: 0, status: "queued", error: "", addedAt: Date.now(),
      };
      save();
    }
    pump();
    send(200, publicItem(state.items[key]));
    return true;
  }
  if (p === "/dl/remove") {
    const it = state.items[body.key];
    if (!it) return send(404, { error: "not found" }), true;
    it.cancelled = true;
    live[it.key]?.req?.destroy();
    live[it.key]?.out?.destroy(); // close the .part file so it can be deleted right away
    setTimeout(async () => {
      try { await removeFiles(it); delete state.items[it.key]; delete live[it.key]; save(); }
      catch { it.status = "watched"; it.watchedAt = 0; L(it.key).left = true; save(); } // locked: the sweep finishes it
    }, 300);
    send(200, { ok: true });
    return true;
  }
  if (p === "/dl/settings") {
    if (typeof body.autoDelete === "boolean") state.autoDelete = body.autoDelete;
    save();
    send(200, { autoDelete: state.autoDelete });
    return true;
  }
  if (p === "/dl/keep") {
    const it = state.items[body.key];
    if (!it) return send(404, { error: "not found" }), true;
    it.keep = !!body.keep;
    // Kept while waiting to be deleted: undo the pending delete.
    if (it.keep && it.status === "watched" && fs.existsSync(it.file)) { it.status = "done"; it.watched = true; }
    save();
    send(200, publicItem(it));
    return true;
  }
  if (p === "/dl/watched" || p === "/dl/left") {
    let n = 0;
    for (const it of Object.values(state.items)) {
      if (it.videoId !== body.videoId) continue;
      n++;
      if (p === "/dl/watched") {
        if (it.keep || state.autoDelete === false) {
          // Not deleting: just remember it was watched.
          if (!it.watched) { it.watched = true; it.watchedAt = Date.now(); }
        } else if (it.status !== "watched") {
          it.cancelled = it.status !== "done"; live[it.key]?.req?.destroy(); it.status = "watched"; it.watchedAt = Date.now();
        }
      } else L(it.key).left = true;
    }
    if (n) { save(); sweep(); }
    send(200, { ok: true, matched: n });
    return true;
  }
  send(404, { error: "not found" });
  return true;
}
