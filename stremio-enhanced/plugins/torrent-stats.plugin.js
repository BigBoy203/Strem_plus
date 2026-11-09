/**
 * @name TorrentStats
 * @description Live torrent stats in a player bubble styled like Stremio's own menus: seeders, leechers and completed counts from every tracker, speeds, peers and stream info, on four pages. Open it from the chart button in the player or with Ctrl+I. OPTIONAL: the companion Stremio helper (Node.js 18+, port 48760) for full seeder/leecher counts from UDP and http trackers; without it only the few https trackers are counted.
 * @updateUrl https://raw.githubusercontent.com/BigBoy203/Strem_plus/main/stremio-enhanced/plugins/torrent-stats.plugin.js
 * @source https://github.com/BigBoy203/Strem_plus
 * @version 2.0.0
 * @author kingkiller6203
 */

(() => {
  "use strict";

  // Seeder/leecher counts for UDP and plain-http trackers come from the local Torrent Stats helper
  // (helper/ in the Strem+ repo), because this https page can only reach https trackers.
  const HELPER = "http://127.0.0.1:48760";
  const DEFAULT_ENGINE = "http://127.0.0.1:11470";
  const ID = "tstats";
  const HISTORY = 60;          // speed graph samples (1 per second while open)
  const SCRAPE_EVERY = 60_000; // ms between tracker checks
  const PAGES = ["Overview", "Trackers", "Peers", "Info"];

  const state = {
    open: false, page: 0, route: "",
    stream: null, engine: DEFAULT_ENGINE,
    stats: null, statsAt: 0, statsError: null,
    scrape: null, scraping: false,
    history: [], timer: null,
  };

  // ------------------------------------------------------------------ formatting
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => (n == null || isNaN(n) ? "—" : Number(n).toLocaleString());
  const bytes = (b) => {
    if (b == null || isNaN(b)) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; b = Number(b);
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i ? b.toFixed(b >= 100 ? 0 : b >= 10 ? 1 : 2) : b.toFixed(0)) + " " + u[i];
  };
  const speed = (b) => (b == null ? "—" : bytes(b) + "/s");
  const dur = (s) => {
    if (s == null || !isFinite(s) || s < 0) return "—";
    s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
  };
  const host = (url) => { try { return new URL(url).hostname; } catch (_) { return url; } };
  const onPlayer = () => location.hash.startsWith("#/player/");

  async function fetchJSON(url, ms) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
    try { const r = await fetch(url, { signal: ctl.signal, cache: "no-store" }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
    finally { clearTimeout(t); }
  }

  // ------------------------------------------------------------------ data
  // The player route carries the stream as zlib-compressed base64 JSON: #/player/<stream>/...
  async function decodeStream() {
    try {
      const bin = Uint8Array.from(atob(decodeURIComponent(location.hash.split("/")[2] || "")), (c) => c.charCodeAt(0));
      return JSON.parse(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("deflate"))).text());
    } catch (_) { return null; }
  }

  async function refreshIdentity() {
    state.stream = await decodeStream();
    const m = document.querySelector("video")?.currentSrc?.match(/^(https?:\/\/[^/]+)\/([0-9a-f]{40})\/(\d+)/i);
    if (m) {
      state.engine = m[1];
      if (!state.stream?.infoHash) state.stream = { ...(state.stream || {}), infoHash: m[2].toLowerCase(), fileIdx: Number(m[3]) };
    }
  }

  function addonInfo() {
    const s = state.stream; if (!s) return {};
    const d = s.description || s.title || "";
    return {
      source: (s.name || "").replace(/\n/g, " · "),
      seeders: d.match(/👤\s*([\d,]+)/)?.[1]?.replace(/,/g, ""),
      size: d.match(/💾\s*([\d.]+\s*[KMGT]?B)/i)?.[1],
      provider: d.match(/⚙️\s*([^\n]+)/)?.[1]?.trim(),
    };
  }

  async function pollStats() {
    const s = state.stream;
    if (!s?.infoHash) { state.stats = null; state.statsError = "not-torrent"; return; }
    try {
      const prev = state.stats, prevAt = state.statsAt;
      const st = await fetchJSON(`${state.engine}/${s.infoHash}${s.fileIdx != null ? "/" + s.fileIdx : ""}/stats.json`, 4000);
      const now = performance.now();
      // The engine's uploadSpeed just mirrors downloadSpeed; work it out from total uploaded instead.
      st.upSpeed = prev && prev.infoHash === st.infoHash && st.uploaded >= prev.uploaded
        ? (st.uploaded - prev.uploaded) / ((now - prevAt) / 1000) : prev?.upSpeed ?? 0;
      state.stats = st; state.statsAt = now; state.statsError = null;
      state.history.push(st.downloadSpeed || 0);
      if (state.history.length > HISTORY) state.history.shift();
    } catch (e) { state.statsError = e.message; }
  }

  function trackerList() {
    const set = new Set();
    for (const src of state.stats?.opts?.peerSearch?.sources || []) if (src.startsWith("tracker:")) set.add(src.slice(8));
    for (const a of state.stream?.announce || []) { const u = a.replace(/^tracker:/, ""); if (/^(udp|https?):\/\//i.test(u)) set.add(u); }
    return [...set];
  }

  // Minimal bencode reader for the https-only fallback when the helper isn't running.
  function bdecode(buf) {
    let i = 0; const td = new TextDecoder("latin1");
    const next = () => {
      const c = buf[i];
      if (c === 105) { const e = buf.indexOf(101, i); const n = Number(td.decode(buf.subarray(i + 1, e))); i = e + 1; return n; }
      if (c === 108) { i++; const a = []; while (buf[i] !== 101) a.push(next()); i++; return a; }
      if (c === 100) { i++; const o = {}; while (buf[i] !== 101) { const k = td.decode(next()); o[k] = next(); } i++; return o; }
      const colon = buf.indexOf(58, i); const len = Number(td.decode(buf.subarray(i, colon)));
      const s = buf.subarray(colon + 1, colon + 1 + len); i = colon + 1 + len; return s;
    };
    return next();
  }

  async function httpsScrape(url, hash) {
    try {
      const u = new URL(url); const parts = u.pathname.split("/"); const last = parts.pop();
      if (!last.startsWith("announce")) throw new Error("no scrape URL");
      u.pathname = [...parts, "scrape" + last.slice(8)].join("/");
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(u + (u.search ? "&" : "?") + "info_hash=" + hash.match(/../g).map((b) => "%" + b).join(""), { signal: ctl.signal });
      clearTimeout(tm);
      const f = Object.values(bdecode(new Uint8Array(await r.arrayBuffer())).files || {})[0];
      if (!f) throw new Error("not on tracker");
      return { url, ok: true, seeders: f.complete, leechers: f.incomplete, completed: f.downloaded };
    } catch (e) { return { url, ok: false, error: e.message }; }
  }

  async function scrape() {
    const hash = state.stream?.infoHash;
    if (!hash || state.scraping) return;
    if (state.scrape?.hash === hash && Date.now() - state.scrape.at < SCRAPE_EVERY) return;
    const trackers = trackerList();
    if (!trackers.length) return;
    state.scraping = true;
    try {
      const r = await fetchJSON(`${HELPER}/scrape?hash=${hash}&` + trackers.map((t) => "tr=" + encodeURIComponent(t)).join("&"), 20000);
      state.scrape = { at: Date.now(), hash, helper: true, trackers: r.trackers };
    } catch (_) {
      const res = await Promise.all(trackers.filter((t) => t.startsWith("https://")).map((t) => httpsScrape(t, hash)));
      state.scrape = { at: Date.now(), hash, helper: false, trackers: res, total: trackers.length };
    } finally { state.scraping = false; update(); }
  }

  function swarm() {
    const ok = (state.scrape?.trackers || []).filter((t) => t.ok);
    const best = ok.reduce((a, t) => (!a || t.seeders > a.seeders ? t : a), null);
    const addon = addonInfo().seeders;
    return {
      ok, best,
      seeders: best?.seeders ?? (addon != null ? Number(addon) : null),
      leechers: best?.leechers ?? null,
      completed: ok.length ? Math.max(...ok.map((t) => t.completed || 0)) : null,
    };
  }

  function health(s) {
    if (s == null) return ["Checking…", "rgba(255,255,255,.5)"];
    if (s >= 100) return ["Excellent", "#4ade80"];
    if (s >= 25) return ["Good", "#a3e635"];
    if (s >= 5) return ["Fair", "#facc15"];
    return s > 0 ? ["Poor", "#fb923c"] : ["Dead", "#f87171"];
  }

  // ------------------------------------------------------------------ UI
  // Matches Stremio's own player menus (e.g. the built-in Statistics bubble).
  function injectCSS() {
    if (document.getElementById(ID + "-style")) return;
    const s = document.createElement("style"); s.id = ID + "-style";
    s.textContent = `
#${ID}-bubble{position:fixed;right:64px;bottom:120px;width:480px;max-width:calc(100vw - 32px);z-index:1000;
  background:#000;border-radius:12px;padding:24px;display:flex;flex-direction:column;gap:20px;
  color:rgba(255,255,255,.9);font-family:PlusJakartaSans,Arial,Helvetica,sans-serif;font-size:16px;
  box-shadow:0 21.6px 43.2px rgba(0,0,0,.4),0 17.6px 13.6px rgba(0,0,0,.2);backdrop-filter:blur(15px);
  animation:${ID}In .15s ease-out}
@keyframes ${ID}In{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
#${ID}-bubble *{box-sizing:border-box}
.ts-tabs{display:flex;gap:18px;align-items:baseline}
.ts-tab{font-weight:700;opacity:.4;cursor:pointer;user-select:none;transition:opacity .15s}
.ts-tab:hover{opacity:.7}
.ts-tab.on{opacity:1}
.ts-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px 24px}
.ts-l{opacity:.5;font-weight:500;font-size:14px;white-space:nowrap}
.ts-v{font-weight:600;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.ts-seed{color:#4ade80}.ts-leech{color:#f87171}
.ts-bar{height:4px;border-radius:2px;background:rgba(255,255,255,.12);overflow:hidden}
.ts-bar i{display:block;height:100%;background:rgba(255,255,255,.85);transition:width .4s}
.ts-row{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:14px}
.ts-row .ts-l{font-size:14px}
.ts-graph{width:100%;height:56px;display:block}
.ts-list{display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;font-size:14px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent}
.ts-li{display:grid;grid-template-columns:1fr 64px 64px;gap:8px;font-variant-numeric:tabular-nums;flex-shrink:0}
.ts-li span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ts-li span{text-align:right}.ts-li span:first-child{text-align:left}
.ts-li.head{opacity:.5;font-weight:500}
.ts-li.dim{opacity:.35}
.ts-note{font-size:13px;opacity:.5}
.ts-hash{font-size:13px;opacity:.8;word-break:break-all;cursor:pointer}
.ts-hash:hover{opacity:1}
#${ID}-btn svg{fill:currentColor}
`;
    document.head.appendChild(s);
  }

  const stat = (label, field, cls = "") => `<div><div class="ts-l">${label}</div><div class="ts-v ${cls}" data-f="${field}">—</div></div>`;
  const row = (label, field) => `<div class="ts-row"><span class="ts-l">${label}</span><span class="ts-v" data-f="${field}" style="margin:0">—</span></div>`;

  // Each page is built once when shown; update() then fills in the data-f fields every second.
  const PAGE_HTML = [
    () => `
      <div class="ts-grid">${stat("Seeders", "seeders", "ts-seed")}${stat("Leechers", "leechers", "ts-leech")}${stat("Health", "health")}
        ${stat("Download", "down")}${stat("Upload", "up")}${stat("Peers", "peers")}</div>
      <canvas class="ts-graph"></canvas>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div class="ts-row"><span class="ts-l">File downloaded</span><span class="ts-v" data-f="progress" style="margin:0">—</span></div>
        <div class="ts-bar"><i data-f="bar" style="width:0"></i></div>
      </div>
      <div class="ts-note" data-f="note"></div>`,
    () => `
      <div class="ts-grid">${stat("Best seeders", "seeders", "ts-seed")}${stat("Leechers", "leechers", "ts-leech")}${stat("Completed", "completed")}</div>
      <div class="ts-list" data-f="trackers"></div>
      <div class="ts-note" data-f="tnote"></div>`,
    () => `
      <div class="ts-grid">${stat("Connected", "peers")}${stat("Sending to you", "unchoked")}${stat("Known in swarm", "known")}</div>
      <div class="ts-list" data-f="wires"></div>`,
    () => `
      <div><div class="ts-v" data-f="name" style="white-space:normal;margin:0"></div><div class="ts-note" data-f="file" style="margin-top:4px;word-break:break-all"></div></div>
      <div style="display:flex;flex-direction:column;gap:8px">${row("Source", "source")}${row("Provider", "provider")}${row("File size", "size")}
        ${row("Resolution", "res")}${row("Buffered ahead", "ahead")}${row("Dropped frames", "dropped")}${row("Downloaded / uploaded", "totals")}</div>
      <div><div class="ts-l">Info hash · click to copy</div><div class="ts-hash" data-f="hash" data-act="copy"></div></div>`,
  ];

  function showPage(i) {
    const b = document.getElementById(ID + "-bubble"); if (!b) return;
    state.page = i;
    b.querySelectorAll(".ts-tab").forEach((t, n) => t.classList.toggle("on", n === i));
    b.querySelector(".ts-page").innerHTML = PAGE_HTML[i]();
    update();
  }

  function set(b, field, html, isHTML) {
    b.querySelectorAll(`[data-f="${field}"]`).forEach((el) => { if (isHTML) { if (el.innerHTML !== html) el.innerHTML = html; } else if (el.textContent !== html) el.textContent = html; });
  }

  function update() {
    const b = document.getElementById(ID + "-bubble"); if (!b) return;
    const st = state.stats, sw = swarm(), info = addonInfo(), v = document.querySelector("video");

    if (state.statsError === "not-torrent") {
      b.querySelector(".ts-page").innerHTML = `<div class="ts-note" style="font-size:15px">This stream isn't a torrent (it's a direct link), so there's no swarm to show.</div>`;
      return;
    }
    const [hl, hc] = health(sw.seeders);
    set(b, "seeders", num(sw.seeders));
    set(b, "leechers", num(sw.leechers));
    set(b, "completed", num(sw.completed));
    set(b, "health", `<span style="color:${hc}">${hl}</span>`, true);
    set(b, "down", speed(st?.downloadSpeed));
    set(b, "up", speed(st?.upSpeed));
    set(b, "peers", num(st?.peers));
    set(b, "unchoked", num(st?.unchoked));
    set(b, "known", num(st?.swarmSize));
    const p = st?.streamProgress;
    const left = st && p != null ? st.streamLen * (1 - p) : null;
    const eta = p >= 0.999 ? "done" : left && st.downloadSpeed > 0 ? dur(left / st.downloadSpeed) + " left" : "";
    set(b, "progress", p != null ? `${(p * 100).toFixed(1)}% of ${bytes(st.streamLen)}${eta ? " · " + eta : ""}` : "—");
    b.querySelectorAll('[data-f="bar"]').forEach((el) => (el.style.width = ((p || 0) * 100).toFixed(1) + "%"));

    let note = "";
    if (state.statsError) note = "Can't reach the streaming server.";
    else if (state.scrape && !state.scrape.helper) note = "The Strem+ helper isn't running, so seeders/leechers are partial (only https trackers). See the Strem+ README to set it up.";
    else if (!state.scrape) note = "Asking trackers…";
    else if (sw.best) note = `Swarm numbers from ${host(sw.best.url)}, the tracker seeing the most seeders.`;
    set(b, "note", note);

    // Trackers page
    if (state.page === 1) {
      const rows = (state.scrape?.trackers || []).slice().sort((a, b2) => (b2.ok ? b2.seeders : -1) - (a.ok ? a.seeders : -1));
      set(b, "trackers", `<div class="ts-li head"><span>Tracker</span><span>Seed</span><span>Leech</span></div>` + (rows.length
        ? rows.map((t) => `<div class="ts-li${t.ok ? "" : " dim"}" title="${esc(t.url)}${t.error ? " — " + esc(t.error) : ""}"><span>${esc(host(t.url))}</span><span class="${t.ok ? "ts-seed" : ""}">${t.ok ? num(t.seeders) : "—"}</span><span class="${t.ok ? "ts-leech" : ""}">${t.ok ? num(t.leechers) : "—"}</span></div>`).join("")
        : `<div class="ts-note">${state.scraping ? "Asking trackers…" : "No trackers yet."}</div>`), true);
      const sc = state.scrape;
      set(b, "tnote", sc ? `${sw.ok.length} of ${sc.total || sc.trackers.length} trackers answered · rechecks every minute${sc.helper ? "" : " · helper off, https trackers only"}` : "");
    }

    // Peers page
    if (state.page === 2) {
      const wires = [...(st?.wires || [])].sort((a, c) => c.downSpeed - a.downSpeed);
      set(b, "wires", wires.length
        ? `<div class="ts-li head"><span>Downloading from</span><span>Type</span><span>Speed</span></div>` +
          wires.map((w) => `<div class="ts-li"><span>${esc(w.address)}</span><span class="${w.isSeeder ? "ts-seed" : ""}">${w.isSeeder ? "Seed" : "Peer"}</span><span>${speed(w.downSpeed)}</span></div>`).join("")
        : `<div class="ts-note">${p >= 0.999 ? "This file is fully downloaded, so no peers are needed right now." : "Stremio isn't pulling data from a specific peer this second. The list fills in while it downloads."}</div>`, true);
    }

    // Info page
    if (state.page === 3) {
      set(b, "name", st?.name || "—");
      set(b, "file", st?.streamName || "");
      set(b, "source", info.source || "—");
      set(b, "provider", info.provider || "—");
      set(b, "size", st?.streamLen ? bytes(st.streamLen) : info.size || "—");
      set(b, "res", v?.videoWidth ? `${v.videoWidth} × ${v.videoHeight}` : "—");
      let ahead = 0;
      if (v) for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) > v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
      set(b, "ahead", v ? dur(ahead) : "—");
      const q = v?.getVideoPlaybackQuality?.();
      set(b, "dropped", q ? `${num(q.droppedVideoFrames)} of ${num(q.totalVideoFrames)}` : "—");
      set(b, "totals", st ? `${bytes(st.downloaded)} / ${bytes(st.uploaded)}` : "—");
      const hash = state.stream?.infoHash || "—";
      const hashEl = b.querySelector('[data-f="hash"]');
      if (hashEl && !hashEl.dataset.copied) set(b, "hash", hash);
    }

    drawGraph(b.querySelector(".ts-graph"));
  }

  function drawGraph(c) {
    if (!c) return;
    const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const d = state.history; if (d.length < 2) return;
    const max = Math.max(1, ...d);
    const x = (i) => w - (d.length - 1 - i) * (w / (HISTORY - 1));
    const y = (val) => h - 2 - (val / max) * (h - 6);
    g.beginPath(); d.forEach((val, i) => (i ? g.lineTo(x(i), y(val)) : g.moveTo(x(i), y(val))));
    g.strokeStyle = "rgba(255,255,255,.85)"; g.lineWidth = 1.5; g.lineJoin = "round"; g.stroke();
    g.lineTo(x(d.length - 1), h); g.lineTo(x(0), h); g.closePath(); g.fillStyle = "rgba(255,255,255,.08)"; g.fill();
    g.fillStyle = "rgba(255,255,255,.4)"; g.font = "11px PlusJakartaSans,Arial"; g.fillText("peak " + speed(max), 0, 11);
  }

  function open() {
    if (document.getElementById(ID + "-bubble")) return;
    injectCSS();
    const b = document.createElement("div");
    b.id = ID + "-bubble";
    b.innerHTML = `<div class="ts-tabs">${PAGES.map((p, i) => `<div class="ts-tab" data-page="${i}">${p}</div>`).join("")}</div><div class="ts-page" style="display:flex;flex-direction:column;gap:20px"></div>`;
    for (const ev of ["click", "dblclick", "mousedown", "mouseup", "wheel", "pointerdown"]) b.addEventListener(ev, (e) => e.stopPropagation());
    b.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-page]");
      if (tab) return showPage(Number(tab.dataset.page));
      if (e.target.closest('[data-act="copy"]') && state.stream?.infoHash) {
        navigator.clipboard?.writeText(state.stream.infoHash);
        const el = e.target.closest('[data-act="copy"]'); el.dataset.copied = "1"; el.textContent = "Copied";
        setTimeout(() => { delete el.dataset.copied; update(); }, 1200);
      }
    });
    document.body.appendChild(b);
    state.open = true;
    showPage(state.page);
    restartTimer();
    refreshIdentity().then(pollStats).then(() => { update(); scrape(); });
  }

  function close() {
    document.getElementById(ID + "-bubble")?.remove();
    state.open = false;
    restartTimer();
  }
  const toggle = () => (state.open ? close() : open());

  // Live: every second while open. Every 3 s in the background so the graph has history when opened.
  function restartTimer() {
    clearInterval(state.timer);
    if (!onPlayer()) return;
    state.timer = setInterval(async () => { await pollStats(); if (state.open) { update(); scrape(); } }, state.open ? 1000 : 3000);
  }

  // Close like Stremio's menus do: click anywhere else, or when one of Stremio's own menus opens.
  document.addEventListener("pointerdown", (e) => {
    if (state.open && !e.target.closest(`#${ID}-bubble, #${ID}-btn`)) close();
  }, true);

  // ------------------------------------------------------------------ player button
  const ICON = `<svg viewBox="0 0 512 512"><path d="M72 432h368a24 24 0 0 1 0 48H72a40 40 0 0 1-40-40V72a24 24 0 0 1 48 0zm56-64V248a24 24 0 0 1 48 0v120a24 24 0 0 1-48 0zm96 0V152a24 24 0 0 1 48 0v216a24 24 0 0 1-48 0zm96 0V216a24 24 0 0 1 48 0v152a24 24 0 0 1-48 0zm96 0V104a24 24 0 0 1 48 0v264a24 24 0 0 1-48 0z"/></svg>`;

  function ensureButton() {
    if (!onPlayer() || document.getElementById(ID + "-btn")) return;
    const menu = document.querySelector('[class*="control-bar-buttons-menu-container-"]');
    const sibling = menu?.querySelector('[class*="control-bar-button-"]:not([id])');
    if (!sibling) return;
    const btn = document.createElement("div");
    btn.id = ID + "-btn"; btn.tabIndex = -1; btn.title = "Torrent stats (Ctrl+I)";
    btn.className = sibling.className.replace(/\bdisabled\b/, "");
    btn.innerHTML = ICON;
    const svgClass = sibling.querySelector("svg")?.getAttribute("class");
    if (svgClass) btn.querySelector("svg").setAttribute("class", svgClass);
    btn.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    menu.insertBefore(btn, menu.firstChild);
  }

  window.addEventListener("keydown", (e) => {
    if (!onPlayer() || !e.ctrlKey || e.altKey || e.metaKey || e.code !== "KeyI") return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) return;
    e.preventDefault(); e.stopPropagation(); toggle();
  }, true);

  // ------------------------------------------------------------------ route tracking
  setInterval(() => {
    if (state.open && document.querySelector('[class*="menu-layer-"]')) close(); // a Stremio menu opened
    if (location.hash !== state.route) {
      const was = state.route.startsWith("#/player/");
      state.route = location.hash;
      if (was || onPlayer()) {
        state.history = []; state.stats = null; state.scrape = null; state.statsError = null;
        if (!onPlayer()) close();
        refreshIdentity().then(() => { restartTimer(); if (state.open) pollStats().then(() => { update(); scrape(); }); });
      }
    }
    ensureButton();
  }, 500);
})();
