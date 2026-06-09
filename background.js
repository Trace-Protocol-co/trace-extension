/**
 * TRACE Extension — Background Service Worker
 */
const API_URL = "https://trace-cbvb.onrender.com";
const cache   = new Map();
const TTL     = 5 * 60 * 1000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SET_ENABLED") {
    chrome.storage.local.set({ trace_enabled: message.enabled });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "VERIFY_HASH") {
    handleVerify(message.hash, message.pageUrl, message.imgSrc).then(sendResponse);
    return true;
  }

  if (message.type === "HEALTH_CHECK") {
    fetch(API_URL + "/v1/health")
      .then(r => r.json())
      .then(d => sendResponse({ ok: true, registered: d.registered || 0 }))
      .catch(e => { console.error("Health check failed:", e); sendResponse({ ok: false }); });
    return true;
  }

  // Passive bank encounter — routes through background to bypass page CSP
  // News sites (BBC, Guardian) block fetch from content scripts
  // Background service workers are NOT subject to page CSP
  if (message.type === "BANK_ENCOUNTER") {
    fetch(API_URL + "/v1/bank/encounter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url_hash:  message.url_hash,
        source:    message.source,
        verdict:   message.verdict || "UNKNOWN",
        media_url: message.media_url,
      }),
    }).catch(() => {}); // passive — never fail
    return true;
  }
});

async function handleVerify(hash, pageUrl, imgSrc) {
  const cacheKey = hash + (imgSrc || "");
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;

  try {
    const res  = await fetch(API_URL + "/v1/search?hash=" + hash);
    const data = await res.json();

    let result;
    if (data && data.mediaId) {
      const verdict = toVerdict(data.integrity, data.revoked);
      result = { found: true, verdict, mediaId: data.mediaId, creator: data.creator,
        timestamp: data.timestamp, description: data.description };
    } else {
      result = { found: false, verdict: "UNKNOWN" };
    }

    cache.set(cacheKey, { data: result, ts: Date.now() });

    const key = {
      VERIFIED_ORIGINAL: "verified", MODIFIED: "modified",
      AI_GENERATED: "ai_generated", UNVERIFIED: "unverified",
      UNKNOWN: "unverified",
    }[result.verdict];

    // Always write to recent_scans regardless of verdict
    chrome.storage.local.get(["verified","modified","unverified","ai_generated","recent_scans"], items => {
      const updated = {};
      if (key) updated[key] = (items[key] || 0) + 1;
      const scans = items.recent_scans || [];
      scans.unshift({
        hash, verdict: result.verdict,
        url: pageUrl || "",
        source: pageUrl ? new URL(pageUrl).hostname : "Unknown",
        timestamp: Date.now(),
        mediaId: result.mediaId,
      });
      updated.recent_scans = scans.slice(0, 20);
      chrome.storage.local.set(updated);
    });
    return result;
  } catch(e) {
    console.error("Verify failed:", e);
    return { found: false, verdict: "ERROR" };
  }
}

function toVerdict(integrity, revoked) {
  if (revoked) return "REVOKED";
  return ["VERIFIED_ORIGINAL","MODIFIED","UNVERIFIED","AI_GENERATED"][integrity] || "UNKNOWN";
}