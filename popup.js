// popup.js
const $ = id => document.getElementById(id);

// ── URL List Management ────────────────────────────────────────────────────
let urls = ["https://entertainment.capitalone.com/events/5967004"];

function renderUrlList(disabled = false) {
  const list = $("urlList");
  list.innerHTML = "";
  urls.forEach((url, i) => {
    const row = document.createElement("div");
    row.className = "url-item";

    // Priority badge
    const badge = document.createElement("span");
    badge.style.cssText = "font-family:var(--mono);font-size:9px;color:" +
      (i === 0 ? "var(--accent)" : "var(--text-dim)") +
      ";min-width:18px;text-align:center;flex-shrink:0;";
    badge.textContent = i === 0 ? "P1" : `P${i + 1}`;
    badge.title = i === 0 ? "Highest priority" : `Priority ${i + 1}`;

    const input = document.createElement("input");
    input.type = "text";
    input.value = url;
    input.placeholder = "https://entertainment.capitalone.com/events/...";
    input.disabled = disabled;
    input.addEventListener("change", () => { urls[i] = input.value.trim(); saveUrlsToStorage(); });
    input.addEventListener("input", () => { urls[i] = input.value.trim(); saveUrlsToStorage(); });

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove-url";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove";
    removeBtn.disabled = disabled || urls.length <= 1;
    removeBtn.addEventListener("click", () => {
      urls.splice(i, 1);
      saveUrlsToStorage();
      renderUrlList(disabled);
    });

    row.appendChild(badge);
    row.appendChild(input);
    row.appendChild(removeBtn);
    list.appendChild(row);
  });
}

// ── Persist URL list to storage immediately on any change ─────────────────
function saveUrlsToStorage() {
  const clean = urls.filter(u => u.trim().length > 0);
  chrome.storage.local.set({ savedUrls: clean });
}

$("btnAddUrl").addEventListener("click", () => {
  urls.push("");
  renderUrlList(false);
  saveUrlsToStorage();
  // Focus the new input
  const inputs = $("urlList").querySelectorAll("input");
  inputs[inputs.length - 1].focus();
});

// ── Load defaults.json, then layer saved config on top ────────────────────
// defaults.json acts like a .env.local — edit it to pre-fill URLs, credentials, etc.
// Saved config (from previous sessions) always takes priority over defaults.
let loadedDefaults = {}; // accessible to start handler for TEST_MODE etc.

async function loadConfig() {
  // 1. Load defaults.json from extension bundle
  let defaults = {};
  try {
    const resp = await fetch(chrome.runtime.getURL("defaults.json"));
    defaults = await resp.json();
  } catch(e) {
    console.log("[TicketBot] No defaults.json found or parse error — using built-in defaults");
  }
  loadedDefaults = defaults;

  // 2. Load saved config from storage
  const { botConfig, savedUrls } = await chrome.storage.local.get(["botConfig", "savedUrls"]);

  // 3. URL list: savedUrls > botConfig > defaults.json > hardcoded fallback
  if (savedUrls && savedUrls.length) {
    urls = savedUrls;
  } else if (botConfig?.TARGET_URLS?.length) {
    urls = botConfig.TARGET_URLS;
  } else if (botConfig?.TARGET_URL) {
    urls = [botConfig.TARGET_URL];
  } else if (defaults.TARGET_URLS?.length) {
    urls = defaults.TARGET_URLS;
  }

  // 4. Settings: saved > defaults > hardcoded
  $("pollInterval").value = botConfig?.POLL_INTERVAL_MINUTES || defaults.POLL_INTERVAL_MINUTES || 5;
  $("minTickets").value = botConfig?.MIN_TICKETS || defaults.MIN_TICKETS || 2;
  $("desiredQty").value = botConfig?.DESIRED_QUANTITY || defaults.DESIRED_QUANTITY || 4;
  $("confirmOrder").checked = botConfig?.CONFIRM_ORDER === true || defaults.CONFIRM_ORDER === true;
  $("testMode").checked = botConfig?.TEST_MODE !== undefined ? botConfig.TEST_MODE : (defaults.TEST_MODE !== false);
  $("ntfyTopic").value = botConfig?.NTFY_TOPIC || defaults.NTFY_TOPIC || "";

  // Session notify toggle: default ON
  const { sessionNotify } = await chrome.storage.local.get("sessionNotify");
  $("sessionNotify").checked = sessionNotify !== false;

  renderUrlList(false);

  // 5. Credentials: session storage > defaults.json
  // Session storage is ephemeral (cleared on browser restart) so defaults.json
  // provides a convenient way to pre-fill credentials for development.
  const { loginCredentials } = await chrome.storage.session.get("loginCredentials");
  $("loginUsername").value = loginCredentials?.username || defaults.LOGIN_USERNAME || "";
  $("loginPassword").value = loginCredentials?.password || defaults.LOGIN_PASSWORD || "";

  // If defaults.json had credentials but session storage didn't, seed session
  // storage so background.js can access them immediately on first start.
  if (!loginCredentials && (defaults.LOGIN_USERNAME || defaults.LOGIN_PASSWORD)) {
    chrome.storage.session.set({
      loginCredentials: {
        username: defaults.LOGIN_USERNAME || "",
        password: defaults.LOGIN_PASSWORD || ""
      }
    });
  }
}

loadConfig();

// ── Session Notify toggle persistence ─────────────────────────────────────
$("sessionNotify").addEventListener("change", () => {
  chrome.storage.local.set({ sessionNotify: $("sessionNotify").checked });
});


// ── Log ────────────────────────────────────────────────────────────────────
const logLines = [];

function addLog(msg, type = "") {
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  logLines.push({ ts, msg, type });
  if (logLines.length > 50) logLines.shift();
  renderLog();
}

function renderLog() {
  const box = $("logBox");
  box.textContent = "";
  for (const l of logLines) {
    const div = document.createElement("div");
    div.className = "log-line" + (l.type ? " " + l.type : "");
    div.textContent = `[${l.ts}] ${l.msg}`;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

// ── Status Update ──────────────────────────────────────────────────────────
function applyStatus(data) {
  const pill = $("statusPill");
  const dot = $("statusDot");
  const text = $("statusText");
  const scan = $("scanLine");
  const isActive = !!data.active;

  pill.className = "status-pill " + (data.status || "idle");
  const labels = { idle: "Idle", monitoring: "Monitoring", found: "Found!", error: "Error" };
  text.textContent = labels[data.status] || "Idle";
  dot.className = "dot" + (data.status === "monitoring" ? " pulse" : "");
  scan.className = "scan-line" + (data.status === "monitoring" ? " active" : "");

  if (data.checkCount) $("checkCount").textContent = `${data.checkCount} checks`;

  // Enable/disable controls
  $("btnStart").disabled = isActive;
  $("btnStop").disabled = !isActive;
  $("btnAddUrl").disabled = isActive;
  $("pollInterval").disabled = isActive;
  $("minTickets").disabled = isActive;
  $("desiredQty").disabled = isActive;
  $("confirmOrder").disabled = isActive;
  $("testMode").disabled = isActive;
  $("ntfyTopic").disabled = isActive;
  $("sessionNotify").disabled = false; // always editable, even while running
  $("loginUsername").disabled = isActive;
  $("loginPassword").disabled = isActive;
  renderUrlList(isActive);

  if (data.found) {
    const banner = $("foundBanner");
    banner.classList.add("visible");
    const eventId = data.url ? data.url.split('/').pop() : "";
    $("foundDetail").textContent =
      `${eventId ? "Event " + eventId + " — " : ""}${data.section || ""} ${data.row || ""} — ${data.price || ""}`;
  }

  if (data.lastResult) addLog(data.lastResult, data.logType || "");
  if (data.error) addLog("Error: " + data.error, "err");
}

// ── Start Bot ──────────────────────────────────────────────────────────────
$("btnStart").addEventListener("click", () => {
  // Collect and validate URLs
  const validUrls = urls.map(u => u.trim()).filter(u => u.startsWith("https://"));
  if (!validUrls.length) {
    addLog("Add at least one valid https:// URL.", "err");
    return;
  }

  const username = $("loginUsername").value.trim();
  const password = $("loginPassword").value;
  if (username || password) {
    // Use session storage — credentials are never written to local storage
    chrome.storage.session.set({ loginCredentials: { username, password } });
  }

  const config = {
    TARGET_URLS: validUrls,
    TARGET_URL: validUrls[0], // backwards compat
    POLL_INTERVAL_MINUTES: Math.max(1, parseInt($("pollInterval").value) || 5),
    MIN_TICKETS: Math.max(1, parseInt($("minTickets").value) || 2),
    DESIRED_QUANTITY: Math.max(1, parseInt($("desiredQty").value) || 4),
    CONFIRM_ORDER: $("confirmOrder").checked,
    TEST_MODE: $("testMode").checked,
    NTFY_TOPIC: $("ntfyTopic").value.trim(),
    PLAY_SOUND: true
    // No LOGIN_USERNAME / LOGIN_PASSWORD — background reads from session storage
  };

  $("foundBanner").classList.remove("visible");
  addLog(`Starting bot → monitoring ${validUrls.length} URL(s)`);
  validUrls.forEach(u => addLog(`  • ${u}`));
  addLog(`Checking every ${config.POLL_INTERVAL_MINUTES} min, need ${config.MIN_TICKETS}+ tickets`);

  chrome.runtime.sendMessage({ type: "START_BOT", config }, () => {
    applyStatus({ active: true, status: "monitoring", checkCount: 0 });
  });
});

// ── Stop Bot ───────────────────────────────────────────────────────────────
$("btnStop").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_BOT" }, () => {
    addLog("Bot stopped by user.", "warn");
    applyStatus({ active: false, status: "idle" });
  });
});

// ── Listen for Updates ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATUS_UPDATE") {
    applyStatus(msg);
    if (msg.found) {
      addLog(`🎟️ TICKETS FOUND! ${msg.section} ${msg.row} — ${msg.price}`, "success");
    }
  }
});

// ── Fetch current state on open ────────────────────────────────────────────
chrome.runtime.sendMessage({ type: "GET_STATUS" }, (resp) => {
  if (resp) {
    applyStatus(resp);
    if (resp.active) addLog(`Bot is running (${resp.checkCount || 0} checks so far)`);
  }
});
