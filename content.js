/**
 * TRACE Extension — Content Script
 * - Circular shield badges (hover only)
 * - Works on Twitter/X, BBC, Guardian, all public sites
 * - Re-verifies on page revisit (no stale UNKNOWN after manual verify)
 */
(function () {
  'use strict';

  const APP_URL   = "https://www.traceprotocol.co";
  const TRACE_API = "https://trace-cbvb.onrender.com";

  const BADGES = {
    VERIFIED_ORIGINAL: { color: "#fff", bg: "#34d399", border: "#34d399", label: "VERIFIED",   icon: "shield-check" },
    MODIFIED:          { color: "#fff", bg: "#fbbf24", border: "#fbbf24", label: "MODIFIED",   icon: "shield-alert" },
    UNVERIFIED:        { color: "#fff", bg: "#f43f5e", border: "#f43f5e", label: "UNVERIFIED", icon: "shield-x" },
    AI_GENERATED:      { color: "#fff", bg: "#a78bfa", border: "#a78bfa", label: "AI GEN",     icon: "sparkles" },
    REVOKED:           { color: "#fff", bg: "#f43f5e", border: "#f43f5e", label: "REVOKED",    icon: "shield-x" },
    UNKNOWN:           { color: "#fff", bg: "#71717a", border: "#71717a", label: "UNKNOWN",    icon: "shield" },
  };

  const SHIELD_PATHS = {
    "shield":       'M12 2 4 5v6c0 5 3 9 8 11 5-2 8-6 8-11V5l-8-3z',
    "shield-check": 'M12 2 4 5v6c0 5 3 9 8 11 5-2 8-6 8-11V5l-8-3zm-1 13L7 11l1.4-1.4L11 12.2l4.6-4.6L17 9l-6 6z',
    "shield-alert": 'M12 2 4 5v6c0 5 3 9 8 11 5-2 8-6 8-11V5l-8-3zm0 6v4m0 2v.01',
    "shield-x":     'M12 2 4 5v6c0 5 3 9 8 11 5-2 8-6 8-11V5l-8-3zM9 9l6 6m0-6-6 6',
    "sparkles":     'M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z',
  };

  const processed = new WeakSet();
  const MIN_SIZE  = 100;
  const verdictCache = new Map(); // hash -> verdict (survives page reloads via storage)

  // Load cached verdicts from chrome.storage on init
  chrome.storage.local.get("verdict_cache", items => {
    const cached = items.verdict_cache || {};
    Object.entries(cached).forEach(([h, v]) => verdictCache.set(h, v));
  });

  // ── Passive bank sighting (routes through background to bypass CSP) ──────────
  async function writeBankSighting(img, verdict) {
    try {
      const src = img.currentSrc || img.src
        || img.getAttribute("data-src") || img.getAttribute("data-lazy")
        || img.getAttribute("data-original") || img.getAttribute("data-bbc-width")
        || img.getAttribute("srcset")?.split(" ")[0] || "";
      if (!src || src.startsWith("data:") || src.length < 10) return;
      const msgBuffer  = new TextEncoder().encode(src);
      const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
      const urlHash = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
      chrome.runtime.sendMessage({
        type: "BANK_ENCOUNTER",
        url_hash:  urlHash,
        source:    window.location.hostname,
        verdict:   verdict || "UNKNOWN",
        media_url: src.slice(0, 200),
      });
    } catch { /* passive */ }
  }

  async function hashImage(img) {
    try {
      const canvas = document.createElement("canvas");
      const w = Math.min(64, img.naturalWidth  || 64);
      const h = Math.min(64, img.naturalHeight || 64);
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const hash = await crypto.subtle.digest("SHA-256", data.buffer);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
    } catch { return null; }
  }

  // Fallback hash from image URL when canvas blocked (BBC, Twitter, etc)
  async function urlHash(img) {
    const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
    if (!src) return null;
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(src));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  function getSize(img) {
    return {
      w: img.naturalWidth  || img.width  || img.offsetWidth  || 0,
      h: img.naturalHeight || img.height || img.offsetHeight || 0,
    };
  }

  function ensurePulseStyle() {
    if (document.getElementById("trace-pulse-style")) return;
    const style = document.createElement("style");
    style.id = "trace-pulse-style";
    style.textContent = `
      @keyframes trace-pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
      @keyframes trace-fade-in { from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:translateY(0)} }
      .trace-badge {
        opacity: 0;
        transition: opacity 0.2s ease, transform 0.15s ease;
        pointer-events: none;
      }
      .trace-img-wrapper:hover .trace-badge {
        opacity: 1 !important;
        pointer-events: auto !important;
      }
      .trace-badge:hover {
        opacity: 1 !important;
        transform: scale(1.15) !important;
      }
      .trace-badge-panel { animation: trace-fade-in 0.15s ease; }
      .trace-badge-panel a:hover { text-decoration: underline !important; }
    `;
    document.head.appendChild(style);
  }

  function injectBadge(img, verdict, info) {
    info = info || {};
    const cfg = BADGES[verdict] || BADGES.UNKNOWN;

    let container = img.parentElement;
    if (!container) return;

    for (let i = 0; i < 4; i++) {
      const tag = container.tagName;
      const pos = getComputedStyle(container).position;
      if (pos !== "static" || tag === "FIGURE" || tag === "PICTURE" || tag === "LI" || tag === "ARTICLE") break;
      if (container.parentElement) container = container.parentElement;
      else break;
    }

    container.querySelectorAll(".trace-badge").forEach(b => b.remove());
    container.classList.add("trace-img-wrapper");
    if (getComputedStyle(container).position === "static") container.style.position = "relative";

    ensurePulseStyle();

    const badge = document.createElement("div");
    badge.className = "trace-badge";
    // Responsive sizing based on media dimensions
    const mediaRect = img.getBoundingClientRect();
    const smaller   = Math.min(mediaRect.width, mediaRect.height);
    const badgeSize = smaller < 200 ? 24
                    : smaller < 400 ? 32
                    : smaller < 700 ? 40
                    : 48;
    const iconSize  = Math.round(badgeSize * 0.5);
    const offset    = Math.round(badgeSize * 0.25);

    badge.style.cssText = [
      "position:absolute",
      "top:" + offset + "px",
      "right:" + offset + "px",
      "z-index:2147483647",
      "width:" + badgeSize + "px","height:" + badgeSize + "px",
      "border-radius:50%",
      "display:flex","align-items:center","justify-content:center",
      "background:" + cfg.bg,
      "border:2px solid #fff",
      "color:" + cfg.color,
      "cursor:pointer","pointer-events:auto",
      "box-shadow:0 4px 12px rgba(0,0,0,0.5), 0 0 0 1px " + cfg.border + ", 0 0 20px " + cfg.border + "60",
      "transition:transform 0.15s ease",
    ].join(";");
    badge.dataset.iconSize = iconSize;

    badge.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24"
        fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="${SHIELD_PATHS[cfg.icon]}"/>
      </svg>
    `;

    badge.title = `TRACE: ${cfg.label} — hover for details`;

    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (info && info.mediaId) window.open(APP_URL + "/graph/" + info.mediaId, "_blank");
      else if (verdict === "UNKNOWN") window.open(APP_URL + "/verify", "_blank");
    });

    // Hover panel
    const panel = document.createElement("div");
    panel.className = "trace-badge-panel";
    panel.style.cssText = [
      "display:none","position:absolute","top:36px","right:0","width:300px",
      "background:#09090b","border:1px solid #27272a","border-radius:10px",
      "padding:14px","font-family:-apple-system,'Segoe UI',sans-serif","font-size:11px",
      "color:#a1a1aa","z-index:2147483647","box-shadow:0 8px 32px rgba(0,0,0,.9)",
      "pointer-events:auto",
    ].join(";");

    const bank          = info.bank || {};
    const sightingCount = bank.sighting_count || 0;
    const firstSeen     = bank.first_seen ? new Date(bank.first_seen).toLocaleDateString() : null;
    const sources       = Array.isArray(bank.sources) ? bank.sources : [];
    const spread = sightingCount > 100 ? "VIRAL"
                 : sightingCount > 10  ? "HIGH"
                 : sightingCount > 3   ? "MEDIUM" : "LOW";
    const spreadColor = sightingCount > 100 ? "#f43f5e"
                      : sightingCount > 10  ? "#fbbf24"
                      : sightingCount > 3   ? "#fb923c" : "#34d399";

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <span style="color:#fff;font-size:11px;font-weight:700;letter-spacing:.08em">TRACE PROTOCOL</span>
        <span style="display:flex;align-items:center;gap:4px">
          <span style="width:6px;height:6px;border-radius:50%;background:${cfg.color}"></span>
          <span style="color:${cfg.color};font-weight:700;font-size:10px">${cfg.label}</span>
        </span>
      </div>

      ${info.confidence !== undefined ? `
        <div style="margin-bottom:8px;font-size:10px">
          <span style="color:#52525b">Confidence: </span>
          <span style="color:#e4e4e7;font-weight:600">${Math.round(info.confidence * 100)}%</span>
        </div>` : ""}

      <div style="border-top:1px solid #27272a;margin:10px 0"></div>
      <div style="color:#3b82f6;font-size:9px;letter-spacing:.1em;margin-bottom:8px;font-weight:600">COLLECTIVE MEMORY BANK</div>

      ${sightingCount > 0 ? `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px">
          <div style="background:#18181b;border-radius:6px;padding:8px 4px;text-align:center">
            <div style="color:#fff;font-size:15px;font-weight:700">${sightingCount.toLocaleString()}</div>
            <div style="color:#52525b;font-size:8px;margin-top:2px">SIGHTINGS</div>
          </div>
          <div style="background:#18181b;border-radius:6px;padding:8px 4px;text-align:center">
            <div style="color:#fff;font-size:9px;font-weight:600;margin-top:3px">${firstSeen || "—"}</div>
            <div style="color:#52525b;font-size:8px;margin-top:2px">FIRST SEEN</div>
          </div>
          <div style="background:#18181b;border-radius:6px;padding:8px 4px;text-align:center">
            <div style="color:${spreadColor};font-size:10px;font-weight:700;margin-top:2px">${spread}</div>
            <div style="color:#52525b;font-size:8px;margin-top:2px">SPREAD</div>
          </div>
        </div>
        ${sources.length > 0 ? `
          <div style="margin-bottom:8px;font-size:10px">
            <span style="color:#52525b">Sources: </span>
            <span style="color:#a1a1aa">${sources.slice(0, 3).join(", ")}</span>
          </div>` : ""}
      ` : `
        <div style="color:#52525b;margin-bottom:10px;font-size:10px">First encounter — sighting recorded</div>
      `}

      ${(info.origin || info.mediaId) ? `
        <div style="border-top:1px solid #27272a;margin:10px 0"></div>
        <div style="color:#34d399;font-size:9px;letter-spacing:.1em;margin-bottom:8px;font-weight:600">ON-CHAIN PROVENANCE</div>
        ${info.origin?.creator ? `<div style="margin-bottom:4px;font-size:10px"><span style="color:#52525b">Creator: </span><span style="color:#06b6d4;font-family:monospace">${String(info.origin.creator).slice(0,18)}…</span></div>` : ""}
        ${info.origin?.first_seen ? `<div style="margin-bottom:4px;font-size:10px"><span style="color:#52525b">Registered: </span><span style="color:#e4e4e7">${new Date(info.origin.first_seen).toLocaleDateString()}</span></div>` : ""}
      ` : ""}

      <div style="border-top:1px solid #27272a;margin:10px 0"></div>
      <div style="display:flex;gap:10px;font-size:10px">
        ${info.mediaId ? `<a href="${APP_URL}/graph/${info.mediaId}" target="_blank" style="color:#34d399;text-decoration:none;font-weight:600">Provenance →</a>` : ""}
        <a href="${APP_URL}/bank" target="_blank" style="color:#3b82f6;text-decoration:none;font-weight:600">Memory Bank →</a>
        ${verdict === "UNKNOWN" ? `<a href="${APP_URL}/verify" target="_blank" style="color:#fbbf24;text-decoration:none;font-weight:600;margin-left:auto">Verify ↗</a>` : ""}
      </div>

      <div style="margin-top:10px;display:flex;align-items:center;gap:5px">
        <div style="width:4px;height:4px;border-radius:50%;background:#3b82f6;animation:trace-pulse 1.5s infinite"></div>
        <span style="color:#3b82f6;font-size:8px;letter-spacing:.05em">MemWal · Walrus</span>
      </div>
    `;

    badge.appendChild(panel);

    // Sticky hover — panel stays open with grace period so user can move mouse to it
    let hideTimer = null;
    const showPanel = () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      panel.style.display = "block";
    };
    const queueHide = () => {
      hideTimer = setTimeout(() => { panel.style.display = "none"; hideTimer = null; }, 300);
    };

    badge.addEventListener("mouseenter", showPanel);
    badge.addEventListener("mouseleave", queueHide);
    panel.addEventListener("mouseenter", showPanel);
    panel.addEventListener("mouseleave", queueHide);

    container.appendChild(badge);
  }

  async function processImage(img) {
    if (!traceEnabled) return;
    if (processed.has(img)) return;

    const { w, h } = getSize(img);
    if (w < MIN_SIZE || h < MIN_SIZE) return;

    const src = img.currentSrc || img.src || "";
    if (!src || src.startsWith("data:") || src.includes(".svg")) return;

    processed.add(img);

    // Strategy: try canvas hash first (fastest), then content fetch via background
    // (works on CSP-restricted sites), finally URL hash as last resort
    let hash = await hashImage(img);
    if (!hash) {
      // Canvas blocked — ask background to fetch and hash the actual bytes
      const src = img.currentSrc || img.src || img.getAttribute("data-src") || "";
      if (src) {
        try {
          const result = await chrome.runtime.sendMessage({
            type: "HASH_IMAGE_URL",
            imgUrl: src,
          });
          if (result?.hash) hash = result.hash;
        } catch { /* fall through */ }
      }
    }
    if (!hash) hash = await urlHash(img);
    if (!hash) return;

    // Check local cache first — if we verified this image before, show that verdict
    const cachedVerdict = verdictCache.get(hash);
    if (cachedVerdict && cachedVerdict.verdict !== "UNKNOWN") {
      injectBadge(img, cachedVerdict.verdict, cachedVerdict);
      writeBankSighting(img, cachedVerdict.verdict);
      return;
    }

    // Inject badge with last known state (or UNKNOWN as placeholder)
    injectBadge(img, cachedVerdict?.verdict || "UNKNOWN", cachedVerdict || {});
    writeBankSighting(img, "UNKNOWN");

    try {
      const result = await chrome.runtime.sendMessage({
        type: "VERIFY_HASH",
        hash,
        pageUrl: window.location.href,
        imgSrc: src,
      });

      if (result && result.verdict && result.verdict !== "ERROR") {
        // Cache verdict for next visit
        verdictCache.set(hash, result);
        chrome.storage.local.get("verdict_cache", items => {
          const cache = items.verdict_cache || {};
          cache[hash] = result;
          // Keep cache size manageable (last 500 hashes)
          const keys = Object.keys(cache);
          if (keys.length > 500) {
            keys.slice(0, keys.length - 500).forEach(k => delete cache[k]);
          }
          chrome.storage.local.set({ verdict_cache: cache });
        });

        injectBadge(img, result.verdict, result);

        if (result.verdict !== "UNKNOWN") {
          writeBankSighting(img, result.verdict);
        }
      }
    } catch { /* context invalidated */ }
  }

  function tryProcess(img) {
    const { w, h } = getSize(img);
    if (img.complete && w >= MIN_SIZE && h >= MIN_SIZE) {
      processImage(img);
    } else {
      img.addEventListener("load", () => processImage(img), { once: true });
    }
  }

  function watchLazy(img) {
    const obs = new MutationObserver(() => {
      const { w, h } = getSize(img);
      if (img.complete && w >= MIN_SIZE) { obs.disconnect(); processImage(img); }
    });
    obs.observe(img, { attributes: true, attributeFilter: ["src","srcset","data-src","data-lazy","data-original","data-bbc-width"] });
  }

  // Process video element — sample first frame to canvas
  async function processVideo(video) {
    if (!traceEnabled) return;
    if (processed.has(video)) return;
    const w = video.videoWidth || video.offsetWidth || 0;
    const h = video.videoHeight || video.offsetHeight || 0;
    if (w < MIN_SIZE || h < MIN_SIZE) return;

    processed.add(video);

    // Capture first frame as image proxy
    let hash = null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(64, w);
      canvas.height = Math.min(64, h);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const buf = await crypto.subtle.digest("SHA-256", data.buffer);
      hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
    } catch { /* canvas may be tainted */ }

    if (!hash) {
      // URL hash fallback
      const src = video.currentSrc || video.src || video.querySelector("source")?.src || "";
      if (!src) return;
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(src));
      hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
    }

    // Inject badge using same logic as images (treat video as media element)
    const cachedVerdict = verdictCache.get(hash);
    injectBadge(video, cachedVerdict?.verdict || "UNKNOWN", cachedVerdict || {});
    writeBankSighting(video, "UNKNOWN");

    try {
      const result = await chrome.runtime.sendMessage({
        type: "VERIFY_HASH",
        hash,
        pageUrl: window.location.href,
        imgSrc: video.currentSrc || video.src || "",
      });
      if (result?.verdict && result.verdict !== "ERROR") {
        verdictCache.set(hash, result);
        injectBadge(video, result.verdict, result);
      }
    } catch { /* ignore */ }
  }

  function tryProcessVideo(video) {
    const w = video.videoWidth || video.offsetWidth || 0;
    if (w >= MIN_SIZE) {
      processVideo(video);
    } else {
      video.addEventListener("loadeddata", () => processVideo(video), { once: true });
      video.addEventListener("loadedmetadata", () => processVideo(video), { once: true });
    }
  }

  let traceEnabled = true;
  chrome.storage.local.get("trace_enabled", items => {
    traceEnabled = items.trace_enabled !== false;
    if (traceEnabled) {
      document.querySelectorAll("img").forEach(img => { tryProcess(img); watchLazy(img); });
      document.querySelectorAll("video").forEach(v => tryProcessVideo(v));
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SET_ENABLED") {
      traceEnabled = msg.enabled;
      if (!traceEnabled) {
        document.querySelectorAll(".trace-badge").forEach(b => b.remove());
      } else {
        document.querySelectorAll("img").forEach(img => { tryProcess(img); watchLazy(img); });
        document.querySelectorAll("video").forEach(v => tryProcessVideo(v));
      }
    }
    // Invalidate cache when user manually verifies (refreshes verdicts on next visit)
    if (msg.type === "INVALIDATE_CACHE") {
      verdictCache.clear();
      chrome.storage.local.remove("verdict_cache");
    }
  });

  new MutationObserver(mutations => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.tagName === "IMG")        { tryProcess(node); watchLazy(node); }
        else if (node.tagName === "VIDEO") { tryProcessVideo(node); }
        else if (node.querySelectorAll) {
          node.querySelectorAll("img").forEach(img => { tryProcess(img); watchLazy(img); });
          node.querySelectorAll("video").forEach(v => tryProcessVideo(v));
        }
      });
    });
  }).observe(document.body, { childList: true, subtree: true });

})();