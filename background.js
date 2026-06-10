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
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

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
    }).catch(() => {});
    return true;
  }

  // Fetch image bytes and compute content hash — bypasses canvas CSP restrictions
  if (message.type === "HASH_IMAGE_URL") {
    fetchAndHashImage(message.imgUrl).then(hash => sendResponse({ hash }));
    return true;
  }

});

async function fetchAndHashImage(url) {
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const hashBuf = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

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
      result = {
        found: true, verdict,
        mediaId: data.mediaId,
        creator: data.creator,
        timestamp: data.timestamp,
        description: data.description,
      };
    } else {
      result = { found: false, verdict: "UNKNOWN" };
    }

    cache.set(cacheKey, { data: result, ts: Date.now() });

    // Always write to recent scans — including UNKNOWN
    const source = pageUrl ? new URL(pageUrl).hostname : "Unknown";
    chrome.storage.local.get(["verified","modified","unverified","ai_generated","recent_scans"], items => {
      const updated = {};

      // Increment the right counter
      if (result.verdict === "VERIFIED_ORIGINAL") updated.verified    = (items.verified    || 0) + 1;
      if (result.verdict === "MODIFIED")          updated.modified    = (items.modified    || 0) + 1;
      if (result.verdict === "UNVERIFIED")        updated.unverified  = (items.unverified  || 0) + 1;
      if (result.verdict === "AI_GENERATED")      updated.ai_generated = (items.ai_generated || 0) + 1;
      if (result.verdict === "UNKNOWN")           updated.unverified  = (items.unverified  || 0) + 1;

      // Add to recent scans
      const scans = items.recent_scans || [];
      scans.unshift({
        hash,
        verdict:   result.verdict,
        url:       pageUrl || "",
        source,
        timestamp: Date.now(),
        mediaId:   result.mediaId || null,
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