/**
 * @name DownloadAhead
 * @description Download episodes ahead of time so they play from your disk with no buffering: download buttons on episodes and streams, a Downloads page in the sidebar, a disk-or-torrent prompt, Keep and Delete-after-watching. REQUIRES the companion Stremio helper (needs Node.js 18+) running on this PC on port 48760, see the GitHub README for setup. Without the helper, downloads and playing from disk will not work.
 * @updateUrl https://raw.githubusercontent.com/BigBoy203/Strem_plus/main/stremio-enhanced/plugins/download-ahead.plugin.js
 * @source https://github.com/BigBoy203/Strem_plus
 * @version 1.1.1
 * @author kingkiller6203
 */

(() => {
  "use strict";

  // The downloading, file serving and deleting happen in the local helper
  // (helper/downloads.mjs in the Strem+ repo). This plugin is the UI, and tells the
  // helper when an episode has been watched.
  const HELPER = "http://127.0.0.1:48760";
  const ADDON_URL = HELPER + "/addon/manifest.json";
  const ID = "dlahead";
  const WATCHED_AT = 0.9; // fraction of the episode that counts as watched

  const state = {
    open: false,
    route: "", player: null,     // parsed player route
    next: null, nextErr: "",     // { video, streams, pick, show }
    dl: null, helperDown: false, // helper /dl/state
    watchedSent: new Set(),
    toastFor: "", toastDismissed: new Set(),
  };

  // ------------------------------------------------------------------ helpers
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const bytes = (b) => {
    if (!b) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return b.toFixed(i >= 3 ? 2 : i ? 1 : 0) + " " + u[i];
  };
  const onPlayer = () => location.hash.startsWith("#/player/");
  const epLabel = (v) => (v?.season != null && v?.episode != null ? `S${v.season}E${v.episode}` : "");

  async function api(path, body) {
    const r = await fetch(HELPER + path, body === undefined ? { cache: "no-store" } : {
      // text/plain keeps this a "simple" request (no CORS preflight); the helper parses it as JSON.
      method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    return j;
  }

  // #/player/<stream>/<streamAddon>/<metaAddon>/<type>/<metaId>/<videoId>
  async function parsePlayer() {
    const parts = location.hash.split("/");
    if (parts[1] !== "player") return null;
    let stream = null;
    try {
      const bin = Uint8Array.from(atob(decodeURIComponent(parts[2])), (c) => c.charCodeAt(0));
      stream = JSON.parse(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("deflate"))).text());
    } catch (_) {}
    const dec = (s) => { try { return decodeURIComponent(s || ""); } catch (_) { return ""; } };
    return {
      parts, stream,
      streamAddon: dec(parts[3]), metaAddon: dec(parts[4]),
      type: dec(parts[5]), metaId: dec(parts[6]), videoId: dec(parts[7]),
    };
  }

  async function encodeStream(stream) {
    const data = new TextEncoder().encode(JSON.stringify(stream));
    const buf = await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer();
    let s = ""; new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b)));
    return btoa(s);
  }

  const resource = (addonUrl, res, type, id) => addonUrl.replace(/\/manifest\.json$/, `/${res}/${type}/${encodeURIComponent(id)}.json`);

  function streamInfo(s) {
    const d = s.description || s.title || "";
    const lines = d.split("\n").map((l) => l.trim()).filter(Boolean);
    const sz = d.match(/💾\s*([\d.]+)\s*(KB|MB|GB|TB)/i);
    return {
      release: lines.find((l) => !/^(👤|💾|⚙)/u.test(l)) || "",
      quality: (s.name || "").split("\n").slice(1).join(" ").trim(),
      seeders: d.match(/👤\s*([\d,]+)/)?.[1],
      size: sz ? Number(sz[1]) * 1024 ** { KB: 1, MB: 2, GB: 3, TB: 4 }[sz[2].toUpperCase()] : 0,
    };
  }

  // Finds the next episode and, like Stremio's autoplay, the same release for it (same bingeGroup,
  // or the same torrent).
  async function findNext() {
    const p = state.player;
    state.next = null; state.nextErr = "";
    if (!p || p.type !== "series" || !p.metaAddon || !p.streamAddon) { state.nextErr = p?.type === "movie" ? "movie" : "Can't tell what's playing."; return; }
    try {
      const meta = (await (await fetch(resource(p.metaAddon, "meta", p.type, p.metaId))).json()).meta;
      const vids = (meta.videos || []).filter((v) => v.season != null && v.episode != null)
        .sort((a, b) => (a.season || 1e9) - (b.season || 1e9) || a.episode - b.episode);
      const i = vids.findIndex((v) => v.id === p.videoId);
      const video = i >= 0 ? vids.slice(i + 1).find((v) => v.season !== 0 || vids[i].season === 0) : null;
      if (!video) { state.nextErr = "This is the last episode."; return; }
      const streams = (await (await fetch(resource(p.streamAddon, "stream", p.type, video.id))).json()).streams || [];
      const cur = p.stream || {};
      const pick = streams.find((s) => cur.behaviorHints?.bingeGroup && s.behaviorHints?.bingeGroup === cur.behaviorHints.bingeGroup)
        || streams.find((s) => cur.infoHash && s.infoHash === cur.infoHash)
        || null;
      state.next = { video, streams, pick, show: meta.name || "" };
    } catch (e) { state.nextErr = "Couldn't look up the next episode."; }
  }

  async function refreshDownloads() {
    try { state.dl = await api("/dl/state"); state.helperDown = false; }
    catch (_) { state.helperDown = true; }
  }

  const itemFor = (videoId) => (state.dl?.items || []).find((it) => it.videoId === videoId);

  async function startDownload(stream) {
    const n = state.next, p = state.player;
    if (!n || !stream) return;
    try {
      if (!state.dl?.folder) {
        if (!(await chooseFolder())) return;
      }
      const info = streamInfo(stream);
      await api("/dl/add", {
        infoHash: stream.infoHash, fileIdx: stream.fileIdx, url: stream.url,
        videoId: n.video.id, metaId: p.metaId, type: p.type,
        show: n.show, title: `${n.show} ${epLabel(n.video)}${n.video.name || n.video.title ? " · " + (n.video.name || n.video.title) : ""}`,
        filename: stream.behaviorHints?.filename || "", release: info.release, quality: info.quality, size: info.size,
      });
    } catch (e) { alertMsg(e.message); }
    await refreshDownloads(); render();
  }

  function alertMsg(m) {
    const b = document.getElementById(ID + "-bubble");
    const el = b?.querySelector(".da-err");
    if (el) { el.textContent = m; el.style.display = "block"; }
  }

  // ------------------------------------------------------------------ UI
  function injectCSS() {
    if (document.getElementById(ID + "-style")) return;
    const s = document.createElement("style"); s.id = ID + "-style";
    s.textContent = `
#${ID}-bubble{position:fixed;right:64px;bottom:120px;width:480px;max-width:calc(100vw - 32px);max-height:calc(100vh - 180px);overflow-y:auto;z-index:1000;
  background:#000;border-radius:12px;padding:24px;display:flex;flex-direction:column;gap:18px;color:rgba(255,255,255,.9);
  font-family:PlusJakartaSans,Arial,Helvetica,sans-serif;font-size:16px;box-shadow:0 21.6px 43.2px rgba(0,0,0,.4),0 17.6px 13.6px rgba(0,0,0,.2);
  animation:${ID}In .15s ease-out;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent}
@keyframes ${ID}In{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
#${ID}-bubble *{box-sizing:border-box}
.da-title{font-weight:700}
.da-h{font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;opacity:.45;margin-bottom:8px}
.da-row{display:flex;align-items:center;gap:12px}
.da-main{flex:1;min-width:0}
.da-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.da-sub{font-size:13px;opacity:.5;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.da-btn{background:rgba(255,255,255,.92);color:#000;border:none;border-radius:20px;padding:8px 16px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap}
.da-btn:hover{background:#fff}
.da-btn.ghost{background:rgba(255,255,255,.1);color:rgba(255,255,255,.9)}
.da-btn.ghost:hover{background:rgba(255,255,255,.18)}
.da-x{background:none;border:none;color:rgba(255,255,255,.4);font-size:18px;cursor:pointer;padding:2px 6px}
.da-x:hover{color:#fff}
.da-bar{height:4px;border-radius:2px;background:rgba(255,255,255,.12);overflow:hidden;margin-top:8px}
.da-bar i{display:block;height:100%;background:rgba(255,255,255,.85);transition:width .5s}
.da-ok{color:#4ade80}
.da-list{display:flex;flex-direction:column;gap:14px}
.da-alt{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.da-foot{font-size:13px;opacity:.55;display:flex;flex-direction:column;gap:6px}
.da-foot a{color:inherit;text-decoration:underline;cursor:pointer}
.da-err{display:none;font-size:13px;color:#f87171}
#${ID}-btn svg{fill:currentColor}
.da-ep{position:absolute;right:10px;top:50%;transform:translateY(-50%);z-index:2;display:flex;align-items:center;gap:4px;
  height:32px;min-width:32px;padding:0 8px;border-radius:16px;background:rgba(0,0,0,.55);color:rgba(255,255,255,.85);cursor:pointer;
  opacity:0;transition:opacity .15s,background .15s}
${ROW}:hover > .da-ep,.da-ep.has{opacity:1}
.da-ep:hover{background:rgba(255,255,255,.9);color:#000}
.da-ep svg{width:16px;height:16px;fill:currentColor}
.da-ep b{font-size:12px;font-weight:700}
.da-sbtn{position:absolute;right:56px;top:50%;transform:translateY(-50%);z-index:3;display:flex;align-items:center;justify-content:center;gap:4px;
  height:30px;min-width:30px;padding:0 8px;border-radius:15px;background:rgba(255,255,255,.08);color:rgba(255,255,255,.75);cursor:pointer;
  font-size:13px;font-weight:700;transition:background .15s,color .15s}
.da-sbtn.card{right:12px;top:auto;bottom:10px;transform:none}
a:has(> .da-sbtn) > [class*="description-container-"]{padding-right:44px}
.da-sbtn:hover{background:rgba(255,255,255,.9);color:#000}
.da-sbtn svg{width:15px;height:15px;fill:currentColor}
.da-sbtn b{font-size:11px}
.da-sbtn.done{background:rgba(74,222,128,.16);color:#4ade80}
.da-sbtn.busy{background:rgba(123,91,245,.25);color:#c4b5fd}
#${ID}-page{position:fixed;inset:0;z-index:1002;background:#0c0b18;color:rgba(255,255,255,.9);font-family:PlusJakartaSans,Arial,sans-serif;display:flex;flex-direction:column;animation:${ID}In .15s ease-out}
#${ID}-page *{box-sizing:border-box}
.dp-top{display:flex;align-items:center;gap:14px;padding:22px 32px 14px}
.dp-back{background:rgba(255,255,255,.08);border:none;color:#fff;width:40px;height:40px;border-radius:20px;font-size:20px;cursor:pointer}
.dp-back:hover{background:rgba(255,255,255,.16)}
.dp-h1{font-size:26px;font-weight:700}
.dp-body{flex:1;overflow-y:auto;padding:6px 32px 40px;max-width:1100px;width:100%;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent}
.dp-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:16px 18px;margin-bottom:12px}
.dp-folder{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.dp-fl{flex:1;min-width:240px}
.dp-lbl{font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;opacity:.45}
.dp-path{font-size:16px;font-weight:600;margin:4px 0;word-break:break-all}
.dp-actions{display:flex;gap:8px;flex-wrap:wrap}
.dp-meta{font-size:13px;opacity:.55}
.dp-sec{font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;opacity:.5;margin:26px 2px 10px}
.dp-dl{display:flex;align-items:center;gap:16px}
.dp-main{flex:1;min-width:0}
.dp-title{font-weight:600;font-size:15px}
.dp-rel{font-size:13px;opacity:.5;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dp-poster{width:44px;height:64px;border-radius:6px;background:rgba(255,255,255,.06) center/cover no-repeat;flex-shrink:0}
.dp-poster.big{width:58px;height:86px}
.dp-show-h{display:flex;align-items:center;gap:16px;margin-bottom:6px}
.dp-show-name{font-size:18px;font-weight:700}
.dp-season{font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;opacity:.45;margin:14px 0 4px}
.dp-ep{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid rgba(255,255,255,.05)}
.dp-ep-t{font-weight:600}
.dp-sm{padding:8px 10px}
.dp-empty{text-align:center;padding:40px 18px;font-size:16px;line-height:1.7}
.dp-foot{font-size:12.5px;opacity:.4;margin-top:22px}
.dp-toggle-row{flex-basis:100%;display:flex;align-items:center;gap:14px;padding-top:14px;margin-top:2px;border-top:1px solid rgba(255,255,255,.06);cursor:pointer;user-select:none}
.dp-switch{width:44px;height:24px;border-radius:12px;background:rgba(255,255,255,.18);position:relative;flex-shrink:0;transition:background .15s}
.dp-switch i{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s}
.dp-switch.on{background:#7b5bf5}
.dp-switch.on i{left:23px}
.dp-keep.on{background:rgba(123,91,245,.25);color:#c4b5fd}
.dp-tag{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:6px;font-size:11px;font-weight:700;background:rgba(74,222,128,.14);color:#4ade80;vertical-align:middle}
#${ID}-ask{position:fixed;inset:0;z-index:1003;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;
  font-family:PlusJakartaSans,Arial,sans-serif;color:rgba(255,255,255,.9)}
#${ID}-ask *{box-sizing:border-box}
.ask-box{width:min(460px,92vw)}
.ask-btns{display:flex;flex-direction:column;gap:10px;margin-top:6px}
.ask-main{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:12px 18px;border-radius:12px;font-size:15px;text-align:left}
.ask-main span{font-size:12px;font-weight:500;opacity:.6}
#${ID}-picker{position:fixed;inset:0;z-index:1003;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;
  font-family:PlusJakartaSans,Arial,sans-serif;color:rgba(255,255,255,.9)}
#${ID}-picker *{box-sizing:border-box}
.fp-box{width:min(640px,92vw);max-height:80vh;display:flex;flex-direction:column;gap:12px;background:#0f0d20;border:1px solid rgba(255,255,255,.08);
  border-radius:14px;padding:22px;box-shadow:0 24px 60px rgba(0,0,0,.6)}
.fp-h{font-size:18px;font-weight:700}
.fp-path{display:flex;align-items:center;gap:10px;font-size:14px;word-break:break-all;min-height:36px}
.fp-free{margin-left:auto;opacity:.5;white-space:nowrap}
.fp-up{padding:6px 12px}
.fp-list{flex:1;min-height:200px;overflow-y:auto;border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:6px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent}
.fp-dir{padding:9px 12px;border-radius:8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fp-dir:hover{background:rgba(255,255,255,.08)}
.fp-empty{padding:20px;text-align:center;opacity:.5;font-size:14px}
.fp-new{gap:8px}
.fp-in{flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:8px 14px;color:#fff;font:inherit;font-size:14px;outline:none}
.fp-err{color:#f87171;font-size:13px;min-height:16px}
.fp-btns{display:flex;gap:8px;align-items:center}
.da-btn:disabled{opacity:.35;cursor:default}
.da-x.sure{color:#f87171;font-size:13px;font-weight:700}
#${ID}-pick{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 12px 10px 6px;padding:12px 14px;border-radius:12px;
  background:rgba(123,91,245,.18);border:1px solid rgba(123,91,245,.45);color:#fff;font-size:14px}
#${ID}-note{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:1001;background:#000;color:rgba(255,255,255,.92);
  padding:12px 18px;border-radius:12px;font-family:PlusJakartaSans,Arial,sans-serif;font-size:14px;box-shadow:0 12px 30px rgba(0,0,0,.45);max-width:80vw}
#${ID}-toast{position:fixed;top:24px;right:24px;z-index:1000;background:#000;border-radius:12px;padding:14px 16px;display:flex;align-items:center;gap:12px;
  color:rgba(255,255,255,.9);font-family:PlusJakartaSans,Arial,sans-serif;font-size:14px;box-shadow:0 12px 30px rgba(0,0,0,.45)}
`;
    document.head.appendChild(s);
  }

  function statusLine(it) {
    const pct = it.size ? Math.floor((it.done / it.size) * 100) : 0;
    switch (it.status) {
      case "done": return `<span class="da-ok">Ready to watch</span> · ${bytes(it.size)}`;
      case "downloading": return `Downloading ${pct}% · ${bytes(it.speed)}/s · ${bytes(it.done)} of ${bytes(it.size)}`;
      case "queued": return `Queued${it.done ? " · " + pct + "%" : ""}`;
      case "waiting": return `Paused until Stremio is open${it.done ? " · " + pct + "%" : ""}`;
      case "watched": return "Watched · deleting";
      case "error": return `Retrying soon: ${esc(it.error)}`;
      default: return esc(it.status);
    }
  }

  function render() {
    const b = document.getElementById(ID + "-bubble"); if (!b) return;
    const keepScroll = b.scrollTop;
    let h = `<div class="da-title">Download ahead</div>`;

    if (state.helperDown) {
      h += `<div class="da-sub" style="white-space:normal">The Strem+ helper isn't running. Run <b>install-startup.ps1</b> in <b>%APPDATA%\\stremio-enhanced\\strem-plus-helper</b> (right-click it, Run with PowerShell). Steps: github.com/BigBoy203/Strem_plus</div>`;
      b.innerHTML = h; return;
    }

    // Next episode
    h += `<div><div class="da-h">Next episode</div>`;
    const n = state.next;
    if (!n && !state.nextErr) h += `<div class="da-sub">Looking it up…</div>`;
    else if (state.nextErr === "movie") h += `<div class="da-sub">This is a movie, so there's no next episode.</div>`;
    else if (state.nextErr) h += `<div class="da-sub">${esc(state.nextErr)}</div>`;
    else {
      const it = itemFor(n.video.id);
      const name = `${epLabel(n.video)}${n.video.name || n.video.title ? " · " + esc(n.video.name || n.video.title) : ""}`;
      const pct = it?.size ? (it.done / it.size) * 100 : 0;
      if (it) {
        h += `<div class="da-row"><div class="da-main"><div class="da-name">${name}</div><div class="da-sub">${statusLine(it)}</div>
          ${it.status !== "done" ? `<div class="da-bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ""}</div></div>`;
      } else if (n.pick) {
        const info = streamInfo(n.pick);
        h += `<div class="da-row"><div class="da-main"><div class="da-name">${name}</div>
          <div class="da-sub" title="${esc(info.release)}">Same release · ${esc(info.quality)}${info.size ? " · " + bytes(info.size) : ""}</div></div>
          <button class="da-btn" data-act="dl-next">Download</button></div>`;
      } else {
        h += `<div class="da-name">${name}</div><div class="da-sub" style="white-space:normal">The release you're watching isn't listed for this episode. Pick one:</div><div class="da-alt">` +
          n.streams.slice(0, 4).map((s, i) => { const info = streamInfo(s);
            return `<div class="da-row"><div class="da-main"><div class="da-sub" style="opacity:.85" title="${esc(info.release)}">${esc(info.quality)} · ${esc(info.release)}</div></div><button class="da-btn ghost" data-act="dl-alt" data-i="${i}">Download</button></div>`; }).join("") + `</div>`;
      }
    }
    h += `<div class="da-err"></div></div>`;

    // All downloads
    const items = state.dl?.items || [];
    if (items.length) {
      h += `<div><div class="da-h">Downloads</div><div class="da-list">` + items.map((it) => {
        const pct = it.size ? (it.done / it.size) * 100 : 0;
        return `<div class="da-row"><div class="da-main"><div class="da-name" title="${esc(it.release || it.filename)}">${esc(it.title)}</div><div class="da-sub">${statusLine(it)}</div>
          ${["downloading", "queued", "waiting", "error"].includes(it.status) ? `<div class="da-bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ""}</div>
          <button class="da-x" title="Delete this download" data-act="remove" data-key="${it.key}">✕</button></div>`;
      }).join("") + `</div></div>`;
    }

    // Folder + addon
    const installed = addonInstalled();
    h += `<div class="da-foot">
      <div><a data-act="page">Open the Downloads page</a></div>
      <div>${state.dl?.folder ? `Saves to ${esc(state.dl.folder)} · <a data-act="folder">Change</a>` : `<a data-act="folder">Choose a download folder</a>`}</div>
      <div>${installed ? "Downloaded episodes show as “📁 Downloaded” in the stream list." : `<a data-act="addon">Add “📁 Downloaded” to the stream list</a> (one-time addon install)`}</div>
      <div>${state.dl?.autoDelete !== false ? `Files are deleted after you watch ${Math.round(WATCHED_AT * 100)}% of the episode (unless kept).` : "Delete after watching is off."} Downloads only run while Stremio is open.</div></div>`;

    b.innerHTML = h;
    b.scrollTop = keepScroll;
  }

  function addonInstalled() {
    try { return (JSON.parse(localStorage.getItem("profile")).addons || []).some((a) => a.transportUrl === ADDON_URL); } catch (_) { return false; }
  }

  let bubbleTimer = null;
  function open() {
    if (document.getElementById(ID + "-bubble")) return;
    injectCSS();
    const b = document.createElement("div");
    b.id = ID + "-bubble";
    for (const ev of ["click", "dblclick", "mousedown", "mouseup", "wheel", "pointerdown"]) b.addEventListener(ev, (e) => e.stopPropagation());
    b.addEventListener("click", async (e) => {
      const el = e.target.closest("[data-act]"); if (!el) return;
      const act = el.dataset.act;
      if (act === "dl-next") { el.textContent = "Starting…"; el.disabled = true; return startDownload(state.next.pick); }
      if (act === "dl-alt") { el.textContent = "Starting…"; el.disabled = true; return startDownload(state.next.streams[Number(el.dataset.i)]); }
      if (act === "remove") { await api("/dl/remove", { key: el.dataset.key }).catch(() => {}); await refreshDownloads(); return render(); }
      if (act === "folder") { close(); await chooseFolder(); return; }
      if (act === "page") { close(); return openPage(); }
      if (act === "addon") { close(); location.hash = "#/addons?addon=" + encodeURIComponent(ADDON_URL); }
    });
    document.body.appendChild(b);
    state.open = true;
    render();
    refreshDownloads().then(render);
    if (!state.next || state.next.forVideo !== state.player?.videoId) findNext().then(() => { if (state.next) state.next.forVideo = state.player?.videoId; render(); });
    bubbleTimer = setInterval(() => refreshDownloads().then(render), 2000);
  }

  function close() {
    document.getElementById(ID + "-bubble")?.remove();
    clearInterval(bubbleTimer);
    state.open = false;
  }
  const toggle = () => (state.open ? close() : open());

  document.addEventListener("pointerdown", (e) => {
    if (state.open && !e.target.closest(`#${ID}-bubble, #${ID}-btn`)) close();
  }, true);

  // ------------------------------------------------------------------ "downloaded copy ready" toast
  function showToast() {
    if (document.getElementById(ID + "-toast")) return;
    injectCSS();
    const t = document.createElement("div");
    t.id = ID + "-toast";
    t.innerHTML = `<span>📁 You downloaded this episode</span><button class="da-btn" data-act="play">Play from disk</button><button class="da-x" data-act="dismiss" title="Keep streaming">✕</button>`;
    for (const ev of ["click", "mousedown", "pointerdown"]) t.addEventListener(ev, (e) => e.stopPropagation());
    t.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "dismiss") { state.toastDismissed.add(state.player?.videoId); t.remove(); }
      if (act === "play") playDownloaded().catch(() => t.remove());
    });
    document.body.appendChild(t);
  }

  async function playDownloaded() {
    const p = state.player; if (!p) return;
    const r = await (await fetch(resource(ADDON_URL, "stream", p.type, p.videoId))).json();
    const s = r.streams?.[0]; if (!s) return;
    const enc = encodeURIComponent(await encodeStream(s));
    location.hash = ["#", "player", enc, encodeURIComponent(ADDON_URL), ...p.parts.slice(4)].join("/");
  }

  // ------------------------------------------------------------------ episode list: download buttons
  // Each episode row gets a download button. Pressing it opens that episode's normal stream list
  // in "download mode": the next stream picked (including via StreamQualityPicker's cards) is
  // downloaded instead of played.
  const ROW = '[class*="video-container-"]';
  const isEpisodeRow = (el) => !!el.querySelector('[class*="title-container-"]');

  // The episode id ("tt0773262:6:5") from the row's React props, when we can find it.
  function rowVideoId(row) {
    const fk = Object.keys(row).find((k) => k.startsWith("__reactFiber"));
    for (let f = fk && row[fk], n = 0; f && n < 8; f = f.return, n++) {
      const p = f.memoizedProps || {};
      for (const v of [p.id, p.video?.id, p.videoId]) if (typeof v === "string" && /:\d+:\d+$/.test(v)) return v;
    }
    return null;
  }

  function decorateRows() {
    document.querySelectorAll(ROW).forEach((row) => {
      if (!isEpisodeRow(row)) return;
      let btn = row.querySelector(":scope > .da-ep");
      if (!btn) {
        injectCSS();
        if (getComputedStyle(row).position === "static") row.style.position = "relative";
        btn = document.createElement("div");
        btn.className = "da-ep";
        btn.innerHTML = ICON;
        btn.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
        btn.addEventListener("mousedown", (e) => e.stopPropagation(), true);
        btn.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          const title = row.querySelector('[class*="title-container-"]')?.textContent.trim() || "this episode";
          const it = itemFor(rowVideoId(row));
          if (it && it.status !== "watched") { showNote(`Already downloaded or downloading: ${title}`); return; }
          state.pickMode = { title, at: Date.now() };
          row.click(); // Stremio opens this episode's stream list
        });
        row.appendChild(btn);
      }
      // Show progress / done on the button.
      const it = itemFor(rowVideoId(row));
      const pct = it?.size ? Math.floor((it.done / it.size) * 100) : 0;
      const label = !it ? "" : it.status === "done" ? "✓" : it.status === "watched" ? "" : pct + "%";
      const title = !it ? "Download this episode (pick a stream)" : it.status === "done" ? "Downloaded, ready to watch" : `Downloading ${pct}%`;
      if (btn.dataset.label !== label) { btn.dataset.label = label; btn.classList.toggle("has", !!label); btn.querySelector("b")?.remove(); if (label) btn.insertAdjacentHTML("beforeend", `<b>${label}</b>`); }
      btn.title = title;
    });
  }

  // Download mode banner on the stream list, and the click interception.
  function pickVideoId() {
    const m = location.hash.match(/^#\/detail\/(series|movie)\/([^/]+)\/([^/?]+)/);
    return m ? { type: m[1], metaId: decodeURIComponent(m[2]), videoId: decodeURIComponent(m[3]) } : null;
  }

  function updatePickBanner() {
    const list = document.querySelector('[class*="streams-list-"]');
    let banner = document.getElementById(ID + "-pick");
    const active = state.pickMode && pickVideoId() && list;
    if (!active) { banner?.remove(); return; }
    if (!banner) {
      injectCSS();
      banner = document.createElement("div");
      banner.id = ID + "-pick";
      banner.innerHTML = `<span>⬇ Pick a stream to <b>download</b>: <span class="da-pick-t"></span></span><button class="da-btn ghost" data-act="cancel">Cancel</button>`;
      banner.querySelector("[data-act=cancel]").addEventListener("click", (e) => { e.stopPropagation(); state.pickMode = null; banner.remove(); });
      list.prepend(banner);
    }
    banner.querySelector(".da-pick-t").textContent = state.pickMode.title;
  }

  async function streamFromLink(a) {
    const href = a.getAttribute("href") || "";
    const parts = href.split("/");
    if (parts[1] !== "player") return null;
    try {
      const bin = Uint8Array.from(atob(decodeURIComponent(parts[2])), (c) => c.charCodeAt(0));
      return JSON.parse(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("deflate"))).text());
    } catch (_) { return null; }
  }

  // Show / episode names from Cinemeta, cached per title.
  const metaCache = new Map();
  async function metaInfo(type, metaId) {
    if (!metaCache.has(metaId)) {
      metaCache.set(metaId, fetch(`https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(metaId)}.json`)
        .then((r) => r.json()).then((j) => j.meta || {}).catch(() => ({})));
    }
    return metaCache.get(metaId);
  }

  // Queues one stream for download. Used by download mode and by the per-stream buttons.
  async function queueDownload(stream, ids) {
    if (!ids || !stream || (!stream.infoHash && !stream.url)) { showNote("That stream can't be downloaded (it's not a torrent or a direct link)."); return; }
    try {
      await refreshDownloads();
      const existing = itemForStream(ids.videoId, stream);
      if (existing && existing.status !== "watched") { showNote(existing.status === "done" ? "Already downloaded." : "Already downloading."); return; }
      if (!state.dl?.folder && !(await chooseFolder())) return showNote("No folder chosen, so nothing was downloaded.");
      const info = streamInfo(stream);
      const meta = await metaInfo(ids.type, ids.metaId);
      const video = (meta.videos || []).find((v) => v.id === ids.videoId);
      const show = meta.name || "";
      const title = ids.type === "movie" ? show || ids.metaId
        : [show, video ? `S${video.season}E${video.episode}` : "", video?.name || video?.title ? "· " + (video.name || video.title) : ""].filter(Boolean).join(" ");
      await api("/dl/add", {
        infoHash: stream.infoHash, fileIdx: stream.fileIdx, url: stream.url,
        videoId: ids.videoId, metaId: ids.metaId, type: ids.type,
        show: show || ids.metaId, title: title || ids.videoId,
        filename: stream.behaviorHints?.filename || "", release: info.release, quality: info.quality, size: info.size,
      });
      showNote(`Downloading ${title || "it"}. Track it from the download button in the player or on the episode.`);
      await refreshDownloads();
      // Back to the episode list (same season) once a download is picked. Movies have no list.
      const season = ids.type === "series" ? ids.videoId.match(/:(\d+):\d+$/)?.[1] : null;
      if (season && pickVideoId()?.videoId === ids.videoId) {
        location.hash = `#/detail/series/${encodeURIComponent(ids.metaId)}?season=${season}`;
      }
    } catch (er) { showNote("Couldn't start the download: " + er.message); }
  }

  // Download mode: the next stream clicked is downloaded instead of played.
  document.addEventListener("click", async (e) => {
    if (!state.pickMode || e.target.closest?.(".da-sbtn")) return;
    const a = e.target.closest && e.target.closest('[class*="streams-container-"] a');
    if (!a) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    state.pickMode = null; updatePickBanner();
    queueDownload(await streamFromLink(a), pickVideoId());
  }, true);

  // ------------------------------------------------------------------ "play from disk or torrent?"
  // Clicking a downloaded episode (in the episode list) or one of its streams (in the stream list)
  // asks whether to play the downloaded copy or stream it. Other episodes behave as normal.
  const readyItem = (videoId) => (state.dl?.items || []).find((i) => i.videoId === videoId && i.status === "done");

  function askPlay(it, streamLabel) {
    injectCSS();
    return new Promise((resolve) => {
      document.getElementById(ID + "-ask")?.remove();
      const m = document.createElement("div");
      m.id = ID + "-ask";
      m.innerHTML = `<div class="fp-box ask-box">
        <div class="fp-h">You downloaded this episode</div>
        <div class="dp-meta" style="font-size:14px">${esc(it.title)}${it.watched ? " · watched" : ""}</div>
        <div class="ask-btns">
          <button class="da-btn ask-main" data-act="disk">▶ Play from disk<span>No buffering · ${bytes(it.size)}</span></button>
          <button class="da-btn ghost ask-main" data-act="stream">⇄ ${esc(streamLabel)}<span>Use the torrent instead</span></button>
        </div>
        <div class="fp-btns"><span style="flex:1"></span><button class="da-btn ghost" data-act="cancel">Cancel</button></div></div>`;
      for (const ev of ["click", "dblclick", "mousedown", "mouseup", "wheel", "pointerdown", "keydown"]) m.addEventListener(ev, (e) => e.stopPropagation());
      const done = (v) => { m.remove(); window.removeEventListener("keydown", onKey, true); resolve(v); };
      const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); } };
      window.addEventListener("keydown", onKey, true);
      m.addEventListener("click", (e) => {
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (act === "disk" || act === "stream") done(act);
        else if (act === "cancel" || e.target === m) done(null);
      });
      document.body.appendChild(m);
    });
  }

  document.addEventListener("click", async (e) => {
    if (state.pickMode || !e.isTrusted && !e.target.closest?.('[class*="streams-container-"] a')) return;
    if (e.target.closest?.(".da-sbtn, .da-ep, #" + ID + "-ask")) return;

    // A stream in the stream list (also reached when StreamQualityPicker clicks the hidden link).
    const a = e.target.closest?.('[class*="streams-container-"] a');
    if (a) {
      const ids = pickVideoId();
      const it = ids && readyItem(ids.videoId);
      if (!it || state.streamChosenFor === ids.videoId) return;
      const href = a.getAttribute("href") || "";
      if (!href.startsWith("#/player/")) return;
      const s = await linkStream(a);
      if (String(s?.url || "").startsWith(HELPER)) return; // already the "📁 Downloaded" stream
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const choice = await askPlay(it, "Play this stream");
      if (choice === "disk") playItem(it);
      if (choice === "stream") location.hash = href;
      return;
    }

    // An episode in the episode list.
    const row = e.target.closest?.(ROW);
    if (row && isEpisodeRow(row)) {
      const vid = rowVideoId(row);
      const it = vid && readyItem(vid);
      if (!it) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      const choice = await askPlay(it, "Choose a stream");
      if (choice === "disk") playItem(it);
      // row.click() is a synthetic click, which this handler lets through for rows.
      if (choice === "stream") { state.streamChosenFor = vid; row.click(); }
    }
  }, true);

  // ------------------------------------------------------------------ stream list: download buttons
  // A download button on every stream: on StreamQualityPicker's cards when it's on, and on
  // Stremio's own stream rows otherwise. One click downloads that exact stream.
  const linkStreams = new Map(); // href -> decoded stream (or null)
  function linkStream(a) {
    const href = a.getAttribute("href") || "";
    if (!linkStreams.has(href)) linkStreams.set(href, streamFromLink(a));
    return linkStreams.get(href);
  }

  function itemForStream(videoId, s) {
    if (!s) return null;
    return (state.dl?.items || []).find((it) => it.videoId === videoId &&
      (s.infoHash ? it.infoHash === s.infoHash.toLowerCase() && it.fileIdx === s.fileIdx : it.url === s.url));
  }

  function setStreamBtn(btn, it) {
    const pct = it?.size ? Math.floor((it.done / it.size) * 100) : 0;
    const st = !it || it.status === "watched" ? "" : it.status === "done" ? "done" : "busy";
    if (btn.dataset.st !== st || (st === "busy" && btn.dataset.pct !== String(pct))) {
      btn.dataset.st = st; btn.dataset.pct = pct;
      btn.classList.toggle("done", st === "done"); btn.classList.toggle("busy", st === "busy");
      btn.innerHTML = st === "done" ? "✓" : ICON + (st === "busy" && btn.dataset.text ? `<b>${pct}%</b>` : "");
      btn.title = st === "done" ? "Downloaded, ready to watch" : st === "busy" ? `Downloading ${pct}%` : "Download this stream";
    }
  }

  function decorateStreams() {
    const ids = pickVideoId();
    const box = document.querySelector('[class*="streams-container-"]');
    if (!ids || !box) return;
    const links = [...box.querySelectorAll("a")];
    const playable = (a) => (a.getAttribute("href") || "").startsWith("#/player/");

    const attach = (host, a, withText) => {
      let btn = host.querySelector(":scope > .da-sbtn");
      if (!btn) {
        injectCSS();
        if (getComputedStyle(host).position === "static") host.style.position = "relative";
        btn = document.createElement("div");
        btn.className = "da-sbtn" + (withText ? " card" : "");
        if (withText) btn.dataset.text = "1"; // text badges only on SQP cards; Stremio's rows feed SQP's parser
        btn.innerHTML = ICON;
        for (const ev of ["pointerdown", "mousedown", "mouseup", "dblclick"]) btn.addEventListener(ev, (e) => e.stopPropagation());
        btn.addEventListener("click", async (e) => {
          e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
          queueDownload(await linkStream(a), pickVideoId());
        });
        host.appendChild(btn);
      }
      linkStream(a).then((s) => setStreamBtn(btn, itemForStream(ids.videoId, s)));
    };

    links.forEach((a) => { if (playable(a)) attach(a, a, false); });
    document.querySelectorAll("#sqp-root .sqp-c[data-sqp]").forEach((card) => {
      const a = links[Number(card.dataset.sqp)];
      if (a && playable(a)) attach(card, a, true);
    });
  }

  // ------------------------------------------------------------------ in-app folder picker
  // A Windows folder dialog opens behind Stremio's fullscreen window, so pick the folder in-app.
  // Resolves with the chosen folder (already saved in the helper) or null if cancelled.
  let pickerPromise = null;
  function chooseFolder() {
    if (pickerPromise) return pickerPromise;
    pickerPromise = new Promise((resolve) => {
      injectCSS();
      const m = document.createElement("div");
      m.id = ID + "-picker";
      m.innerHTML = `<div class="fp-box">
        <div class="fp-h">Choose a download folder</div>
        <div class="fp-path"></div>
        <div class="fp-list"></div>
        <div class="fp-new" style="display:none"><input class="fp-in" placeholder="New folder name" maxlength="80"><button class="da-btn" data-act="mk">Create</button></div>
        <div class="fp-err"></div>
        <div class="fp-btns"><button class="da-btn ghost" data-act="newdir">New folder</button><span style="flex:1"></span>
          <button class="da-btn ghost" data-act="cancel">Cancel</button><button class="da-btn" data-act="use">Use this folder</button></div></div>`;
      for (const ev of ["click", "dblclick", "mousedown", "mouseup", "wheel", "pointerdown", "keydown", "keyup", "keypress"]) m.addEventListener(ev, (e) => e.stopPropagation());
      document.body.appendChild(m);
      let cur = "";
      const err = (t) => { m.querySelector(".fp-err").textContent = t || ""; };
      const done = (val) => { m.remove(); pickerPromise = null; resolve(val); };
      async function go(p) {
        err("");
        try {
          const r = await api("/dl/browse?path=" + encodeURIComponent(p || ""));
          cur = r.path;
          m.querySelector(".fp-path").innerHTML = cur
            ? `<button class="da-btn ghost fp-up" data-act="up" data-p="${esc(r.parent || "")}">↑ Up</button><span>${esc(cur)}</span>${r.free != null ? `<span class="fp-free">${bytes(r.free)} free</span>` : ""}`
            : `<span>This PC</span>`;
          m.querySelector(".fp-list").innerHTML = r.dirs.length
            ? r.dirs.map((d) => `<div class="fp-dir" data-p="${esc(d.path)}">📁 ${esc(d.name)}</div>`).join("")
            : `<div class="fp-empty">No folders here. You can use this one, or make a new folder.</div>`;
          m.querySelector("[data-act=use]").disabled = !cur;
          m.querySelector("[data-act=newdir]").disabled = !cur;
        } catch (e) { err(e.message); }
      }
      m.addEventListener("click", async (e) => {
        const dir = e.target.closest(".fp-dir"); if (dir) return go(dir.dataset.p);
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (act === "up") return go(e.target.closest("[data-act]").dataset.p);
        if (act === "cancel" || e.target === m) return done(null);
        if (act === "newdir") { const n = m.querySelector(".fp-new"); n.style.display = "flex"; n.querySelector("input").focus(); return; }
        if (act === "mk") {
          const name = m.querySelector(".fp-in").value.trim(); if (!name) return;
          try { const r = await api("/dl/mkdir", { path: cur, name }); m.querySelector(".fp-new").style.display = "none"; m.querySelector(".fp-in").value = ""; go(r.path); }
          catch (er) { err(er.message); }
          return;
        }
        if (act === "use" && cur) {
          try { const r = await api("/dl/set-folder", { path: cur }); await refreshDownloads(); done(r.folder); }
          catch (er) { err(er.message); }
        }
      });
      m.querySelector(".fp-in").addEventListener("keydown", (e) => { if (e.key === "Enter") m.querySelector("[data-act=mk]").click(); if (e.key === "Escape") done(null); });
      go(state.dl?.folder || "");
    });
    return pickerPromise;
  }

  function showNote(msg) {
    injectCSS();
    document.getElementById(ID + "-note")?.remove();
    const t = document.createElement("div");
    t.id = ID + "-note"; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  // ------------------------------------------------------------------ Downloads page
  // Opened from the "Downloads" entry added to Stremio's sidebar (or the player's download menu).
  // A full-screen overlay: folder, what's downloading, and what's ready grouped by show and season.
  const PAGE_ID = ID + "-page";
  let pageTimer = null;

  // Stremio keeps a separate sidebar in each section (Board, Discover, Library, ...), so add the
  // entry to every one of them.
  function ensureNavItem() {
    document.querySelectorAll('[class*="vertical-nav-bar-container-"]').forEach(addNavItem);
  }
  function addNavItem(bar) {
    const lib = bar.querySelector('a[href^="#/library"]');
    if (!lib || bar.querySelector(".da-nav")) return;
    const item = document.createElement("a");
    item.className = lib.className.replace(/\bselected\b/, "") + " da-nav";
    item.title = "Downloads";
    item.tabIndex = -1;
    const iconClass = lib.querySelector("svg")?.getAttribute("class") || "";
    const labelClass = lib.querySelector("div")?.className || "";
    // Outline icon in the same style as Stremio's other sidebar icons (stroke in currentColor).
    item.innerHTML = `<svg class="${iconClass}" viewBox="0 0 512 512"><path d="M256 72v264M160 244l96 96 96-96M96 432h320" style="fill:none;stroke:currentcolor;stroke-linecap:round;stroke-linejoin:round;stroke-width:32"/></svg>` +
      `<div class="${labelClass}">Downloads</div>`;
    item.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openPage(); });
    lib.after(item);
  }

  function openPage() {
    close();
    if (document.getElementById(PAGE_ID)) return;
    injectCSS();
    const pg = document.createElement("div");
    pg.id = PAGE_ID;
    pg.innerHTML = `<div class="dp-top"><button class="dp-back" data-act="close" title="Back">←</button><div class="dp-h1">Downloads</div></div><div class="dp-body"></div>`;
    for (const ev of ["click", "dblclick", "mousedown", "mouseup", "wheel", "pointerdown", "keydown"]) pg.addEventListener(ev, (e) => e.stopPropagation());
    pg.addEventListener("click", onPageClick);
    document.body.appendChild(pg);
    renderPage();
    refreshDownloads().then(renderPage);
    pageTimer = setInterval(() => refreshDownloads().then(renderPage), 2000);
  }

  function closePage() {
    document.getElementById(PAGE_ID)?.remove();
    clearInterval(pageTimer);
  }

  async function onPageClick(e) {
    const el = e.target.closest("[data-act]"); if (!el) return;
    const act = el.dataset.act, key = el.dataset.key;
    if (act === "close") return closePage();
    if (act === "folder") { await chooseFolder(); }
    if (act === "open") { await api("/dl/open-folder", key ? { key } : {}).catch((er) => showNote(er.message)); return; }
    if (act === "remove") {
      // Two clicks to delete: the first turns the ✕ into "Delete?" for a few seconds.
      if (state.confirmKey !== key) {
        state.confirmKey = key;
        el.classList.add("sure"); el.textContent = "Delete?";
        clearTimeout(state.confirmTimer);
        state.confirmTimer = setTimeout(() => { state.confirmKey = null; renderPage(); }, 3000);
        return;
      }
      state.confirmKey = null;
      await api("/dl/remove", { key }).catch(() => {});
    }
    if (act === "keep") {
      const it = (state.dl?.items || []).find((i) => i.key === key);
      await api("/dl/keep", { key, keep: !it?.keep }).catch((er) => showNote(er.message));
    }
    if (act === "autodel") {
      await api("/dl/settings", { autoDelete: state.dl?.autoDelete === false }).catch((er) => showNote(er.message));
    }
    if (act === "play") { const it = (state.dl?.items || []).find((i) => i.key === key); if (it) { closePage(); playItem(it); } return; }
    await refreshDownloads(); renderPage();
  }

  async function playItem(it) {
    const r = await (await fetch(resource(ADDON_URL, "stream", it.type, it.videoId))).json();
    const s = r.streams?.find((x) => x.url.endsWith("/" + it.key)) || r.streams?.[0];
    if (!s) return showNote("That file isn't available any more.");
    location.hash = ["#", "player", encodeURIComponent(await encodeStream(s)), encodeURIComponent(ADDON_URL),
      encodeURIComponent("https://v3-cinemeta.strem.io/manifest.json"), it.type, encodeURIComponent(it.metaId || it.videoId.split(":")[0]),
      encodeURIComponent(it.videoId)].join("/");
  }

  const eta = (it) => (it.speed > 0 && it.size ? Math.max(0, (it.size - it.done) / it.speed) : null);
  const fmtDur = (s) => { if (s == null) return ""; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m left` : m ? `${m}m left` : `${s}s left`; };
  const epOf = (it) => { const m = it.videoId.match(/:(\d+):(\d+)$/); return m ? { s: Number(m[1]), e: Number(m[2]) } : null; };

  function renderPage() {
    const pg = document.getElementById(PAGE_ID); if (!pg) return;
    const body = pg.querySelector(".dp-body");
    const keep = body.scrollTop;
    if (state.helperDown) { body.innerHTML = `<div class="dp-card dp-empty">The Strem+ helper isn't running. Run <b>install-startup.ps1</b> in <b>%APPDATA%\\stremio-enhanced\\strem-plus-helper</b> (right-click it, Run with PowerShell). Steps: github.com/BigBoy203/Strem_plus</div>`; return; }
    const items = state.dl?.items || [];
    const active = items.filter((i) => ["downloading", "queued", "waiting", "error"].includes(i.status));
    const ready = items.filter((i) => i.status === "done");
    const readyBytes = ready.reduce((a, i) => a + (i.size || 0), 0);
    const autoDel = state.dl?.autoDelete !== false;
    const keepBtn = (it) => `<button class="da-btn ghost dp-sm dp-keep${it.keep ? " on" : ""}" data-act="keep" data-key="${it.key}"
      title="${it.keep ? "Kept: never deleted automatically. Click to stop keeping it." : "Keep this episode: never delete it automatically"}">📌 ${it.keep ? "Kept" : "Keep"}</button>`;

    let h = `<div class="dp-card dp-folder">
      <div class="dp-fl"><div class="dp-lbl">Download folder</div><div class="dp-path">${state.dl?.folder ? esc(state.dl.folder) : "Not chosen yet"}</div>
        <div class="dp-meta">${state.dl?.free != null ? bytes(state.dl.free) + " free" : ""}${ready.length ? ` · ${ready.length} ready (${bytes(readyBytes)})` : ""}${active.length ? ` · ${active.length} downloading` : ""}</div></div>
      <div class="dp-actions"><button class="da-btn" data-act="folder">${state.dl?.folder ? "Change folder" : "Choose folder"}</button>
        ${state.dl?.folder ? `<button class="da-btn ghost" data-act="open">Open in Explorer</button>` : ""}</div>
      <div class="dp-toggle-row" data-act="autodel">
        <div class="dp-switch${autoDel ? " on" : ""}"><i></i></div>
        <div><div class="dp-ep-t">Delete after watching</div>
          <div class="dp-meta">${autoDel
            ? `On: an episode is deleted once you've watched ${Math.round(WATCHED_AT * 100)}% of it, unless you keep it (📌).`
            : "Off: nothing is deleted automatically. Delete episodes yourself with ✕."}</div></div></div></div>`;

    if (active.length) {
      h += `<div class="dp-sec">Downloading</div>` + active.map((it) => {
        const pct = it.size ? (it.done / it.size) * 100 : 0;
        return `<div class="dp-card dp-dl"><div class="dp-poster" data-meta="${esc(it.metaId)}" data-type="${it.type}"></div>
          <div class="dp-main"><div class="dp-title">${esc(it.title)}</div><div class="dp-rel" title="${esc(it.release || it.filename)}">${esc(it.quality ? it.quality + " · " : "")}${esc(it.release || it.filename)}</div>
          <div class="da-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
          <div class="dp-meta">${statusLine(it)}${it.status === "downloading" && eta(it) != null ? " · " + fmtDur(eta(it)) : ""}</div></div>
          ${keepBtn(it)}
          <button class="da-x${state.confirmKey === it.key ? " sure" : ""}" data-act="remove" data-key="${it.key}" title="Cancel and delete">${state.confirmKey === it.key ? "Delete?" : "✕"}</button></div>`;
      }).join("");
    }

    if (ready.length) {
      // Group: show -> season -> episodes (movies get their own group with no seasons).
      const shows = new Map();
      for (const it of ready) {
        const k = it.metaId || it.title;
        if (!shows.has(k)) shows.set(k, { name: it.title.split(/ S\d+E\d+/)[0], metaId: it.metaId, type: it.type, items: [] });
        shows.get(k).items.push(it);
      }
      h += `<div class="dp-sec">Ready to watch</div>`;
      for (const g of shows.values()) {
        const size = g.items.reduce((a, i) => a + (i.size || 0), 0);
        h += `<div class="dp-card dp-show"><div class="dp-show-h"><div class="dp-poster big" data-meta="${esc(g.metaId)}" data-type="${g.type}"></div>
          <div><div class="dp-show-name">${esc(g.name)}</div><div class="dp-meta">${g.type === "movie" ? "Movie" : `${g.items.length} episode${g.items.length > 1 ? "s" : ""}`} · ${bytes(size)}</div></div></div>`;
        const seasons = new Map();
        for (const it of g.items.sort((a, b) => ((epOf(a)?.s || 0) - (epOf(b)?.s || 0)) || ((epOf(a)?.e || 0) - (epOf(b)?.e || 0)))) {
          const s = epOf(it)?.s; if (!seasons.has(s)) seasons.set(s, []); seasons.get(s).push(it);
        }
        for (const [s, eps] of seasons) {
          if (s != null) h += `<div class="dp-season">Season ${s}</div>`;
          h += eps.map((it) => `<div class="dp-ep"><div class="dp-main"><div class="dp-ep-t">${esc(it.title.replace(g.name, "").trim() || it.title)}${it.watched ? ` <span class="dp-tag">Watched</span>` : ""}</div>
            <div class="dp-rel" title="${esc(it.release || it.filename)}">${esc(it.quality ? it.quality + " · " : "")}${bytes(it.size)} · downloaded ${new Date(it.finishedAt || it.addedAt).toLocaleDateString()}</div></div>
            ${keepBtn(it)}
            <button class="da-btn" data-act="play" data-key="${it.key}">▶ Play</button>
            <button class="da-btn ghost dp-sm" data-act="open" data-key="${it.key}" title="Show in Explorer">📂</button>
            <button class="da-x${state.confirmKey === it.key ? " sure" : ""}" data-act="remove" data-key="${it.key}" title="Delete">${state.confirmKey === it.key ? "Delete?" : "✕"}</button></div>`).join("");
        }
        h += `</div>`;
      }
    }

    if (!active.length && !ready.length) {
      h += `<div class="dp-card dp-empty">Nothing downloaded yet.<br><span class="dp-meta">Use the download button on an episode, on a stream in the stream list, or in the player.</span></div>`;
    }
    h += `<div class="dp-foot">${autoDel ? `Episodes are deleted automatically after you watch ${Math.round(WATCHED_AT * 100)}% of them, except ones you keep (📌).` : "Delete after watching is off, so episodes stay until you delete them."} Downloads use Stremio's torrent engine, so they only run while Stremio is open and resume where they stopped.</div>`;

    body.innerHTML = h;
    body.scrollTop = keep;
    // Posters from Cinemeta (cached).
    body.querySelectorAll(".dp-poster[data-meta]").forEach(async (el) => {
      if (!el.dataset.meta) return;
      const meta = await metaInfo(el.dataset.type || "series", el.dataset.meta);
      if (meta.poster) el.style.backgroundImage = `url("${meta.poster}")`;
    });
  }

  // ------------------------------------------------------------------ player button
  const ICON = `<svg viewBox="0 0 512 512"><path d="M232 64a24 24 0 0 1 48 0v214l70-70a24 24 0 0 1 34 34L273 353a24 24 0 0 1-34 0L128 242a24 24 0 0 1 34-34l70 70zM96 400h320a24 24 0 0 1 0 48H96a24 24 0 0 1 0-48z"/></svg>`;
  function ensureButton() {
    if (!onPlayer() || document.getElementById(ID + "-btn")) return;
    const menu = document.querySelector('[class*="control-bar-buttons-menu-container-"]');
    const sibling = menu?.querySelector('[class*="control-bar-button-"]:not([id])');
    if (!sibling) return;
    const btn = document.createElement("div");
    btn.id = ID + "-btn"; btn.tabIndex = -1; btn.title = "Download ahead";
    btn.className = sibling.className.replace(/\bdisabled\b/, "");
    btn.innerHTML = ICON;
    const svgClass = sibling.querySelector("svg")?.getAttribute("class");
    if (svgClass) btn.querySelector("svg").setAttribute("class", svgClass);
    btn.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    menu.insertBefore(btn, menu.firstChild);
  }

  // ------------------------------------------------------------------ route + watched tracking
  async function onRoute() {
    const prev = state.player;
    state.player = onPlayer() ? await parsePlayer() : null;
    if (prev?.videoId && prev.videoId !== state.player?.videoId) api("/dl/left", { videoId: prev.videoId }).catch(() => {});
    if (!state.player) close();
    document.getElementById(ID + "-toast")?.remove();
    state.next = null; state.nextErr = "";
    if (state.player) {
      await refreshDownloads();
      const it = itemFor(state.player.videoId);
      const fromDisk = String(state.player.stream?.url || "").startsWith(HELPER);
      if (it?.status === "done" && !fromDisk && !state.toastDismissed.has(state.player.videoId)) showToast();
      if (state.open) findNext().then(() => { if (state.next) state.next.forVideo = state.player?.videoId; render(); });
    }
  }

  setInterval(() => {
    if (state.open && document.querySelector('[class*="menu-layer-"]')) close();
    if (location.hash !== state.route) {
      state.route = location.hash; closePage(); onRoute();
      // "Stream it" was chosen for one episode's stream list; forget that once you leave it.
      if (state.streamChosenFor && pickVideoId()?.videoId !== state.streamChosenFor) state.streamChosenFor = null;
    }
    ensureButton();
    ensureNavItem();
    // Download mode ends if you leave the episode's stream list.
    if (state.pickMode && !pickVideoId() && Date.now() - state.pickMode.at > 4000) state.pickMode = null;
    updatePickBanner();
    decorateStreams();
    if (document.querySelector(ROW) || document.querySelector('[class*="streams-container-"]')) {
      decorateRows();
      if (!state.rowsRefreshedAt || Date.now() - state.rowsRefreshedAt > 5000) { state.rowsRefreshedAt = Date.now(); refreshDownloads(); }
    }

    // Watched: once WATCHED_AT of the episode has played, tell the helper (it deletes the file
    // after the player lets go of it).
    const p = state.player, v = document.querySelector("video");
    if (p?.videoId && v && v.duration > 60 && v.currentTime / v.duration >= WATCHED_AT && !state.watchedSent.has(p.videoId)) {
      state.watchedSent.add(p.videoId);
      api("/dl/watched", { videoId: p.videoId }).catch(() => state.watchedSent.delete(p.videoId));
    }
  }, 1000);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.getElementById(PAGE_ID)) { e.preventDefault(); e.stopPropagation(); closePage(); }
  }, true);

  window.addEventListener("beforeunload", () => {
    if (state.player?.videoId) navigator.sendBeacon?.(HELPER + "/dl/left", new Blob([JSON.stringify({ videoId: state.player.videoId })], { type: "text/plain" }));
  });
})();
