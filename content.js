/**
 * TRACE Extension — Content Script
 * Handles lazy-loaded images, BBC/news sites, attribute-based lazy loaders
 */
(function () {
  'use strict';

  const APP_URL = "https://www.traceprotocol.co";
  const TRACE_API = "https://trace-cbvb.onrender.com";

  const BADGES = {
    VERIFIED_ORIGINAL: { emoji: "✓",  color: "#34d399", border: "#34d399", bg: "rgba(5,46,22,0.95)",   label: "VERIFIED"   },
    MODIFIED:          { emoji: "~",  color: "#fbbf24", border: "#fbbf24", bg: "rgba(28,20,2,0.95)",   label: "MODIFIED"   },
    UNVERIFIED:        { emoji: "?",  color: "#f43f5e", border: "#f43f5e", bg: "rgba(28,1,7,0.95)",    label: "UNVERIFIED" },
    AI_GENERATED:      { emoji: "AI", color: "#a78bfa", border: "#a78bfa", bg: "rgba(18,10,30,0.95)",  label: "AI GEN"     },
    REVOKED:           { emoji: "✕",  color: "#f43f5e", border: "#f43f5e", bg: "rgba(28,1,7,0.95)",    label: "REVOKED"    },
    UNKNOWN:           { emoji: "○",  color: "#71717a", border: "#3f3f46", bg: "rgba(10,10,10,0.9)",   label: "UNKNOWN"    },
  };

  const processed = new WeakSet();
  const MIN_SIZE  = 100;

  // ── Passive bank sighting — runs for every image encountered ─────────────────
  // Defined first so it's available throughout the script
  async function writeBankSighting(img, verdict) {
    try {
      const src = img.currentSrc || img.src || "";
      if (!src || src.startsWith("data:") || src.length < 10) return;
      const msgBuffer = new TextEncoder().encode(src);
      const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
      const urlHash = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
      await fetch(TRACE_API + "/v1/bank/encounter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url_hash:  urlHash,
          source:    window.location.hostname,
          verdict:   verdict || "UNKNOWN",
          media_url: src.slice(0, 200),
        }),
      });
    } catch { /* passive — never block the badge */ }
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
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,"0")).join("");
    } catch { return null; }
  }

  function getSize(img) {
    return {
      w: img.naturalWidth  || img.width  || img.offsetWidth  || 0,
      h: img.naturalHeight || img.height || img.offsetHeight || 0,
    };
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
    if (getComputedStyle(container).position === "static") container.style.position = "relative";

    const badge = document.createElement("div");
    badge.className = "trace-badge";

    const pulse = info.bank && info.bank.contributed_to_bank
      ? '<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:#3b82f6;margin-right:4px;animation:trace-pulse 1.5s infinite"></span>'
      : "";

    badge.style.cssText = [
      "position:absolute","top:6px","right:6px","z-index:2147483647",
      "display:flex","align-items:center","gap:3px",
      "background:" + cfg.bg, "border:1px solid " + cfg.border,
      "color:" + cfg.color, "font-family:'Courier New',monospace",
      "font-size:9px","font-weight:700","letter-spacing:.1em",
      "padding:3px 7px","border-radius:3px","cursor:pointer","pointer-events:auto",
    ].join(";");
    badge.innerHTML = pulse + cfg.emoji + " " + cfg.label;
    badge.title = verdict === "UNKNOWN"
      ? "Not in TRACE registry — click to verify this media"
      : verdict === "VERIFIED_ORIGINAL" ? "Click to view provenance on TRACE"
      : verdict === "MODIFIED" ? "Click to view edit history on TRACE"
      : verdict === "AI_GENERATED" ? "AI-generated content detected"
      : cfg.label;

    if (!document.getElementById("trace-pulse-style")) {
      const style = document.createElement("style");
      style.id = "trace-pulse-style";
      style.textContent = "@keyframes trace-pulse{0%,100%{opacity:1}50%{opacity:.3}}";
      document.head.appendChild(style);
    }

    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      if (info && info.mediaId) {
        window.open(APP_URL + "/graph/" + info.mediaId, "_blank");
      } else if (verdict === "UNKNOWN") {
        window.open(APP_URL + "/verify", "_blank");
      }
    });

    const panel = document.createElement("div");
    panel.style.cssText = [
      "display:none","position:absolute","top:22px","right:0","width:320px",
      "background:#09090b","border:1px solid #27272a","border-radius:8px",
      "padding:14px","font-family:'Courier New',monospace","font-size:10px",
      "color:#a1a1aa","z-index:2147483647","box-shadow:0 8px 32px rgba(0,0,0,.9)",
    ].join(";");

    const bank = info.bank || {};
    const sightingCount = bank.sighting_count || (bank.known_to_bank ? (bank.sighting_count || 1) : 0);
    const firstSeen = bank.first_seen ? new Date(bank.first_seen).toLocaleDateString() : null;
    const sources = Array.isArray(bank.sources) ? bank.sources : [];
    const spreadVelocity = sightingCount > 10 ? "HIGH" : sightingCount > 3 ? "MEDIUM" : "LOW";
    const velocityColor = sightingCount > 10 ? "#f43f5e" : sightingCount > 3 ? "#f59e0b" : "#34d399";

    const lines = [];
    lines.push('<div style="color:#fff;font-size:11px;font-weight:700;margin-bottom:10px;letter-spacing:.05em">TRACE PROTOCOL</div>');
    lines.push('<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">');
    lines.push('<div style="width:8px;height:8px;border-radius:50%;background:' + cfg.bg.replace('0.15','1') + '"></div>');
    lines.push('<span style="color:' + cfg.color + ';font-weight:700">' + verdict.replace(/_/g," ") + '</span>');
    lines.push('</div>');
    if (info.confidence !== undefined) {
      lines.push('<div style="margin-bottom:6px"><span style="color:#52525b">Confidence: </span><span style="color:#e4e4e7">' + Math.round(info.confidence * 100) + '%</span></div>');
    }
    lines.push('<div style="border-top:1px solid #27272a;margin:8px 0"></div>');
    lines.push('<div style="color:#3b82f6;font-size:9px;letter-spacing:.1em;margin-bottom:6px">COLLECTIVE MEMORY BANK</div>');
    if (sightingCount > 0) {
      lines.push('<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px">');
      lines.push('<div style="background:#18181b;border-radius:4px;padding:6px;text-align:center"><div style="color:#fff;font-size:14px;font-weight:700">' + sightingCount + '</div><div style="color:#52525b;font-size:8px">SIGHTINGS</div></div>');
      lines.push('<div style="background:#18181b;border-radius:4px;padding:6px;text-align:center"><div style="color:#fff;font-size:9px">' + (firstSeen || "—") + '</div><div style="color:#52525b;font-size:8px">FIRST SEEN</div></div>');
      lines.push('<div style="background:#18181b;border-radius:4px;padding:6px;text-align:center"><div style="color:' + velocityColor + ';font-size:9px;font-weight:700">' + spreadVelocity + '</div><div style="color:#52525b;font-size:8px">SPREAD</div></div>');
      lines.push('</div>');
      if (sources.length > 0) {
        lines.push('<div style="margin-bottom:6px"><span style="color:#52525b">Sources: </span><span style="color:#a1a1aa">' + sources.join(", ") + '</span></div>');
      }
    } else {
      lines.push('<div style="color:#52525b;margin-bottom:8px">First encounter — sighting recorded to bank</div>');
    }
    if (info.origin || info.mediaId) {
      lines.push('<div style="border-top:1px solid #27272a;margin:8px 0"></div>');
      lines.push('<div style="color:#34d399;font-size:9px;letter-spacing:.1em;margin-bottom:6px">ON-CHAIN PROVENANCE</div>');
      if (info.origin?.creator) lines.push('<div><span style="color:#52525b">Creator: </span><span style="color:#06b6d4">' + String(info.origin.creator).slice(0,20) + "…</span></div>");
      if (info.origin?.first_seen) lines.push('<div><span style="color:#52525b">Registered: </span><span style="color:#e4e4e7">' + new Date(info.origin.first_seen).toLocaleDateString() + "</span></div>");
      if (info.provenance_chain?.length > 0) lines.push('<div><span style="color:#52525b">Chain depth: </span><span style="color:#e4e4e7">' + info.provenance_chain.length + "</span></div>");
    }
    lines.push('<div style="border-top:1px solid #27272a;margin:8px 0"></div>');
    lines.push('<div style="display:flex;gap:8px">');
    if (info.mediaId) lines.push('<a href="' + APP_URL + '/graph/' + info.mediaId + '" target="_blank" style="color:#34d399;text-decoration:none;font-size:9px">View Provenance →</a>');
    lines.push('<a href="' + APP_URL + '/bank" target="_blank" style="color:#3b82f6;text-decoration:none;font-size:9px">Memory Bank →</a>');
    lines.push('</div>');
    lines.push('<div style="margin-top:8px;display:flex;align-items:center;gap:4px">');
    lines.push('<div style="width:4px;height:4px;border-radius:50%;background:#3b82f6;animation:trace-pulse 1.5s infinite"></div>');
    lines.push('<span style="color:#3b82f6;font-size:8px">MemWal · Walrus</span>');
    lines.push('</div>');

    panel.innerHTML = lines.join("");
    badge.appendChild(panel);
    badge.addEventListener("mouseenter", () => { panel.style.display = "block"; });
    badge.addEventListener("mouseleave", () => { panel.style.display = "none"; });
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
    injectBadge(img, "UNKNOWN");

    // Write passive sighting immediately — bank grows on every page browse
    writeBankSighting(img, "UNKNOWN");

    const hash = await hashImage(img);
    if (!hash) return;

    try {
      const result = await chrome.runtime.sendMessage({
        type: "VERIFY_HASH",
        hash,
        pageUrl: window.location.href,
        imgSrc: img.currentSrc || img.src || "",
      });

      // Update bank sighting with actual verdict after API returns
      if (result?.verdict && result.verdict !== "UNKNOWN") {
        writeBankSighting(img, result.verdict);
      }

      if (result && result.verdict && result.verdict !== "ERROR") {
        injectBadge(img, result.verdict, result);

        const verdictKey = {
          VERIFIED_ORIGINAL: "verified",
          MODIFIED:          "modified",
          UNVERIFIED:        "unverified",
          AI_GENERATED:      "ai_generated",
        }[result.verdict];

        chrome.storage.local.get(
          ["verified","modified","unverified","ai_generated","recent_scans"],
          items => {
            const updated = {};
            if (verdictKey) updated[verdictKey] = (items[verdictKey] || 0) + 1;
            const scans = items.recent_scans || [];
            scans.unshift({
              verdict:   result.verdict,
              source:    new URL(window.location.href).hostname,
              url:       img.currentSrc || img.src || "",
              timestamp: Date.now(),
              bank:      result.bank || null,
            });
            updated.recent_scans = scans.slice(0, 20);
            chrome.storage.local.set(updated);
          }
        );
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

  let traceEnabled = true;
  chrome.storage.local.get("trace_enabled", items => {
    traceEnabled = items.trace_enabled !== false;
    if (traceEnabled) { document.querySelectorAll("img").forEach(img => { tryProcess(img); watchLazy(img); }); }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SET_ENABLED") {
      traceEnabled = msg.enabled;
      if (!traceEnabled) {
        document.querySelectorAll(".trace-badge").forEach(b => b.remove());
      } else {
        document.querySelectorAll("img").forEach(img => { tryProcess(img); watchLazy(img); });
      }
    }
  });

  new MutationObserver(mutations => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.tagName === "IMG") { tryProcess(node); watchLazy(node); }
        else if (node.querySelectorAll) {
          node.querySelectorAll("img").forEach(img => { tryProcess(img); watchLazy(img); });
        }
      });
    });
  }).observe(document.body, { childList: true, subtree: true });

})();