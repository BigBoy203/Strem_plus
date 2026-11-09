// Torrent Stats helper: asks BitTorrent trackers how many seeders/leechers a torrent has.
//
// The TorrentStats plugin runs inside web.stremio.com (an https page), which can only reach
// https trackers. The trackers that matter (opentrackr, etc.) are UDP or plain http, so the
// plugin asks this helper instead. Node built-ins only, no npm install needed.
//
//   GET http://127.0.0.1:48760/scrape?hash=<40 hex>&tr=<tracker url>&tr=...
//   -> { hash, trackers: [{ url, ok, seeders, leechers, completed, ms, error }] }
//   GET http://127.0.0.1:48760/health -> { ok: true }
//
// It also runs the Download Ahead downloads (see downloads.mjs for those endpoints).
//
// Usage: node scrape-helper.mjs        (start-hidden.vbs runs it with no window)

import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import crypto from "node:crypto";
import fs from "node:fs";
import { promises as dns } from "node:dns";
import * as downloads from "./downloads.mjs";

const PORT = 48760;
const TIMEOUT_MS = 6000;     // per step: DNS lookup, then the tracker exchange
const CACHE_MS = 60_000;     // answers are reused for a minute
const FAIL_CACHE_MS = 15_000; // failures are retried sooner (e.g. after a VPN reconnect)

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

// dns.lookup (the Windows resolver) runs on libuv's thread pool, 4 threads by default, so ~20
// trackers, some with dead hostnames that take seconds to fail, queue behind each other.
// start-hidden.vbs sets UV_THREADPOOL_SIZE=32 to run them all at once. dns.resolve* isn't used:
// it bypasses Windows and hangs here under the VPN.
async function resolveHost(host) {
  if (/^[\d.]+$/.test(host)) return { address: host, family: 4 };
  if (host.includes(":")) return { address: host, family: 6 };
  try { return await dns.lookup(host); } catch (e) {
    throw new Error(e.code === "ENOTFOUND" ? "tracker hostname doesn't exist" : "DNS: " + (e.code || e.message));
  }
}
function lookupForHttp(host, opts, cb) {
  withTimeout(resolveHost(host), TIMEOUT_MS, "DNS lookup timed out")
    .then(({ address, family }) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)))
    .catch((e) => cb(e));
}
const MAX_TRACKERS = 40;
// Pages other than Stremio can't use the helper.
const ALLOWED_ORIGINS = new Set(["https://web.stremio.com", "null", "file://"]);

const cache = new Map(); // `${hash}|${url}` -> { at, result }

// ---------------------------------------------------------------- bencode (just enough)
function bdecode(buf) {
  let i = 0;
  const next = () => {
    const c = buf[i];
    if (c === 0x69) { // i<n>e
      const end = buf.indexOf(0x65, i);
      const n = Number(buf.subarray(i + 1, end).toString("latin1"));
      i = end + 1; return n;
    }
    if (c === 0x6c) { i++; const a = []; while (buf[i] !== 0x65) a.push(next()); i++; return a; }
    if (c === 0x64) {
      i++; const o = {};
      while (buf[i] !== 0x65) { const k = next().toString("latin1"); o[k] = next(); }
      i++; return o;
    }
    if (c >= 0x30 && c <= 0x39) {
      const colon = buf.indexOf(0x3a, i);
      const len = Number(buf.subarray(i, colon).toString("latin1"));
      const s = buf.subarray(colon + 1, colon + 1 + len);
      i = colon + 1 + len; return s;
    }
    throw new Error("bad bencode");
  };
  return next();
}

// ---------------------------------------------------------------- HTTP(S) scrape
function httpScrape(trackerUrl, hashHex) {
  const u = new URL(trackerUrl);
  const parts = u.pathname.split("/");
  const last = parts[parts.length - 1];
  if (!last.startsWith("announce")) throw new Error("tracker has no scrape URL");
  parts[parts.length - 1] = "scrape" + last.slice("announce".length);
  u.pathname = parts.join("/");
  const ih = hashHex.match(/../g).map((b) => "%" + b).join("");
  const target = u.toString() + (u.search ? "&" : "?") + "info_hash=" + ih;
  const lib = u.protocol === "https:" ? https : http;
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("unsupported tracker type");
  return new Promise((resolve, reject) => {
    const req = lib.get(target, { timeout: TIMEOUT_MS, rejectUnauthorized: false, lookup: lookupForHttp, headers: { "user-agent": "TorrentStats/1.0" } }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > 65536) req.destroy(new Error("response too large")); else chunks.push(c); });
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) throw new Error("HTTP " + res.statusCode);
          const d = bdecode(Buffer.concat(chunks));
          if (d["failure reason"]) throw new Error(d["failure reason"].toString());
          const files = d.files || {};
          const entry = files[Buffer.from(hashHex, "hex").toString("latin1")] || Object.values(files)[0];
          if (!entry) throw new Error("torrent not on this tracker");
          resolve({ seeders: entry.complete ?? 0, leechers: entry.incomplete ?? 0, completed: entry.downloaded ?? null });
        } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------- UDP scrape (BEP 15)
async function udpScrape(trackerUrl, hashHex) {
  const u = new URL(trackerUrl);
  const port = Number(u.port);
  if (!port) throw new Error("no port");
  // Look the host up first so slow DNS doesn't eat into the tracker's own timeout.
  const { address: host, family } = await withTimeout(resolveHost(u.hostname.replace(/^\[|\]$/g, "")), TIMEOUT_MS, "DNS lookup timed out");
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(family === 6 ? "udp6" : "udp4");
    let done = false, connId = null, tx = 0, last = null;
    const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); clearInterval(resend); try { sock.close(); } catch {} err ? reject(err) : resolve(val); };
    const timer = setTimeout(() => finish(new Error("timed out")), TIMEOUT_MS);
    // UDP packets get lost; resend the last request until the tracker answers.
    const resend = setInterval(() => last && sock.send(last, port, host, () => {}), 1500);
    const send = (buf) => { last = buf; sock.send(buf, port, host, (e) => e && finish(e)); };
    const sendConnect = () => {
      tx = crypto.randomBytes(4).readUInt32BE();
      const b = Buffer.alloc(16);
      b.writeUInt32BE(0x417, 0); b.writeUInt32BE(0x27101980, 4); // protocol id
      b.writeUInt32BE(0, 8); b.writeUInt32BE(tx, 12);
      send(b);
    };
    sock.on("error", (e) => finish(e));
    sock.on("message", (msg) => {
      if (msg.length < 8 || msg.readUInt32BE(4) !== tx) return;
      const action = msg.readUInt32BE(0);
      if (action === 3) return finish(new Error(msg.subarray(8).toString() || "tracker error"));
      if (action === 0 && connId === null && msg.length >= 16) {
        connId = msg.subarray(8, 16);
        tx = crypto.randomBytes(4).readUInt32BE();
        const b = Buffer.alloc(36);
        connId.copy(b, 0); b.writeUInt32BE(2, 8); b.writeUInt32BE(tx, 12);
        Buffer.from(hashHex, "hex").copy(b, 16);
        return send(b);
      }
      if (action === 2 && msg.length >= 20) {
        finish(null, { seeders: msg.readUInt32BE(8), completed: msg.readUInt32BE(12), leechers: msg.readUInt32BE(16) });
      }
    });
    sendConnect();
  });
}

async function scrapeOne(url, hash) {
  const key = hash + "|" + url;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.result.ok ? CACHE_MS : FAIL_CACHE_MS)) return hit.result;
  const t0 = Date.now();
  let result;
  try {
    const proto = new URL(url).protocol;
    const r = proto === "udp:" ? await udpScrape(url, hash)
      : proto === "http:" || proto === "https:" ? await httpScrape(url, hash)
      : (() => { throw new Error("unsupported tracker type"); })();
    result = { url, ok: true, ...r, ms: Date.now() - t0 };
  } catch (e) {
    result = { url, ok: false, error: String(e.message || e).slice(0, 120), ms: Date.now() - t0 };
  }
  cache.set(key, { at: Date.now(), result });
  return result;
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) { res.writeHead(403); return res.end(); }
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (origin) headers["access-control-allow-origin"] = origin;
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...headers, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type",
      "access-control-allow-private-network": "true", "access-control-max-age": "600" });
    return res.end();
  }
  const u = new URL(req.url, "http://127.0.0.1");
  try {
    if (u.pathname === "/health") { res.writeHead(200, headers); return res.end('{"ok":true}'); }
    if (await downloads.handle(req, res, u, headers, origin)) return; // Download Ahead (downloads.mjs)
    if (u.pathname !== "/scrape") { res.writeHead(404, headers); return res.end('{"error":"not found"}'); }
    const hash = (u.searchParams.get("hash") || "").toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(hash)) { res.writeHead(400, headers); return res.end('{"error":"bad hash"}'); }
    const trackers = [...new Set(u.searchParams.getAll("tr"))]
      .filter((t) => /^(udp|https?):\/\//i.test(t)).slice(0, MAX_TRACKERS);
    const results = await Promise.all(trackers.map((t) => scrapeOne(t, hash)));
    res.writeHead(200, headers);
    res.end(JSON.stringify({ hash, trackers: results }));
  } catch (e) {
    logLine("request " + req.url.slice(0, 120) + " failed: " + (e.stack || e));
    // Headers may already be out (e.g. mid-way through serving a video file); writing them again
    // would throw a second error and take the whole helper down.
    if (res.headersSent) res.destroy();
    else { res.writeHead(500, headers); res.end(JSON.stringify({ error: String(e.message || e) })); }
  }
});

// The helper runs hidden, so keep a small log of anything that goes wrong, and keep running
// instead of exiting on an unexpected error.
const LOG = new URL("./helper.log", import.meta.url);
function logLine(msg) {
  try {
    const f = fs.statSync(LOG, { throwIfNoEntry: false });
    if (f && f.size > 200_000) fs.renameSync(LOG, new URL("./helper.old.log", import.meta.url));
    fs.appendFileSync(LOG, `${new Date().toISOString()}  ${msg}\n`);
  } catch {}
}
process.on("uncaughtException", (e) => logLine("uncaught: " + (e.stack || e)));
process.on("unhandledRejection", (e) => logLine("unhandled rejection: " + (e?.stack || e)));

// Drop stale cache entries now and then.
setInterval(() => { const now = Date.now(); for (const [k, v] of cache) if (now - v.at > CACHE_MS * 5) cache.delete(k); }, CACHE_MS).unref();

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { console.log("already running on port " + PORT); process.exit(0); }
  console.error(e); process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => { console.log("Torrent Stats helper on http://127.0.0.1:" + PORT); logLine(`started (pid ${process.pid})`); });
