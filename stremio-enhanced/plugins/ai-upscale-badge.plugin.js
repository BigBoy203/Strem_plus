/**
 * @name StreamInfoBadges
 * @description Quality, HDR, codec and seeder badges on every stream, plus fixes for silent or stuttering audio.
 * @updateUrl https://raw.githubusercontent.com/BigBoy203/Strem_plus/main/stremio-enhanced/plugins/ai-upscale-badge.plugin.js
 * @source https://github.com/BigBoy203/Strem_plus
 * @version 2.0.1
 * @author BigBoy203
 */

(() => {
  "use strict";

  // Kept separate from StreamQualityPicker on purpose: that plugin updates itself from GitHub,
  // which would overwrite any edits made inside it.

  // Clear upscale tags in release names.
  const SURE = [
    /\bAI[\s._-]*(?:up[\s._-]*scal\w*|enhanc\w*|remaster\w*|restor\w*|4K|2160p|1080p|UHD)\b/i,
    /\b(?:up[\s._-]*scal(?:e|ed|ing)|upconvert(?:ed)?|up[\s._-]*rez(?:zed)?)\b/i,
    /\b(?:Topaz|Video[\s._-]*AI|Real[\s._-]*ESRGAN|ESRGAN|Waifu2x|Anime4K|AIUS|AIUP)\b/i,
  ];
  // A lone "AI" token in a release name usually means an upscale, but it's not certain.
  const MAYBE = /(?:^|[\s._\-\[\(])AI(?=$|[\s._\-\]\)])/;

  // Audio Stremio's built-in (Chromium) player can't play: it has to be converted by Stremio's
  // streaming server, so it starts slower, and plays silent if the converter isn't working.
  const AUDIO = [
    { kind: "DTS",   re: /\bDTS(?:[\s._-]?(?:HD|X|MA|ES))?\b/i },
    { kind: "DOLBY", re: /\b(?:DDP|DD\+|E-?AC-?3|DD[\s._-]?\d\.\d|AC-?3|TrueHD|Atmos|Dolby[\s._-]?Digital)/i },
  ];
  function audioKind(text) {
    for (const a of AUDIO) { const m = text.match(a.re); if (m) return { kind: a.kind, tag: m[0] }; }
    return null;
  }

  // Badge colours: [background, text, border].
  const TONE = {
    "4K": ["rgba(96,165,250,.12)", "#60a5fa", "rgba(96,165,250,.22)"],
    "1080p": ["rgba(74,222,128,.12)", "#4ade80", "rgba(74,222,128,.22)"],
    "720p": ["rgba(250,204,21,.12)", "#facc15", "rgba(250,204,21,.22)"],
    "SD": ["rgba(161,161,170,.10)", "#a1a1aa", "rgba(161,161,170,.18)"],
    DV: ["rgba(192,132,252,.14)", "#c084fc", "rgba(192,132,252,.28)"],
    "HDR10+": ["rgba(251,191,36,.14)", "#fbbf24", "rgba(251,191,36,.28)"],
    HDR10: ["rgba(110,231,183,.14)", "#6ee7b7", "rgba(110,231,183,.28)"],
    HDR: ["rgba(110,231,183,.14)", "#6ee7b7", "rgba(110,231,183,.28)"],
    ATMOS: ["rgba(125,211,252,.14)", "#7dd3fc", "rgba(125,211,252,.28)"],
    REMUX: ["rgba(240,171,252,.14)", "#f0abfc", "rgba(240,171,252,.28)"],
    "WEB-DL": ["rgba(209,213,219,.10)", "#d1d5db", "rgba(209,213,219,.18)"],
    BluRay: ["rgba(165,180,252,.14)", "#a5b4fc", "rgba(165,180,252,.28)"],
    codec: ["rgba(255,255,255,.06)", "#c4c4cc", "rgba(255,255,255,.12)"],
    AUDIO: ["rgba(56,189,248,.14)", "#7dd3fc", "rgba(56,189,248,.35)"],
    AI: ["rgba(249,115,22,.16)", "#fb923c", "rgba(249,115,22,.35)"],
  };
  // Shown in the tooltip when you hover a badge.
  const BADGE_TIPS = {
    "4K": "4K (2160p): the sharpest picture, the biggest files",
    "1080p": "Full HD (1080p): great picture at a sensible size",
    "720p": "HD (720p): smaller files, a softer picture",
    SD: "Standard definition: low resolution, small files",
    DV: "Dolby Vision: premium HDR that adjusts brightness scene by scene. Looks best on a Dolby Vision screen",
    "HDR10+": "HDR10+: HDR that adjusts brightness scene by scene",
    HDR10: "HDR10: brighter highlights and richer colour on HDR screens",
    HDR: "HDR: brighter highlights and richer colour on HDR screens",
    HEVC: "HEVC (x265): same quality in about half the size. Plays directly in Stremio",
    "H.264": "H.264 (x264): the most compatible video format, but bigger files",
    AV1: "AV1: the newest and smallest format, but Stremio has to convert it, so it may freeze briefly",
    "10-BIT": "10-bit colour: smoother gradients, less banding in skies and shadows",
    REMUX: "REMUX: an untouched copy of the disc. Best possible quality, huge files",
    "WEB-DL": "WEB-DL: taken straight from a streaming service, not re-encoded",
    BluRay: "BluRay: encoded from a Blu-ray disc. Usually great quality",
    ATMOS: "Dolby Atmos: 3D surround sound. Stremio plays it as stereo",
  };
  // Everything worth a badge in one stream's addon name + description.
  function badgesFor(text, seeds) {
    const b = [];
    const res = /\b(?:4k|2160p|uhd)\b/i.test(text) ? "4K" : /\b1080p\b/i.test(text) ? "1080p" : /\b720p\b/i.test(text) ? "720p"
      : /\b(?:480p|576p|sd|dvdrip)\b/i.test(text) ? "SD" : null;
    if (res) b.push([res, res]);
    if (/\bDV\b|\bDoVi\b|Dolby[\s._-]?Vision/i.test(text)) b.push(["DV", "DV"]);
    if (/\bHDR10\+|HDR10plus/i.test(text)) b.push(["HDR10+", "HDR10+"]);
    else if (/\bHDR10\b/i.test(text)) b.push(["HDR10", "HDR10"]);
    else if (/\bHDR\b/i.test(text)) b.push(["HDR", "HDR"]);
    const codec = /\b(?:x265|h\.?265|hevc)\b/i.test(text) ? "HEVC" : /\bav1\b/i.test(text) ? "AV1" : /\b(?:x264|h\.?264|avc)\b/i.test(text) ? "H.264" : null;
    if (codec) b.push(["codec", codec]);
    if (/\b10[\s._-]?bit\b/i.test(text)) b.push(["codec", "10-BIT"]);
    if (/\bREMUX\b/i.test(text)) b.push(["REMUX", "REMUX"]);
    else if (/\bWEB[\s._-]?DL\b/i.test(text)) b.push(["WEB-DL", "WEB-DL"]);
    else if (/\bBlu[\s._-]?Ray\b|\bBDRip\b|\bBRRip\b/i.test(text)) b.push(["BluRay", "BluRay"]);
    if (/\bAtmos\b/i.test(text)) b.push(["ATMOS", "ATMOS"]);
    return { badges: b, seeds };
  }
  const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function badgeHTML(tone, label, tip) {
    const [bg, fg, bd] = TONE[tone] || TONE.codec;
    return `<span class="sib-b" style="background:${bg};color:${fg};border-color:${bd}" data-sib-tip="${escHtml(tip || BADGE_TIPS[label] || label)}">${escHtml(label)}</span>`;
  }
  // Seeder strength: four bars, like a signal meter.
  function seedHTML(seeds) {
    if (seeds < 0) return "";
    const lvl = seeds >= 500 ? 4 : seeds >= 200 ? 3 : seeds >= 50 ? 2 : seeds >= 1 ? 1 : 0;
    const c = lvl ? ["#ef4444", "#f97316", "#eab308", "#4ade80"][lvl - 1] : "#52525b";
    let bars = "";
    for (let i = 0; i < 4; i++) bars += `<i style="height:${5 + i * 3}px"${i < lvl ? ' class="on"' : ""}></i>`;
    const say = ["No seeders: it probably won't start", "Few seeders: may be slow to start or buffer", "Some seeders: should play, may buffer at times", "Plenty of seeders: should start quickly", "Lots of seeders: fast and smooth"][lvl];
    return `<span class="sib-seed" style="color:${c}" data-sib-tip="${seeds.toLocaleString()} seeders (people sharing it). ${say}"><span class="sib-bars">${bars}</span><b>${seeds.toLocaleString()}</b></span>`;
  }

  function classify(text) {
    for (const re of SURE) { const m = text.match(re); if (m) return { level: "sure", tag: m[0].trim() }; }
    const m = text.match(MAYBE);
    return m ? { level: "maybe", tag: "AI" } : null;
  }

  // The text of one stream in Stremio's own list (addon name + description), which is where
  // addons like Torrentio put the release name.
  function streamText(a) {
    const name = a.querySelector('[class*="addon-name-"]')?.textContent || "";
    const desc = a.querySelector('[class*="description-container-"]')?.textContent || "";
    return (name + "\n" + desc).trim() || a.textContent || "";
  }

  // Torrentio-style descriptions start with the torrent name (later lines are the file inside a
  // pack and the 👤/💾/⚙️ details). Skip a first line that is already one of those detail lines.
  function releaseName(a) {
    const desc = a.querySelector('[class*="description-container-"]');
    const text = desc?.getAttribute("title") || desc?.textContent || "";
    return text.split("\n").map((l) => l.trim()).find((l) => l && !/^(👤|💾|⚙|🔗|🌐|📺|🎞|🔊)/u.test(l)) || "";
  }

  const STYLE = `
.aiu-tname{font-size:11.5px;line-height:1.4;color:rgba(255,255,255,.62);margin:-4px 0 9px;word-break:break-word}
.aiu-chip{padding:2px 8px;border-radius:5px;font-size:9.5px;font-weight:700;letter-spacing:.3px;
  background:rgba(249,115,22,.16);color:#fb923c;border:1px solid rgba(249,115,22,.35)}
.aiu-chip.maybe{background:rgba(249,115,22,.07);color:rgba(251,146,60,.75);border-style:dashed}
.sqp-c.aiu-card{border-color:rgba(249,115,22,.22)!important}
.aiu-best{display:inline-block;margin-left:6px;padding:0 5px;border-radius:4px;font-size:9.5px;background:rgba(0,0,0,.35);color:#fdba74}
/* Badge row under each stream in Stremio's own list. The stream row wraps, so a full-width child
   lands on its own line below the description without touching the row's text. */
.sib-row{flex:0 0 100%;order:10;display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:calc(3px - 1rem);pointer-events:none}
/* The play icon no longer reserves space (it's invisible until you hover the row anyway): it floats over
   the right end of the row, so the release text gets the full width. */
a[class*="stream-container-"]{position:relative}
a[class*="stream-container-"] > svg[class*="icon-"]{position:absolute;right:1rem;top:50%;transform:translateY(-50%);z-index:2;box-shadow:0 0 0 6px rgba(0,0,0,.35)}
/* Stream row order: addon name | seeder column | release text, then the badge row. */
a:has(> .sib-seedcol) > [class*="info-container-"]{order:0}
.sib-seedcol{order:1;flex:none;width:44px;display:flex;justify-content:center}
a:has(> .sib-seedcol) > [class*="description-container-"]{order:2}
a:has(> .sib-seedcol) > :not([class*="info-container-"]):not([class*="description-container-"]):not(.sib-seedcol):not(.sib-row){order:3}
.sib-b{padding:2px 8px;border-radius:5px;font-size:11px;font-weight:700;letter-spacing:.3px;border:1px solid;white-space:nowrap;pointer-events:auto}
.sib-b.maybe{border-style:dashed;opacity:.8}
.sib-seed{display:inline-flex;flex-direction:column;align-items:center;gap:4px;pointer-events:auto;cursor:default}
.sib-bars{display:flex;align-items:flex-end;gap:2px}
.sib-seed i{display:block;width:4px;border-radius:1.5px;background:rgba(255,255,255,.1)}
.sib-seed i.on{background:currentColor}
.sib-seed b{font-size:12px;font-weight:700;line-height:1}
.sib-b{cursor:default}
#sib-tip{position:fixed;z-index:10000;max-width:280px;padding:8px 11px;border-radius:8px;pointer-events:none;
  background:var(--modal-background-color,#111);color:var(--primary-foreground-color,#fff);border:1px solid rgba(255,255,255,.14);
  font-size:12.5px;line-height:1.4;font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,.5);opacity:0;transition:opacity .1s}
#sib-tip.on{opacity:1}
.aiu-audio{padding:2px 8px;border-radius:5px;font-size:9.5px;font-weight:700;letter-spacing:.3px;
  background:rgba(56,189,248,.14);color:#7dd3fc;border:1px solid rgba(56,189,248,.35)}
#aiu-toast{position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:1001;background:#000;color:rgba(255,255,255,.92);
  padding:12px 18px;border-radius:12px;font-family:PlusJakartaSans,Arial,sans-serif;font-size:14px;box-shadow:0 12px 30px rgba(0,0,0,.45)}
`;
  const style = document.createElement("style");
  style.id = "aiu-style";
  style.textContent = STYLE;
  document.head.appendChild(style);

  function chip(hit) {
    const s = document.createElement("span");
    s.className = "aiu-chip" + (hit.level === "maybe" ? " maybe" : "");
    s.textContent = hit.level === "maybe" ? "AI?" : "AI UPSCALE";
    s.title = hit.level === "maybe"
      ? `Release name has a lone "AI" tag, which usually means an AI upscale.`
      : `AI-upscaled release (tagged "${hit.tag}"). Picture detail was generated, not from the original master.`;
    return s;
  }

  function audioChip(hit) {
    const s = document.createElement("span");
    s.className = "aiu-audio";
    s.textContent = hit.kind + " AUDIO";
    s.title = `${hit.kind === "DTS" ? "DTS" : "Dolby"} audio (tagged "${hit.tag}"). Stremio's player can't play it directly, so Stremio's streaming server converts it: it can take a few seconds longer to start, and plays silent if the converter isn't working.`;
    return s;
  }

  function scan() {
    const box = document.querySelector('[class*="streams-container-"]');
    if (!box) return;
    const links = [...box.querySelectorAll("a")];
    const texts = links.map(streamText);
    const hits = texts.map(classify);
    const audio = texts.map(audioKind);

    // Stremio's own list: one badge row per stream, added as the row's last child (outside the
    // addon name and description, whose text StreamQualityPicker reads to build its cards).
    links.forEach((a, i) => {
      const desc = a.querySelector('[class*="description-container-"]');
      if (!desc) return;
      const seedM = (desc.textContent || "").match(/👤\s*(\d[\d,]*)/u);
      const info = badgesFor(texts[i], seedM ? parseInt(seedM[1].replace(/,/g, ""), 10) : -1);
      let html = info.badges.map(([tone, label, tip]) => badgeHTML(tone, label, tip)).join("");
      if (audio[i]) html += badgeHTML("AUDIO", audio[i].kind + " AUDIO", `${audio[i].kind === "DTS" ? "DTS" : "Dolby"} sound (${audio[i].tag}): Stremio converts it as it plays, so it may take a few seconds longer to start`);
      if (hits[i]) html += badgeHTML("AI", hits[i].level === "maybe" ? "AI?" : "AI UPSCALE", hits[i].level === "maybe"
        ? `Possibly an AI upscale: the name has a lone "AI" tag`
        : `AI upscale (${hits[i].tag}): a lower-resolution source enlarged by AI. The extra detail is invented, not from the original`).replace('class="sib-b"', `class="sib-b${hits[i].level === "maybe" ? " maybe" : ""}"`);
      // Seeder meter in its own slim column between "Torrentio / 1080p" and the release text.
      let side = a.querySelector(":scope > .sib-seedcol");
      const seedH = seedHTML(info.seeds);
      if (seedH) {
        if (!side) { side = document.createElement("div"); side.className = "sib-seedcol"; a.appendChild(side); }
        if (side.dataset.sig !== seedH) { side.innerHTML = seedH; side.dataset.sig = seedH; }
      } else side?.remove();
      let row = a.querySelector(":scope > .sib-row");
      if (!html) { row?.remove(); return; }
      if (!row) { row = document.createElement("div"); row.className = "sib-row"; a.appendChild(row); }
      // Line the badges up under the description.
      const pad = Math.max(0, Math.round(desc.getBoundingClientRect().left - a.getBoundingClientRect().left - parseFloat(getComputedStyle(a).paddingLeft || 0)));
      if (row.dataset.sig !== html || row.dataset.pad !== String(pad)) { row.innerHTML = html; row.dataset.sig = html; row.dataset.pad = pad; row.style.paddingLeft = pad + "px"; }
      // Sit right under the release text, even when the left column is taller than it.
      const gapNow = row.getBoundingClientRect().top - desc.getBoundingClientRect().bottom;
      if (Math.abs(gapNow - 4) > 1) row.style.marginTop = Math.round(parseFloat(getComputedStyle(row).marginTop) - (gapNow - 4)) + "px";
    });

    // StreamQualityPicker's cards: data-sqp is the index of the original link.
    const root = document.getElementById("sqp-root");
    if (!root) return;
    root.querySelectorAll(".sqp-c[data-sqp]").forEach((card) => {
      if (card.dataset.aiuDone) return;
      card.dataset.aiuDone = "1";
      const link = links[Number(card.dataset.sqp)];

      // Full torrent name under the card's title row.
      const torrent = link ? releaseName(link) : "";
      if (torrent) {
        const n = document.createElement("div");
        n.className = "aiu-tname";
        n.textContent = torrent;
        card.querySelector(".sqp-r1")?.after(n);
      }

      const row = card.querySelector(".sqp-r2");
      const au = audio[Number(card.dataset.sqp)];
      if (au && row) row.appendChild(audioChip(au));

      const hit = hits[Number(card.dataset.sqp)];
      if (!hit) return;
      card.classList.add("aiu-card");
      if (row) row.appendChild(chip(hit));
    });

    // Say so on a Best button that points at an upscale.
    root.querySelectorAll(".sqp-bp[data-sqp]").forEach((btn) => {
      const hit = hits[Number(btn.dataset.sqp)];
      const mark = btn.querySelector(".aiu-best");
      if (hit && !mark) {
        const m = document.createElement("span");
        m.className = "aiu-best";
        m.textContent = hit.level === "maybe" ? "AI?" : "AI";
        btn.title = "This pick is an AI-upscaled release";
        btn.appendChild(m);
      } else if (!hit && mark) mark.remove();
    });
  }

  // ---------------------------------------------------------------- silent-start guard
  // If Stremio's server can't inspect a file in time (e.g. the torrent has no peers yet), the
  // player plays it directly, and Dolby/DTS audio is then silent. If a video plays for 6 s with no
  // audio decoded at all, restart it once: by then the server can inspect it and converts the audio.
  const GUARD_KEY = "aiu.audioRetry";
  function retried() { try { return JSON.parse(sessionStorage.getItem(GUARD_KEY) || "{}"); } catch (_) { return {}; } }
  let watch = null; // { route, startAt, audioAt0 }
  setInterval(() => {
    const v = document.querySelector("video");
    const route = location.hash;
    if (!route.startsWith("#/player/") || !v) { watch = null; return; }
    if (!watch || watch.route !== route) watch = { route, playedFrom: null };
    if (v.paused || v.readyState < 3) return;
    if (watch.playedFrom == null) { watch.playedFrom = v.currentTime; return; }
    if (v.currentTime - watch.playedFrom < 6 || watch.done) return;
    watch.done = true;
    const decoded = v.webkitAudioDecodedByteCount;
    if (typeof decoded !== "number" || decoded > 0) return;      // audio is playing (or can't tell)
    const seen = retried();
    const key = route.split("/").slice(-1)[0];
    if (seen[key] && Date.now() - seen[key] < 10 * 60_000) return; // only once per episode
    seen[key] = Date.now();
    try { sessionStorage.setItem(GUARD_KEY, JSON.stringify(seen)); } catch (_) {}
    const t = document.createElement("div");
    t.id = "aiu-toast"; t.textContent = "No sound detected. Restarting the stream so Stremio converts the audio…";
    document.body.appendChild(t);
    setTimeout(() => location.reload(), 1500);
  }, 1000);

  // ---------------------------------------------------------------- gap skipper
  // When the server converts audio, video and audio pieces come from separate ffmpeg runs and
  // leave tiny holes (a fraction of a second) between pieces. Stremio's player is set to tolerate
  // no holes at all, so it freezes at each one even with plenty buffered. If playback is stuck right
  // before a hole under a second long, jump over it.
  let lastT = -1, stuckSince = 0;
  setInterval(() => {
    const v = document.querySelector("video");
    if (!v || !location.hash.startsWith("#/player/") || v.paused || v.seeking || v.ended) { stuckSince = 0; return; }
    const t = v.currentTime;
    if (Math.abs(t - lastT) > 0.01) { lastT = t; stuckSince = 0; return; }
    if (!stuckSince) { stuckSince = Date.now(); return; }
    if (Date.now() - stuckSince < 400) return;
    const b = v.buffered;
    for (let i = 0; i < b.length; i++) {
      const gap = b.start(i) - t;
      if (gap > 0 && gap < 1) {
        v.currentTime = b.start(i) + 0.05;
        console.info(`[StreamInfoBadges] skipped a ${gap.toFixed(2)} s gap at ${t.toFixed(2)} s`);
        stuckSince = 0;
        return;
      }
    }
  }, 200);

  // ---------------------------------------------------------------- tooltips
  // Instant, theme-coloured tooltips for the badges (the browser's own title tooltips are slow and
  // easy to miss). One floating box, kept inside the window.
  const tip = document.createElement("div");
  tip.id = "sib-tip";
  document.body.appendChild(tip);
  let tipFor = null;
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest?.("[data-sib-tip]");
    if (el === tipFor) return;
    tipFor = el;
    if (!el) { tip.classList.remove("on"); return; }
    tip.textContent = el.dataset.sibTip;
    const r = el.getBoundingClientRect();
    tip.style.left = "0px"; tip.style.top = "0px"; tip.classList.add("on");
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = r.left + r.width / 2 - w / 2, y = r.top - h - 8;
    if (y < 8) y = r.bottom + 8;                                 // no room above: show below
    x = Math.max(8, Math.min(x, innerWidth - w - 8));
    tip.style.left = Math.round(x) + "px"; tip.style.top = Math.round(y) + "px";
  });
  addEventListener("scroll", () => { tipFor = null; tip.classList.remove("on"); }, true);

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  }).observe(document.body, { childList: true, subtree: true });
  scan();
})();
