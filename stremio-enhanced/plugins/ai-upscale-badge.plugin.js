/**
 * @name AIUpscaleBadge
 * @description Adds the full torrent name to StreamQualityPicker's stream cards and an AI UPSCALE badge on AI-upscaled releases (also in Stremio's normal stream list and on SQP's Best buttons). Nothing is hidden or skipped. Works on its own; the torrent names on cards need the StreamQualityPicker plugin enabled.
 * @updateUrl https://raw.githubusercontent.com/BigBoy203/Strem_plus/main/stremio-enhanced/plugins/ai-upscale-badge.plugin.js
 * @source https://github.com/BigBoy203/Strem_plus
 * @version 1.1.0
 * @author kingkiller6203
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
a[data-aiu] [class*="addon-name-"]::after{content:"AI UPSCALE";display:inline-block;margin-left:8px;padding:1px 6px;border-radius:4px;
  font-size:10px;font-weight:700;letter-spacing:.3px;vertical-align:middle;background:rgba(249,115,22,.16);color:#fb923c;border:1px solid rgba(249,115,22,.35)}
a[data-aiu="maybe"] [class*="addon-name-"]::after{content:"AI?";background:rgba(249,115,22,.07);color:rgba(251,146,60,.75);border-style:dashed}
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

  function scan() {
    const box = document.querySelector('[class*="streams-container-"]');
    if (!box) return;
    const links = [...box.querySelectorAll("a")];
    const hits = links.map((a) => classify(streamText(a)));

    // Stremio's own list. A data attribute + CSS badge, so the link's text stays untouched
    // (StreamQualityPicker reads that text to build its cards).
    links.forEach((a, i) => {
      const want = hits[i]?.level || null;
      if ((a.dataset.aiu || null) !== want) want ? (a.dataset.aiu = want) : delete a.dataset.aiu;
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

      const hit = hits[Number(card.dataset.sqp)];
      if (!hit) return;
      card.classList.add("aiu-card");
      const row = card.querySelector(".sqp-r2");
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

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  }).observe(document.body, { childList: true, subtree: true });
  scan();
})();
