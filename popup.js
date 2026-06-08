const API_URL = "https://trace-cbvb.onrender.com";

// ── Toggle logic ──────────────────────────────────────────────────────────────
const toggle     = document.getElementById("main-toggle");
const toggleWrap = document.getElementById("toggle-wrap");
const toggleStat = document.getElementById("toggle-status");
const toggleDesc = document.getElementById("toggle-desc");
const mainContent   = document.getElementById("main-content");
const disabledOverlay = document.getElementById("disabled-overlay");

function applyToggleState(enabled) {
  if (enabled) {
    toggleWrap.className = "toggle-wrap on";
    toggleStat.className = "toggle-status on";
    toggleStat.textContent = "Protection ON";
    toggleDesc.textContent = "Scanning all media on this page";
    mainContent.style.display = "block";
    disabledOverlay.className = "disabled-overlay";
  } else {
    toggleWrap.className = "toggle-wrap off";
    toggleStat.className = "toggle-status off";
    toggleStat.textContent = "Protection OFF";
    toggleDesc.textContent = "Click to resume media scanning";
    mainContent.style.display = "none";
    disabledOverlay.className = "disabled-overlay visible";
  }
}

// Load saved toggle state
chrome.storage.local.get("trace_enabled", items => {
  const enabled = items.trace_enabled !== false; // default ON
  toggle.checked = enabled;
  applyToggleState(enabled);
});

// Handle toggle change
toggle.addEventListener("change", () => {
  const enabled = toggle.checked;
  chrome.storage.local.set({ trace_enabled: enabled });
  applyToggleState(enabled);
  // Tell content script to enable/disable
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "SET_ENABLED", enabled }).catch(() => {});
    }
  });
});

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("content-" + tab).classList.add("active");
  });
});

// ── Load stats + scans ────────────────────────────────────────────────────────
chrome.storage.local.get(["verified","modified","unverified","ai_generated","recent_scans"], items => {
  const v = items.verified     || 0;
  const m = items.modified     || 0;
  const u = items.unverified   || 0;
  const a = items.ai_generated || 0;
  const total = v + m + u + a;

  const se = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  se("today-count",    total + " scanned");
  se("stat-verified",  v);
  se("stat-modified",  m);
  se("stat-unverified",u);
  se("stat-ai",        a);

  const pct = total > 0 ? Math.round((v / total) * 100) : 0;
  se("trust-pct", pct + "%");
  const fill = document.getElementById("trust-fill");
  if (fill) fill.style.width = pct + "%";

  // Render scans
  const scanList = document.getElementById("scan-list");
  if (!scanList) return;
  const scans = items.recent_scans || [];
  if (scans.length === 0) {
    scanList.innerHTML = '<div class="empty-state">Browse any page with images<br>to start verifying</div>';
    return;
  }

  const cfg = {
    VERIFIED_ORIGINAL: { color:"#10b981", label:"Verified",     icon:"✓"  },
    MODIFIED:          { color:"#f59e0b", label:"Modified",     icon:"~"  },
    UNVERIFIED:        { color:"#ef4444", label:"Unverified",   icon:"?"  },
    AI_GENERATED:      { color:"#8b5cf6", label:"AI Generated", icon:"AI" },
    UNKNOWN:           { color:"#71717a", label:"Unknown",      icon:"○"  },
  };

  scanList.innerHTML = scans.slice(0, 10).map(s => {
    const c = cfg[s.verdict] || cfg.UNKNOWN;
    const t = s.timestamp
      ? new Date(s.timestamp).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })
      : "";
    return `<div class="scan-item">
      <div class="scan-icon" style="background:${c.color}22">
        <span style="color:${c.color};font-size:11px;font-weight:700">${c.icon}</span>
      </div>
      <div class="scan-body">
        <div class="scan-top">
          <span class="scan-source">${s.source || "Unknown"}</span>
          <span class="scan-time">${t}</span>
        </div>
        <div class="scan-url">${(s.url || "").slice(0, 42)}</div>
        <div class="scan-status" style="color:${c.color}">${c.label}</div>
      </div>
    </div>`;
  }).join("");
});

// ── Health check ──────────────────────────────────────────────────────────────
fetch(API_URL + "/v1/health")
  .then(r => r.json())
  .then(d => {
    const dot  = document.getElementById("status-dot");
    const text = document.getElementById("status-text");
    if (dot)  dot.style.background = "#10b981";
    if (text) text.textContent = "LIVE · " + (d.registered || 0) + " records on chain";
  })
  .catch(() => {
    const dot  = document.getElementById("status-dot");
    const text = document.getElementById("status-text");
    if (dot)  dot.style.background = "#f59e0b";
    if (text) text.textContent = "API unreachable";
  });