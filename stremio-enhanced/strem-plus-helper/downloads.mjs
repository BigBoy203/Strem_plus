// Download Ahead: the helper side of the Download Ahead plugin.
//
// Downloads an episode ahead of time into a folder you pick, serves it back to Stremio as a local
// stream, and deletes it once you've watched it. Torrents are downloaded through Stremio's own
// streaming server (http://127.0.0.1:11470/<infoHash>/<fileIdx>), so the same engine, trackers and
// network (including any VPN) are used; that also means downloads only progress while Stremio is open. They pause when it
// closes and resume (HTTP Range) on the next launch.
//
// Endpoints (all under /dl, plus a tiny Stremio addon under /addon):
//   GET  /dl/state                  -> { folder, engineUp, items: [...] }
//   POST /dl/add      {item}        -> queue a download
//   POST /dl/remove   {key}         -> cancel/delete a download
//   POST /dl/watched  {videoId}     -> mark watched; deleted once the player lets go, unless the
//                                      item is kept or "delete after watching" is off
//   POST /dl/keep     {key, keep}   -> keep one episode (never auto-deleted)
//   POST /dl/settings {autoDelete?, convertToMp4?, disabledTypes?} -> page settings (types turned off are
//                                     hidden from the "📁 Downloaded" streams)
//   POST /dl/format   {key, format} -> "original" keeps one download as is; "mp4"/"mov"/"mkv" converts it
//   POST /dl/left     {videoId}     -> the player for that episode closed
//   GET  /dl/browse?path=           -> folders inside path (drives + Videos/Downloads/Desktop if empty)
//   POST /dl/set-folder {path}      -> set the download folder (must exist and be writable)
//   POST /dl/mkdir {path, name}     -> create a folder (for the in-app folder picker)
//   POST /dl/pick-folder            -> Windows folder picker (unused: it opens behind fullscreen Stremio)
//   POST /dl/open-folder {key?}     -> open the folder in Explorer (or select one download's file)
//   GET  /dl/file/<key>[.<ext>]     -> the downloaded file (Range supported) for the player. The
//                                     extension changes when a file is repackaged, so Stremio's
//                                     streaming server doesn't reuse its cached probe of the old one.
//   GET  /addon/manifest.json, /addon/stream/<type>/<id>.json -> "📁 Downloaded" streams

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENGINE = "http://127.0.0.1:11470";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(HERE, "downloads.json");
const RETRY_MS = 20_000;          // wait before retrying when the engine is down or a download fails
const STALL_MS = 120_000;         // abort and retry a download that received nothing for this long
const IDLE_DELETE_MS = 10 * 60_000; // watched but the player never said it left: delete after this idle

// autoDelete: delete episodes once watched (per-item `keep` overrides it).
// convertToMp4: repackage finished downloads as MP4 (per-item `format: "original"|"mp4"` overrides it).
// disabledTypes: file types (e.g. "mkv") turned off on the Downloads page: not offered as "📁 Downloaded"
// streams until turned back on or converted.
let state = { folder: "", autoDelete: true, convertToMp4: true, disabledTypes: [], items: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8").replace(/^﻿/, "")) }; } catch {}
// A download that was running when the helper stopped resumes from its .part file.
for (const it of Object.values(state.items)) {
  if (it.status === "downloading") it.status = "queued";
  it.optimizing = false;                                   // a conversion cut off by a restart starts over
  if (it.optimizedFile && !it.optimizedTo) it.optimizedTo = "mp4"; // made before other targets existed
}

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
const MIME = { ".mkv": "video/x-matroska", ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".avi": "video/x-msvideo", ".ts": "video/mp2t", ".m2ts": "video/mp2t", ".mov": "video/quicktime", ".wmv": "video/x-ms-wmv", ".flv": "video/x-flv" };

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
  for (const f of [it.file, it.file + ".part", it.optimizedFile, it.oldFile].filter(Boolean)) {
    try { await fsp.unlink(f); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}

// ---------------------------------------------------------------- downloader (one at a time)
let active = null;

function publicItem(it) {
  const l = live[it.key] || {};
  // fileType: MKV/MP4/...; playback: how Stremio will play it (see "optimize for direct play").
  // playback: how Stremio will play it / what the converter is doing (see "convert for direct play").
  const t = targetOf(it);
  const playback = it.optimizing ? "optimizing" : it.optimizedFile ? "swapping"
    : it.optimized === "failed" ? "failed" : it.optimized === "skipped" ? "converter"
    : FF && it.status === "done" && needsWork(it) ? "pending" : it.optimized === true ? "direct" : !t ? "kept" : "converter";
  const fileType = path.extname(it.file).slice(1).toUpperCase();
  return { ...it, speed: it.status === "downloading" ? Math.round(l.speed || 0) : 0,
    fileType, originalType: it.originalType || fileType, target: t, converting: it.optimizing || it.optimizedTo || null,
    playback, optimizing: !!it.optimizing, optimizedFile: undefined, optimizedTo: undefined, oldFile: undefined };
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
// ---------------------------------------------------------------- optimize for direct play
// Stremio only plays a file directly when it has no subtitle tracks inside it, one audio track,
// stereo (or mono) audio and a codec the browser can decode. Anything else goes through the
// streaming server's converter, which re-cuts the video into pieces; at every joint between two
// pieces the picture freezes for a few seconds. So each finished download is repackaged once into
// an MP4 that meets those rules: video copied as is (no quality loss), the first audio track
// mixed to stereo AAC with the dialogue kept forward, built-in subtitles dropped.
// Uses an FFmpeg next to this helper or in the folder above it, or one on PATH.
const FF = (() => {
  const exe = process.platform === "win32" ? ".exe" : "";
  const dirs = [path.join(HERE, "ffmpeg"), path.join(HERE, "..", "ffmpeg"), ""];
  for (const d of dirs) {
    const ffmpeg = d ? path.join(d, "ffmpeg" + exe) : "ffmpeg", ffprobe = d ? path.join(d, "ffprobe" + exe) : "ffprobe";
    if (d && !fs.existsSync(ffmpeg)) continue;
    try { if (spawnSync(ffmpeg, ["-version"], { timeout: 10000, windowsHide: true }).status === 0 && spawnSync(ffprobe, ["-version"], { timeout: 10000, windowsHide: true }).status === 0) return { ffmpeg, ffprobe }; } catch {}
  }
  return null;
})();
const PLAYABLE_VIDEO = ["h264", "hevc", "vp9"];   // what Stremio's player accepts directly
// What each conversion target makes. "smooth" targets meet Stremio's direct-play rules (one stereo
// AAC track, no subtitles). The others are built from `args`: MKV/TS/M2TS copy the tracks as they
// are; WEBM, AVI, WMV and FLV can't hold modern video, so the picture is re-encoded (slower, and
// for AVI/WMV/FLV a real downgrade). `needs` = encoders the FFmpeg build must have.
const STEREO = ["-ac", "2"];
const TARGETS = {
  mp4: { mux: "mp4", smooth: true },
  m4v: { mux: "mp4", smooth: true },
  mov: { mux: "mov", smooth: true },
  mkv: { mux: "matroska", args: ["-map", "0", "-c", "copy"] },
  webm: { mux: "webm", needs: ["libvpx-vp9", "libopus"], args: ["-map", "0:V:0", "-map", "0:a:0?", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-crf", "32", "-b:v", "0", "-c:a", "libopus", "-b:a", "160k", ...STEREO, "-sn"] },
  ts: { mux: "mpegts", args: ["-map", "0:V:0", "-map", "0:a?", "-c", "copy", "-sn"] },
  m2ts: { mux: "mpegts", args: ["-map", "0:V:0", "-map", "0:a?", "-c", "copy", "-sn", "-mpegts_m2ts_mode", "1"] },
  avi: { mux: "avi", needs: ["mpeg4", "libmp3lame"], args: ["-map", "0:V:0", "-map", "0:a:0?", "-c:v", "mpeg4", "-vtag", "xvid", "-q:v", "4", "-c:a", "libmp3lame", "-b:a", "192k", ...STEREO, "-sn"] },
  wmv: { mux: "asf", needs: ["wmv2", "wmav2"], args: ["-map", "0:V:0", "-map", "0:a:0?", "-c:v", "wmv2", "-q:v", "4", "-c:a", "wmav2", "-b:a", "192k", ...STEREO, "-sn"] },
  flv: { mux: "flv", needs: ["flv", "libmp3lame"], args: ["-map", "0:V:0", "-map", "0:a:0?", "-c:v", "flv", "-q:v", "4", "-c:a", "libmp3lame", "-b:a", "192k", ...STEREO, "-ar", "44100", "-sn"] },
};
// Drop targets this FFmpeg can't make (missing encoders).
if (FF) {
  const enc = String(spawnSync(FF.ffmpeg, ["-hide_banner", "-encoders"], { timeout: 10000, windowsHide: true }).stdout || "");
  const have = new Set(enc.split(/\s+/));
  for (const [t, d] of Object.entries(TARGETS)) if ((d.needs || []).some((e) => !have.has(e))) delete TARGETS[t];
}
let optimizing = null, optChild = null;
const extOf = (f) => path.extname(f).slice(1).toLowerCase();
// Which file type this download should end up as, or null to leave it alone. The item's own choice
// (Keep original / Convert to...) wins, then the Downloads page's "Convert to MP4" switch.
const targetOf = (it) => (it.format === "original" ? null : TARGETS[it.format] ? it.format : state.convertToMp4 !== false ? "mp4" : null);
// Still needs converting? For a smooth target, `optimized === true` means the file is already that
// type and plays directly.
function needsWork(it) {
  const t = targetOf(it);
  if (!t) return false;
  return TARGETS[t].smooth ? !(extOf(it.file) === t && it.optimized === true) : extOf(it.file) !== t;
}

function run(bin, args, onSpawn) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    onSpawn?.(p);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split("\n").pop() || "exit " + code))));
  });
}

// Does this file already play directly in Stremio? (Same rules as Stremio's own check.)
async function inspect(file) {
  const j = JSON.parse(await run(FF.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,channels:stream_disposition=attached_pic:format=format_name", "-of", "json", file]));
  const streams = j.streams || [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.filter((s) => s.codec_type === "audio");
  const direct = /mp4/.test(j.format?.format_name || "") && !streams.some((s) => s.codec_type === "subtitle") &&
    audio.length === 1 && audio[0].codec_name === "aac" && (audio[0].channels || 2) <= 2 && PLAYABLE_VIDEO.includes(video?.codec_name);
  return { video, audio: audio[0], direct };
}

async function optimize(it) {
  const t = targetOf(it);
  const info = await inspect(it.file);
  if (TARGETS[t].smooth && info.direct && extOf(it.file) === t) { it.optimized = true; save(); return; }
  if (TARGETS[t].smooth && (!info.video || !PLAYABLE_VIDEO.includes(info.video.codec_name))) { it.optimized = "skipped"; save(); return; } // would still need converting
  const out = it.file.replace(/\.[^./\\]+$/, "") + "." + t;
  const tmp = `${out}.${process.pid}.optimizing`; // per-run name: a leftover from a crashed run can't clash
  let args;
  if (TARGETS[t].smooth) {
    const audio = !info.audio ? ["-an"]
      : info.audio.codec_name === "aac" && (info.audio.channels || 2) <= 2 ? ["-map", "0:a:0", "-c:a", "copy"]
      // Centre channel (dialogue) at full level instead of the usual -3 dB, surrounds softer.
      : ["-map", "0:a:0", "-c:a", "aac", "-b:a", "256k", "-af", "aresample=ochl=stereo:clev=1:slev=0.6:lfe_mix_level=0.5,alimiter=limit=0.97:level=false"];
    args = ["-map", "0:V:0", "-c:v", "copy", ...(info.video.codec_name === "hevc" ? ["-tag:v", "hvc1"] : []), ...audio,
      "-sn", "-dn", "-map_chapters", "-1", "-movflags", "+faststart"];
  } else {
    args = TARGETS[t].args;
  }
  it.optimizing = t; it.optimizeError = ""; save();
  try {
    await run(FF.ffmpeg, ["-hide_banner", "-nostdin", "-y", "-v", "error", "-i", it.file, ...args, "-f", TARGETS[t].mux, tmp], (p) => (optChild = p));
    if (TARGETS[t].smooth && !(await inspect(tmp)).direct) throw new Error("converted file still isn't directly playable");
    it.optimizedFile = tmp; it.optimizedTo = t; // swapped in by swapOptimized() once nothing is reading the original
  } catch (e) {
    try { await fsp.unlink(tmp); } catch {}
    // Stopped because they changed their mind mid-way: not a failure.
    if (targetOf(it) === t) { it.optimized = "failed"; it.optimizeError = String(e.message || e).slice(0, 160); }
  } finally {
    optChild = null; it.optimizing = false; save();
    if (!state.items[it.key]) try { await fsp.unlink(tmp); } catch {} // removed while it was being converted
  }
}

// Swap the converted file in, but never while the player is reading the original: the player
// asks for byte ranges, and the new file's bytes are in different places.
async function swapOptimized(it) {
  const l = L(it.key);
  if (l.reads > 0 || Date.now() - (l.lastRead || 0) < 60_000) return;
  const out = it.optimizedFile.replace(/(\.\d+)?\.optimizing$/, "");
  const old = it.file;
  try {
    await fsp.rename(it.optimizedFile, out);
    it.originalType ||= extOf(old).toUpperCase(); // what it was downloaded as, kept through later conversions
    it.file = out; it.filename = path.basename(out); it.size = (await fsp.stat(out)).size; it.done = it.size;
    it.optimized = TARGETS[it.optimizedTo]?.smooth ? true : false; it.checked = true;
    delete it.optimizedFile; delete it.optimizedTo; save();
  } catch { return; }
  if (old !== out) try { await fsp.unlink(old); } catch { it.oldFile = old; save(); } // still locked: retried below
}

// On start: drop half-written files from a run that was cut off (still-locked ones are retried next start).
setTimeout(async () => {
  const keepFiles = new Set(Object.values(state.items).map((it) => it.optimizedFile).filter(Boolean));
  for (const it of Object.values(state.items)) if (it.optimizedFile && !fs.existsSync(it.optimizedFile)) { delete it.optimizedFile; delete it.optimizedTo; save(); }
  for (const dir of new Set(Object.values(state.items).map((it) => path.dirname(it.file)))) {
    let names = []; try { names = await fsp.readdir(dir); } catch {}
    for (const n of names) if (n.endsWith(".optimizing") && !keepFiles.has(path.join(dir, n))) try { await fsp.unlink(path.join(dir, n)); } catch {}
  }
}, 500);

async function optimizeTick() {
  if (!FF) return;
  // Quick check (a fraction of a second each) so files that already play directly show as such
  // right away instead of waiting their turn behind conversions.
  for (const it of Object.values(state.items)) {
    if (it.status !== "done" || it.optimized || it.checked || it.optimizedFile || !fs.existsSync(it.file)) continue;
    try { if ((await inspect(it.file)).direct) it.optimized = true; } catch {}
    it.checked = true; save();
  }
  for (const it of Object.values(state.items)) {
    if (it.oldFile) try { await fsp.unlink(it.oldFile); delete it.oldFile; save(); } catch (e) { if (e.code === "ENOENT") { delete it.oldFile; save(); } }
    // Converted, but they've since picked something else: throw that file away.
    if (it.optimizedFile && targetOf(it) !== it.optimizedTo) { try { await fsp.unlink(it.optimizedFile); } catch {} delete it.optimizedFile; delete it.optimizedTo; save(); }
    if (it.optimizedFile && it.status === "done") await swapOptimized(it);
  }
  if (optimizing) return;
  const next = Object.values(state.items).find((it) => it.status === "done" && !it.optimizedFile && needsWork(it) &&
    it.optimized !== "failed" && it.optimized !== "skipped" && fs.existsSync(it.file));
  if (!next) return;
  optimizing = next.key;
  try { await optimize(next); } catch (e) { next.optimizing = false; next.optimized = "failed"; next.optimizeError = String(e.message || e).slice(0, 160); save(); }
  finally { optimizing = null; }
}

setInterval(() => { pump(); sweep(); optimizeTick(); }, 5000).unref();
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
  const off = new Set(state.disabledTypes || []);
  return Object.values(state.items).filter((it) => it.status === "done" && it.videoId === id && !off.has(path.extname(it.file).slice(1).toLowerCase())).map((it) => ({
    url: `http://127.0.0.1:48760/dl/file/${it.key}${path.extname(it.file).toLowerCase()}`,
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
  m = p.match(/^\/dl\/file\/([0-9a-f]{16})(?:\.[a-z0-9]{1,5})?$/);
  if (m) { const it = state.items[m[1]]; if (!it || !["done", "watched"].includes(it.status)) { res.writeHead(404); res.end(); } else serveFile(req, res, it); return true; }
  if (!p.startsWith("/dl/")) return false;

  const send = (code, obj) => { res.writeHead(code, headers); res.end(JSON.stringify(obj)); };
  if (p === "/dl/state" && req.method === "GET") {
    let free = null;
    if (state.folder) { try { const sf = await fsp.statfs(state.folder); free = sf.bavail * sf.bsize; } catch {} }
    send(200, { folder: state.folder, free, autoDelete: state.autoDelete !== false, convertToMp4: state.convertToMp4 !== false, disabledTypes: state.disabledTypes || [], canConvert: !!FF, targets: FF ? Object.keys(TARGETS) : [], engineUp: await engineUp(), items: Object.values(state.items).sort((a, b) => a.addedAt - b.addedAt).map(publicItem) });
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
    if (typeof body.convertToMp4 === "boolean") state.convertToMp4 = body.convertToMp4;
    if (Array.isArray(body.disabledTypes)) state.disabledTypes = [...new Set(body.disabledTypes.map(String).filter((t) => /^[a-z0-9]{2,5}$/.test(t)))];
    if (optimizing && state.items[optimizing] && targetOf(state.items[optimizing]) !== state.items[optimizing].optimizing) optChild?.kill();
    save();
    send(200, { autoDelete: state.autoDelete, convertToMp4: state.convertToMp4, disabledTypes: state.disabledTypes });
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
  if (p === "/dl/format") {
    // "original": leave the file as it is; "mp4"/"mov"/"mkv": convert it to that file type.
    const it = state.items[body.key];
    if (!it || !(body.format === "original" || TARGETS[body.format])) return send(404, { error: "not found" }), true;
    it.format = body.format;
    if (it.optimized === "failed" || it.optimized === "skipped") { it.optimized = false; it.optimizeError = ""; } // try again
    if (optimizing === it.key && it.optimizing !== targetOf(it)) optChild?.kill(); // changed their mind mid-way
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
