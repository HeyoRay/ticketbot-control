// ── background.js — Ticket Bot Service Worker ──────────────────────────────

let botActive = false;
let lastStatus = "idle";
let checkCount = 0;
let urlTabMap = {};
let checkoutLock = false; // prevents two tabs from entering checkout simultaneously
let checkInProgress = false; // prevents runCheck re-entry (stops tab reloads during checkout)
let loginOccurredThisCycle = false; // set by runLogin; tells runCheck to refresh later tabs
let stopRequested = false; // set by ntfy "stop" command — checked each cycle
let activeEmergencyReceipt = null; // tracks the Pushover emergency receipt so we can cancel it

// ── Logging ────────────────────────────────────────────────────────────────
function log(msg, type = "") {
  console.log("[TicketBot]", msg);
  broadcastStatus({ lastResult: msg, logType: type });
}

function broadcastStatus(data) {
  chrome.runtime.sendMessage({ type: "STATUS_UPDATE", ...data }).catch(() => {});
}

// ── Pushover Push Notifications ───────────────────────────────────────────
let pushoverUser = "";
let pushoverToken = "";

async function loadPushoverConfig() {
  try {
    const resp = await fetch(chrome.runtime.getURL("defaults.json"));
    const defaults = await resp.json();
    if (defaults.PUSHOVER_USER && defaults.PUSHOVER_TOKEN) {
      pushoverUser = defaults.PUSHOVER_USER;
      pushoverToken = defaults.PUSHOVER_TOKEN;
      log(`📱 Pushover loaded (user=${pushoverUser.substring(0, 6)}...)`);
    }
  } catch(e) {
    log("⚠️ Could not load Pushover config from defaults.json");
  }
}

// Send a standard Pushover notification.
// priority: -2 (silent) to 2 (emergency). Default 1 (high).
async function sendPushoverAlert(title, message, url, priority = 1) {
  if (!pushoverUser || !pushoverToken) return;
  try {
    const body = new URLSearchParams({
      token: pushoverToken,
      user: pushoverUser,
      title,
      message,
      priority: String(priority),
      sound: priority >= 1 ? "cashregister" : "pushover"
    });
    if (url) body.set("url", url);
    if (url) body.set("url_title", "Open Event");
    // Emergency priority requires retry + expire params
    if (priority === 2) {
      body.set("retry", "30");   // re-notify every 30s
      body.set("expire", "300"); // stop after 5 min
    }
    const resp = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      body
    });
    const data = await resp.json();
    if (data.status === 1) {
      log("📱 Pushover notification sent!");
      return data.receipt || null; // receipt only for emergency priority
    } else {
      log(`⚠️ Pushover error: ${JSON.stringify(data.errors)}`, "warn");
      return null;
    }
  } catch(e) {
    log(`⚠️ Pushover send failed: ${e.message}`, "warn");
    return null;
  }
}

// Cancel an active Pushover emergency notification (stops the repeated buzzing)
async function cancelPushoverEmergency() {
  if (!activeEmergencyReceipt || !pushoverToken) return;
  const receipt = activeEmergencyReceipt;
  activeEmergencyReceipt = null;
  try {
    const resp = await fetch(
      `https://api.pushover.net/1/receipts/${receipt}/cancel.json`,
      { method: "POST", body: new URLSearchParams({ token: pushoverToken }) }
    );
    const data = await resp.json();
    if (data.status === 1) {
      log("📱 Pushover emergency notification cancelled.");
    } else {
      log(`⚠️ Pushover cancel error: ${JSON.stringify(data)}`, "warn");
    }
  } catch(e) {
    log(`⚠️ Pushover cancel failed: ${e.message}`, "warn");
  }
}

// Send an emergency notification and poll the receipt API until acknowledged.
// Returns "confirm" if user acknowledges, "skip"/"timeout" if expired.
// Emergency notifications keep buzzing every 30s until the user taps to acknowledge.
async function sendPushoverPrompt(title, message, timeoutMs = 180000) {
  if (!pushoverUser || !pushoverToken) return null;

  const receipt = await sendPushoverAlert(title, message, null, 2);
  if (!receipt) {
    log("⚠️ No receipt from Pushover emergency notification — cannot poll for ack.");
    return null;
  }
  log(`📱 Pushover emergency sent (receipt=${receipt}) — waiting for acknowledgement...`);

  // Poll receipt API. Keepalive the service worker each iteration.
  const pollInterval = 5000;
  const start = Date.now();
  chrome.alarms.create("pushoverKeepAlive", { periodInMinutes: 0.4 });

  while (Date.now() - start < timeoutMs) {
    try {
      await chrome.storage.session.get("_keepalive"); // keep service worker alive

      const resp = await fetch(
        `https://api.pushover.net/1/receipts/${receipt}.json?token=${pushoverToken}`
      );
      const data = await resp.json();

      if (data.acknowledged === 1) {
        log(`📱 Pushover acknowledged! User confirmed.`);
        chrome.alarms.clear("pushoverKeepAlive");
        return "confirm";
      }
      if (data.expired === 1) {
        log(`📱 Pushover emergency expired — user did not acknowledge.`);
        chrome.alarms.clear("pushoverKeepAlive");
        return "skip";
      }
    } catch(e) {
      log(`⚠️ Pushover receipt poll error: ${e.message}`, "warn");
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }

  chrome.alarms.clear("pushoverKeepAlive");
  log("📱 Pushover prompt timed out.");
  return null;
}

// Load config on startup
loadPushoverConfig();

// ── ntfy.sh Command Channel ──────────────────────────────────────────────
// ntfy.sh is used purely as hidden infrastructure — a free message pipe
// between the phone control page and this extension. No ntfy app needed.
let ntfyTopic = "";
let ntfyPin = "";
let controlPageUrl = ""; // public URL where control.html is hosted

async function loadNtfyConfig() {
  try {
    const resp = await fetch(chrome.runtime.getURL("defaults.json"));
    const defaults = await resp.json();
    ntfyTopic = defaults.NTFY_TOPIC || "";
    ntfyPin = defaults.NTFY_PIN || "";
    controlPageUrl = defaults.CONTROL_PAGE_URL || "";
    if (ntfyTopic) log(`📡 ntfy topic loaded: ${ntfyTopic}`);
    if (controlPageUrl) log(`🌐 Control page: ${controlPageUrl}`);
  } catch(e) {
    log("⚠️ Could not load ntfy config from defaults.json");
  }
}
loadNtfyConfig();

// Drain any stale messages from the ntfy topic so the bot starts clean.
// Called before we start polling for a fresh command.
// This just discards everything — stop detection is handled by the BG poller
// and the runCheck preamble using timestamp-based polling (not since=all).
async function drainNtfyTopic(topic) {
  try {
    const resp = await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=all`, {
      headers: { Accept: "application/x-ndjson" }
    });
    if (resp.ok) {
      const text = await resp.text();
      const count = text.trim().split("\n").filter(Boolean).length;
      if (count > 0) log(`📡 Drained ${count} stale ntfy message(s)`);
    }
  } catch(e) { /* ignore */ }
}

// Poll ntfy topic for a command (confirm / skip / stop).
// Returns the first valid command received, or null on timeout.
async function pollNtfyCommand(topic, expectedPin, timeoutMs = 180000) {
  if (!topic) {
    log("⚠️ No ntfy topic configured — cannot poll for commands.");
    return null;
  }

  if (stopRequested) {
    return "stop";
  }

  // Use ntfyBgSinceTime as our starting point — the BG poller has already
  // advanced past any old messages (confirm/skip from previous checkouts).
  // This ensures we DON'T miss a "stop" sent from the direct-access page
  // during checkout steps 1-6 (drainNtfyTopic used to wipe those).
  const sinceTime = ntfyBgSinceTime || Math.floor(Date.now() / 1000);
  const pollInterval = 3000; // check every 3s
  const start = Date.now();
  const validCommands = ["confirm", "skip", "stop"];

  // Keep service worker alive during polling
  chrome.alarms.create("ntfyKeepAlive", { periodInMinutes: 0.4 });

  log(`📡 Polling ntfy.sh/${topic} for command (${Math.round(timeoutMs/1000)}s timeout)...`);

  while (Date.now() - start < timeoutMs) {
    if (!botActive || stopRequested) {
      chrome.alarms.clear("ntfyKeepAlive");
      return "stop";
    }

    try {
      await chrome.storage.session.get("_keepalive"); // reset idle timer

      const resp = await fetch(
        `https://ntfy.sh/${topic}/json?poll=1&since=${sinceTime}`,
        { headers: { Accept: "application/x-ndjson" } }
      );
      if (resp.ok) {
        const text = await resp.text();
        const lines = text.trim().split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            const raw = (msg.message || "").trim();

            // Messages arrive as "command:PIN" — split and verify
            const colonIdx = raw.indexOf(":");
            if (colonIdx === -1) continue; // no PIN separator, ignore

            const cmd = raw.substring(0, colonIdx).toLowerCase();
            const pin = raw.substring(colonIdx + 1);

            if (!validCommands.includes(cmd)) continue;

            if (expectedPin && pin !== expectedPin) {
              log(`⚠️ ntfy command "${cmd}" rejected — invalid PIN.`, "warn");
              continue;
            }

            log(`📡 ntfy command received: "${cmd}" (PIN verified ✓)`);
            chrome.alarms.clear("ntfyKeepAlive");
            ntfyBgSinceTime = Math.floor(Date.now() / 1000);
            return cmd;
          } catch(e) { /* skip malformed lines */ }
        }
      }
    } catch(e) {
      log(`⚠️ ntfy poll error: ${e.message}`, "warn");
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  chrome.alarms.clear("ntfyKeepAlive");
  // Advance the global since-time so the BG poller and next checkout poll
  // start fresh and don't re-read messages from this checkout session.
  ntfyBgSinceTime = Math.floor(Date.now() / 1000);
  log("📡 ntfy poll timed out — no command received.");
  return null;
}

// ── Quick stop-check — lightweight ntfy poll for "stop" only ────────────────
// Call this at key checkpoints throughout checkout to catch stop commands fast.
// Returns true if stop found, false otherwise. ~100ms per call.
async function quickStopCheck() {
  if (!ntfyTopic || !botActive || stopRequested) return stopRequested;
  try {
    const resp = await fetch(
      `https://ntfy.sh/${ntfyTopic}/json?poll=1&since=${ntfyBgSinceTime}`,
      { headers: { Accept: "application/x-ndjson" } }
    );
    if (!resp.ok) return false;
    const text = await resp.text();
    const lines = text.trim().split("\n").filter(Boolean);
    // Advance since-time so we don't re-read
    if (lines.length > 0) ntfyBgSinceTime = Math.floor(Date.now() / 1000);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.event === "open") continue;
        const raw = (msg.message || "").trim();
        const ci = raw.indexOf(":");
        if (ci === -1) continue;
        const cmd = raw.substring(0, ci).toLowerCase();
        const pin = raw.substring(ci + 1);
        if (ntfyPin && pin !== ntfyPin) continue;
        if (cmd === "stop") {
          log("🛑 STOP command caught mid-checkout — shutting down bot.");
          sendPushoverAlert("🛑 Bot Stopped", "Stop command received. Bot is shutting down.");
          stopRequested = true;
          stopBot();
          return true;
        }
      } catch(e) {}
    }
  } catch(e) {}
  return false;
}

// Build the control page URL with order details + PIN as query params
function buildControlUrl(orderSummary, eventUrl, pin) {
  const topic = ntfyTopic;
  if (!controlPageUrl || !topic) return "";
  const p = new URLSearchParams({
    topic,
    order: orderSummary || "Order ready",
    event: eventUrl || ""
  });
  if (pin) p.set("pin", pin);
  return `${controlPageUrl}?${p.toString()}`;
}

// ── Tab helpers ────────────────────────────────────────────────────────────
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise(resolve => {
    const _waitStart = Date.now();
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    // Safety timeout — if tab never fires "complete", resolve anyway so
    // checkInProgress doesn't stay locked forever.
    const timer = setTimeout(() => {
      if (!settled) {
        log(`⏱️ waitForTabLoad(tabId=${tabId}): TIMEOUT after ${timeoutMs}ms — resolving to prevent lockout`, "warn");
        finish("timeout");
      }
    }, timeoutMs);

    // Check current status first — tab may already be complete before listener attaches
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        log(`⏱️ waitForTabLoad(tabId=${tabId}): tab not found — resolving immediately`);
        finish("not_found"); return;
      }
      if (tab.status === "complete") {
        log(`⏱️ waitForTabLoad(tabId=${tabId}): already complete — 0ms`);
        finish("already_complete"); return;
      }
      log(`⏱️ waitForTabLoad(tabId=${tabId}): tab status="${tab.status}" — attaching listener...`);
      chrome.tabs.onUpdated.addListener(function listener(tid, info) {
        if (tid === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          log(`⏱️ waitForTabLoad(tabId=${tabId}): resolved after ${Date.now() - _waitStart}ms`);
          finish("complete");
        }
      });
    });
  });
}

async function openTabForUrl(url) {
  const existing = await chrome.tabs.query({ url: url + "*" });
  if (existing.length > 0) {
    urlTabMap[url] = existing[0].id;
    log(`🔄 Tab reused for ${url.split('/').pop()} — tabId=${existing[0].id}, existingUrl=${existing[0].url}`);
  } else {
    const tab = await chrome.tabs.create({ url, active: false });
    urlTabMap[url] = tab.id;
    log(`🔄 New tab created for ${url.split('/').pop()} — tabId=${tab.id}, url=${url}`);
    await waitForTabLoad(tab.id);
  }
  log(`🔄 urlTabMap mapped: ${url.split('/').pop()} → tabId=${urlTabMap[url]}`);
}

// ── waitForSelector — injected into page, polls DOM until element appears ──
// Returns { found: true, error: null } or { found: false, error: "..." }
async function waitForSelector(tabId, selector, timeoutMs = 15000) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, timeout) => {
      return new Promise(resolve => {
        const start = Date.now();
        const interval = 200;
        const check = () => {
          try {
            const el = document.querySelector(sel);
            if (el) return resolve({ found: true, error: null });
            if (Date.now() - start >= timeout) {
              return resolve({ found: false, error: `Timed out after ${timeout}ms waiting for: ${sel}` });
            }
            setTimeout(check, interval);
          } catch(e) {
            resolve({ found: false, error: `Error while waiting for ${sel}: ${e.message}` });
          }
        };
        check();
      });
    },
    args: [selector, timeoutMs]
  });
  return results[0]?.result || { found: false, error: "Script injection failed" };
}

// ── Wait for card recognition ──────────────────────────────────────────────
// After a post-login redirect the site needs time to associate the session with
// the user's Capital One card before ticket tier eligibility is determined.
// Clicking a listing card too early causes "Card not eligible" even for valid cards.
// This helper polls for signals that the card has been recognized, then adds a
// short extra settle before returning so the UI state is stable.
// Returns true once recognized (or after timeout), false only on injection error.
async function waitForCardRecognition(tabId, timeoutMs = 6000) {
  log("Waiting for card recognition before clicking listing...");
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (timeout) => {
      return new Promise(resolve => {
        const start = Date.now();
        const check = () => {
          try {
            // Signal 1: "CARDHOLDER EXCLUSIVE" badge — only appears when the site
            //           knows which card the user has and it's eligible.
            const cardholderBadge = Array.from(document.querySelectorAll('*')).find(
              el => el.childElementCount === 0 && /cardholder exclusive/i.test(el.textContent.trim())
            );
            if (cardholderBadge) return resolve({ recognized: true, signal: 'cardholder_badge' });

            // Signal 2: A card selector or card indicator element is present.
            if (document.querySelector('[class*="_cardSelector_"], [class*="_cardIndicator_"], [class*="_selectedCard_"]')) {
              return resolve({ recognized: true, signal: 'card_selector' });
            }

            // Signal 3: The URL contains selectedCardIndex — the site appended it.
            if (window.location.search.includes('selectedCardIndex')) {
              return resolve({ recognized: true, signal: 'url_param' });
            }

            if (Date.now() - start >= timeout) {
              // Timed out — proceed anyway with a warning; the listing click may still work.
              return resolve({ recognized: false, signal: 'timeout' });
            }
            setTimeout(check, 300);
          } catch(e) {
            resolve({ recognized: false, signal: 'error', error: e.message });
          }
        };
        check();
      });
    },
    args: [timeoutMs]
  });
  const r = result[0]?.result || { recognized: false, signal: 'injection_error' };
  if (r.recognized) {
    log(`✅ Card recognized (signal: ${r.signal}) — proceeding.`);
  } else {
    log(`⚠️ Card recognition timed out (signal: ${r.signal}) — proceeding anyway after extended settle.`);
    // Extra settle when recognition signals never appeared — give the site more time.
    await new Promise(res => setTimeout(res, 2000));
  }
  return true;
}

// ── Checkout modal helper — select qty and click "Go to Checkout" ──────────
// Extracted to avoid copy-pasting this block in 3 different places in runCheckout.
async function clickQtyAndCheckout(tabId, desiredQty) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (desiredQty) => {
      try {
        const modal = document.querySelector('[role="dialog"]');
        if (!modal) return { success: false, error: "Modal not found" };
        const qtySelect = modal.querySelector('select[aria-label*="quantity" i]') ||
                          modal.querySelector('select[class*="Dropdown"]') ||
                          modal.querySelector('select');
        if (qtySelect) {
          const options = Array.from(qtySelect.options);
          const targetOption = options.find(o => parseInt(o.value) === desiredQty);
          const pick = targetOption || options.reduce((p, c) =>
            parseInt(c.value) > parseInt(p.value) ? c : p
          );
          console.log(`[TicketBot] 🔍 Qty dropdown: options=[${options.map(o => o.value).join(', ')}], desired=${desiredQty}, picking=${pick.value}${!targetOption ? ' (exact not found — using max available)' : ' (exact match)'}`);
          // Use native setter so React's internal state tracking picks up the change
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
          if (nativeSetter) {
            nativeSetter.call(qtySelect, pick.value);
          } else {
            qtySelect.value = pick.value;
          }
          qtySelect.dispatchEvent(new Event('input', { bubbles: true }));
          qtySelect.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          console.log('[TicketBot] ⚠️ No qty dropdown found in modal');
        }
        return new Promise(resolve => {
          setTimeout(() => {
            try {
              // Search inside modal first, then fall back to full document.
              // On Capital One Entertainment the "Go to checkout" button is
              // sometimes rendered outside the [role="dialog"] wrapper in a
              // sticky panel, so we must not limit the search to modal children.
              const checkoutBtn =
                modal.querySelector('button[class*="_checkoutButton_"]') ||
                Array.from(modal.querySelectorAll('button')).find(
                  b => /go to checkout/i.test(b.textContent.trim())
                ) ||
                Array.from(modal.querySelectorAll('button')).find(
                  b => b.textContent.trim().toLowerCase().includes('checkout')
                ) ||
                // Document-wide fallback — button may sit outside the dialog
                document.querySelector('button[class*="_checkoutButton_"]') ||
                Array.from(document.querySelectorAll('button')).find(
                  b => /go to checkout/i.test(b.textContent.trim())
                );
              if (checkoutBtn) {
                const _matchMethod = checkoutBtn.className?.includes('_checkoutButton_') ? 'class match (_checkoutButton_)' : /go to checkout/i.test(checkoutBtn.textContent) ? 'text match (go to checkout)' : 'text match (checkout)';
                const isDisabled = checkoutBtn.disabled || checkoutBtn.getAttribute('aria-disabled') === 'true';
                console.log(`[TicketBot] ✅ Found 'Go to checkout' button via ${_matchMethod} — disabled=${isDisabled} — clicking with full mouse event sequence`);
                checkoutBtn.scrollIntoView({ block: 'center' });
                // Full mouse event sequence so React's synthetic event system picks it up
                const rect = checkoutBtn.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const eventOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
                checkoutBtn.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
                checkoutBtn.dispatchEvent(new MouseEvent('mousedown', eventOpts));
                checkoutBtn.dispatchEvent(new PointerEvent('pointerup', eventOpts));
                checkoutBtn.dispatchEvent(new MouseEvent('mouseup', eventOpts));
                checkoutBtn.dispatchEvent(new MouseEvent('click', eventOpts));
                resolve({ success: true, qty: qtySelect ? qtySelect.value : "unknown", btnText: checkoutBtn.textContent.trim() });
              } else {
                console.log('[TicketBot] ❌ Checkout button not found in modal or document');
                resolve({ success: false, error: "Checkout button not found in modal or document" });
              }
            } catch(e) {
              resolve({ success: false, error: e.message });
            }
          }, 800);
        });
      } catch(e) {
        return { success: false, error: e.message };
      }
    },
    args: [desiredQty]
  });
  return result[0]?.result || { success: false, error: "Script injection failed" };
}

// ── waitForModalContent — determines if a dialog is CNE or checkout ────────
// Polls the [role="dialog"] content until it can identify the modal type.
// Returns { type: 'card_not_eligible' | 'checkout' | 'unknown' }
async function waitForModalContent(tabId, timeoutMs = 5000) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (timeout) => {
      return new Promise(resolve => {
        const start = Date.now();
        const check = () => {
          try {
            const dialog = document.querySelector('[role="dialog"]');
            if (!dialog) return resolve({ type: 'no_dialog' });

            // Check for CNE text or class
            if (/card not eligible/i.test(dialog.textContent) ||
                dialog.querySelector('[class*="_limitedAccessModal"]')) {
              return resolve({ type: 'card_not_eligible' });
            }

            // Check for checkout modal indicators (qty dropdown or checkout button)
            const hasSelect = dialog.querySelector('select');
            const hasCheckoutBtn =
              dialog.querySelector('button[class*="_checkoutButton_"]') ||
              Array.from(dialog.querySelectorAll('button')).find(
                b => /go to checkout|checkout/i.test(b.textContent.trim())
              );
            if (hasSelect || hasCheckoutBtn) {
              return resolve({ type: 'checkout' });
            }

            if (Date.now() - start >= timeout) {
              return resolve({ type: 'timeout' });
            }
            setTimeout(check, 300);
          } catch(e) {
            resolve({ type: 'error', error: e.message });
          }
        };
        check();
      });
    },
    args: [timeoutMs]
  });
  return result[0]?.result || { type: 'error', error: 'injection_failed' };
}

// ── "Card not eligible" popup dismissal ────────────────────────────────────
// Checks for the Capital One "Card not eligible" modal using multiple strategies
// (text content, partial class names) so it survives CSS-module hash changes.
// Dismisses via "Return to tickets" button or the X close button.
// Returns { found: true } if the popup was present (and dismissed), { found: false } otherwise.
async function dismissCardNotEligible(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Strategy 1: look for a dialog containing "Card not eligible" text
      // Strategy 2: look for the limitedAccessModalContent partial class
      // Strategy 3: look for _actionButton_ inside a dialog (the "Return to tickets" btn)
      // Use all three so we catch it even if class names are re-hashed between deploys.
      const isCardNotEligibleDialog = (el) =>
        /card not eligible/i.test(el.textContent) ||
        el.querySelector('[class*="_limitedAccessModal"]') !== null;

      const dialogs = document.querySelectorAll('[role="dialog"]');
      console.log(`[TicketBot] 🔍 dismissCardNotEligible: scanning ${dialogs.length} dialog(s)`);
      for (const dialog of dialogs) {
        if (!isCardNotEligibleDialog(dialog)) continue;

        // Prefer "Return to tickets" by text (most stable), then _actionButton_ class,
        // then fall back to the _closeButton_ class or aria-label-based close button.
        const btn =
          Array.from(dialog.querySelectorAll('button')).find(b =>
            /return to tickets/i.test(b.textContent.trim())
          ) ||
          dialog.querySelector('button[class*="_actionButton_"]') ||
          dialog.querySelector('button[class*="_closeButton_"]') ||
          dialog.querySelector('button[aria-label*="close" i]') ||
          dialog.querySelector('button[aria-label*="dismiss" i]');

        const _dismissMethod = btn ? (
          /return to tickets/i.test(btn.textContent) ? '"Return to tickets" text match' :
          btn.className?.includes('_actionButton_') ? '_actionButton_ class' :
          btn.className?.includes('_closeButton_') ? '_closeButton_ class' : 'aria-label match'
        ) : 'no dismiss button found';
        console.log(`[TicketBot] ⚠️ Card not eligible dialog found — dismiss strategy: ${_dismissMethod}`);
        if (btn) btn.click();
        return { found: true };
      }

      // Fallback: body.modal-open is set when the popup is active. If no [role="dialog"]
      // matched above, scan all visible elements for the header text as a last resort.
      if (document.body.classList.contains('modal-open')) {
        const allEls = document.querySelectorAll(
          '[class*="_limitedAccessModal"], [class*="_limitedAccessModalHeader"]'
        );
        if (allEls.length > 0) {
          console.log(`[TicketBot] ⚠️ Card not eligible via body.modal-open fallback — ${allEls.length} element(s) matched`);
          // Try to find and click any dismiss-looking button in the vicinity
          const nearbyBtn =
            Array.from(document.querySelectorAll('button')).find(b =>
              /return to tickets/i.test(b.textContent.trim())
            ) ||
            Array.from(document.querySelectorAll('button[class*="_actionButton_"]'))[0] ||
            Array.from(document.querySelectorAll('button[class*="_closeButton_"]'))[0];
          if (nearbyBtn) nearbyBtn.click();
          return { found: true };
        }
      }

      console.log('[TicketBot] ✅ No card not eligible popup detected');
      return { found: false };
    }
  });
  return result[0]?.result || { found: false };
}

// ── Post-login content detector — polls for popup or listings, dismisses popups
// Returns { state: 'step1' | 'step2' | 'card_not_eligible' | 'popup_dismissed' | 'timeout' | 'error', error? }
async function waitForPostLoginContent(tabId, timeoutMs = 8000) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (timeout) => {
      return new Promise(resolve => {
        const start = Date.now();
        const check = () => {
          try {
            const dialogs = document.querySelectorAll('[role="dialog"]');
            if (dialogs.length > 0) console.log(`[TicketBot] 🔍 waitForPostLoginContent: ${dialogs.length} dialog(s) detected`);
            for (const dialog of dialogs) {
              // ── "Card not eligible" — must check BEFORE general dismiss logic.
              // "Return to tickets" would otherwise match the generic dismiss regex
              // and cause an infinite loop (dismiss → step1 → click listing → same popup).
              const isCardNotEligible =
                /card not eligible/i.test(dialog.textContent) ||
                dialog.querySelector('[class*="_limitedAccessModal"]') !== null;
              console.log(`[TicketBot] 🔍 waitForPostLoginContent: dialog isCardNotEligible=${isCardNotEligible}`);
              if (isCardNotEligible) {
                const dismissBtn =
                  Array.from(dialog.querySelectorAll('button')).find(b =>
                    /return to tickets/i.test(b.textContent.trim())
                  ) ||
                  dialog.querySelector('button[class*="_actionButton_"]') ||
                  dialog.querySelector('button[class*="_closeButton_"]') ||
                  dialog.querySelector('button[aria-label*="close" i]');
                console.log(`[TicketBot] ⚠️ Card not eligible dialog — dismissBtn found: ${!!dismissBtn}`);
                if (dismissBtn) dismissBtn.click();
                resolve({ state: 'card_not_eligible' }); return;
              }

              // If this dialog looks like the qty/checkout modal → step2
              const hasSelect = dialog.querySelector('select');
              const hasCheckoutBtn =
                dialog.querySelector('button[class*="_checkoutButton_"]') ||
                Array.from(dialog.querySelectorAll('button')).find(
                  b => b.textContent.trim().toLowerCase().includes('checkout')
                );
              if (hasSelect || hasCheckoutBtn) {
                console.log('[TicketBot] ✅ waitForPostLoginContent: qty/checkout modal detected → state=step2');
                resolve({ state: 'step2' }); return;
              }

              // Otherwise treat as a dismissible post-login popup
              const dismissBtn =
                dialog.querySelector('button[class*="_buttonTextContainedLarge_"]') ||
                Array.from(dialog.querySelectorAll('button')).find(b =>
                  /return to tickets|got it|dismiss|close|ok/i.test(b.textContent.trim())
                );
              if (dismissBtn) {
                const _dismissLabel = dismissBtn.textContent.trim();
                console.log(`[TicketBot] ⚠️ waitForPostLoginContent: dismissible popup detected — clicking "${_dismissLabel}"`);
                dismissBtn.click(); resolve({ state: 'popup_dismissed' }); return;
              }
            }
            // Listings visible → step1
            const listings = document.querySelector('[class*="_listings_"]');
            if (listings && listings.querySelectorAll('a[class*="_listingCard_"]').length > 0) {
              console.log('[TicketBot] ✅ waitForPostLoginContent: listings visible → state=step1');
              resolve({ state: 'step1' }); return;
            }
            if (Date.now() - start >= timeout) { resolve({ state: 'timeout' }); return; }
            setTimeout(check, 300);
          } catch(e) {
            resolve({ state: 'error', error: e.message });
          }
        };
        check();
      });
    },
    args: [timeoutMs]
  });
  return result[0]?.result || { state: 'error', error: 'Script injection failed' };
}

// ── Start / Stop ───────────────────────────────────────────────────────────
async function startBot(config) {
  if (botActive) return;
  botActive = true;
  lastStatus = "monitoring";
  checkCount = 0;
  urlTabMap = {};
  checkoutLock = false;
  stopRequested = false;
  sessionDeadNotified = false;
  // Override ntfy settings from config if provided (popup field takes priority over defaults.json)
  if (config.NTFY_TOPIC) ntfyTopic = config.NTFY_TOPIC;
  if (config.NTFY_PIN) ntfyPin = config.NTFY_PIN;
  // Strip credentials before persisting — they live in chrome.storage.session only
  const { LOGIN_USERNAME: _u, LOGIN_PASSWORD: _p, ...configToStore } = config;
  chrome.storage.local.set({ botConfig: configToStore, botWasActive: true });

  const urls = config.TARGET_URLS || (config.TARGET_URL ? [config.TARGET_URL] : []);
  const sanitizedConfig = { ...config, LOGIN_PASSWORD: config.LOGIN_PASSWORD ? "[REDACTED]" : undefined };
  log(`Bot started. Monitoring ${urls.length} event(s). Config: ${JSON.stringify(sanitizedConfig)}`);
  log(`🔍 Target URLs: ${urls.map((u, i) => `[${i}] ${u}`).join(' | ')}`);
  broadcastStatus({ active: true, status: "monitoring" });

  for (const url of urls) {
    await openTabForUrl(url);
  }

  // Start background ntfy listener for remote stop commands
  if (ntfyTopic) {
    ntfyBgSinceTime = Math.floor(Date.now() / 1000);
    // Drain stale messages so we only react to fresh commands
    await drainNtfyTopic(ntfyTopic);
    chrome.alarms.create("ntfyBackgroundPoll", { periodInMinutes: 0.5 }); // 30s (Chrome MV3 minimum)
    log(`📡 Background ntfy listener started — polling ${ntfyTopic} for remote stop commands.`);
  }

  // Session keepalive — check for "extend session" modals every 2 minutes
  chrome.alarms.create("sessionKeepAlive", { periodInMinutes: 2 });
  log("🔄 Session keepalive started — auto-extending Capital One sessions every 2 min.");

  scheduleCheck(config);
}

function stopBot() {
  botActive = false;
  lastStatus = "idle";
  checkoutLock = false;
  checkInProgress = false;
  loginOccurredThisCycle = false;
  chrome.alarms.clear("ticketCheck");
  chrome.alarms.clear("ntfyBackgroundPoll");
  chrome.alarms.clear("sessionKeepAlive");
  // Cancel any active Pushover emergency notification (stops repeated buzzing)
  cancelPushoverEmergency();
  chrome.storage.local.set({ botWasActive: false });
  broadcastStatus({ active: false, status: "idle" });
  log("Bot stopped.");
}

// ── Background ntfy listener — polls for "stop" command while bot is active ──
let ntfyBgSinceTime = 0;

async function pollNtfyBackground() {
  if (!botActive) {
    log("📡 BG ntfy: bot not active, skipping.");
    return;
  }
  const topic = ntfyTopic;
  const expectedPin = ntfyPin;
  if (!topic) {
    log("📡 BG ntfy: no topic configured, skipping.");
    return;
  }

  log(`📡 BG ntfy poll — topic=${topic}, since=${ntfyBgSinceTime}, checkInProgress=${checkInProgress}`);

  try {
    await chrome.storage.session.get("_keepalive");
    const resp = await fetch(
      `https://ntfy.sh/${topic}/json?poll=1&since=${ntfyBgSinceTime}`,
      { headers: { Accept: "application/x-ndjson" } }
    );
    if (!resp.ok) {
      log(`📡 BG ntfy: HTTP ${resp.status}`, "warn");
      return;
    }
    const text = await resp.text();
    const lines = text.trim().split("\n").filter(Boolean);

    // Update since time so we don't re-read these messages
    ntfyBgSinceTime = Math.floor(Date.now() / 1000);

    if (lines.length === 0) return; // nothing new, stay quiet

    log(`📡 BG ntfy: got ${lines.length} message(s)`);

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.event === "open") continue; // skip connection events
        const raw = (msg.message || "").trim();
        if (!raw) continue;
        log(`📡 BG ntfy message: "${raw}"`);
        const colonIdx = raw.indexOf(":");
        if (colonIdx === -1) {
          log(`📡 BG ntfy: no PIN separator in "${raw}", ignoring.`);
          continue;
        }
        const command = raw.substring(0, colonIdx).toLowerCase();
        const msgPin = raw.substring(colonIdx + 1);
        if (expectedPin && msgPin !== expectedPin) {
          log(`📡 BG ntfy: PIN mismatch (expected=${expectedPin}, got=${msgPin}), ignoring.`);
          continue;
        }
        if (command === "stop") {
          log("🛑 STOP command received via background ntfy listener — shutting down bot.");
          sendPushoverAlert("🛑 Bot Stopped", "Stop command received from control page. Bot is shutting down.");
          stopRequested = true;
          stopBot();
          return;
        }
        log(`📡 BG ntfy: ignoring "${command}" (only "stop" handled outside checkout).`);
      } catch(e) { /* skip bad JSON lines */ }
    }
  } catch(e) {
    log(`📡 BG ntfy poll error: ${e.message}`, "warn");
  }
}

function scheduleCheck(config) {
  runCheck(config);
  chrome.alarms.create("ticketCheck", {
    periodInMinutes: config.POLL_INTERVAL_MINUTES || 5
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pushoverKeepAlive" || alarm.name === "ntfyKeepAlive") {
    // Ping to keep the service worker alive during polling — no-op
    return;
  }
  if (alarm.name === "ntfyBackgroundPoll") {
    pollNtfyBackground();
    return;
  }
  if (alarm.name === "sessionKeepAlive") {
    if (botActive) keepSessionsAlive();
    return;
  }
  if (alarm.name !== "ticketCheck" || !botActive) return;
  log(`⏱️ ticketCheck alarm fired — triggering runCheck`);
  chrome.storage.local.get("botConfig", ({ botConfig }) => {
    if (botConfig) runCheck(botConfig);
  });
});

// ── Session keepalive — auto-dismiss "extend session" / "session timeout" modals ──
// Capital One shows a modal when the session is about to expire. Clicking "Continue"
// keeps the session alive so checkout doesn't redirect to login.
async function dismissSessionTimeout(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Look for session-related modals: "session is about to expire", "extend session",
        // "are you still there", "session timeout", etc.
        const sessionPhrases = [
          /session.*expir/i, /extend.*session/i, /are you still there/i,
          /session.*timeout/i, /still there/i, /about to expire/i,
          /inactiv/i, /you.*been.*idle/i, /continue.*session/i
        ];

        // Check dialogs, modals, and overlays
        const candidates = document.querySelectorAll(
          '[role="dialog"], [role="alertdialog"], [class*="modal"], [class*="Modal"], [class*="overlay"], [class*="Overlay"], [class*="timeout"], [class*="Timeout"]'
        );

        for (const el of candidates) {
          const text = el.textContent || "";
          const isSessionModal = sessionPhrases.some(rx => rx.test(text));
          if (!isSessionModal) continue;

          // Find the "Continue" / "Extend" / "Stay Signed In" / "Yes" button
          const btn =
            Array.from(el.querySelectorAll('button, a[role="button"], [class*="button" i]')).find(b => {
              const t = b.textContent.trim().toLowerCase();
              return /continue|extend|stay|yes|ok|keep/i.test(t) && !/sign out|log out|cancel|no/i.test(t);
            });

          if (btn) {
            console.log(`[TicketBot] 🔄 Session timeout modal found — clicking "${btn.textContent.trim()}"`);
            btn.click();
            return { found: true, action: btn.textContent.trim() };
          } else {
            console.log("[TicketBot] ⚠️ Session timeout modal found but no continue button");
            return { found: true, action: null };
          }
        }
        return { found: false };
      }
    });
    return result[0]?.result || { found: false };
  } catch(e) {
    // Tab might not be on a Capital One domain — ignore
    return { found: false };
  }
}

// Run session keepalive across all open tabs
// If session expired (redirected to login), auto-login and navigate back.
// Optionally sends a Pushover notification (controlled by SESSION_NOTIFY config flag).
let sessionDeadNotified = false; // only notify once per bot session
async function keepSessionsAlive() {
  for (const [url, tabId] of Object.entries(urlTabMap)) {
    if (!tabId) continue;
    try {
      // Check if tab was redirected to login page (session expired)
      const tab = await chrome.tabs.get(tabId);
      const tabUrl = tab?.url || "";
      if (/verified\.capitalone\.com\/sign-in/i.test(tabUrl) || /\/auth\b/i.test(tabUrl)) {
        log(`⚠️ Session expired — tabId=${tabId} redirected to login. Auto-logging back in...`, "warn");

        // Attempt auto-login
        const { botConfig } = await chrome.storage.local.get("botConfig");
        const loggedIn = await runLogin(tabId, botConfig || {});

        if (loggedIn) {
          log(`✅ Session restored — auto-login successful on tabId=${tabId}. Navigating back to event page.`);
          // Navigate back to the event page
          try {
            await chrome.tabs.update(tabId, { url });
            await waitForTabLoad(tabId);
            log(`✅ Tab ${tabId} back on ${url.split('/').pop()}`);
          } catch(e) {
            log(`⚠️ Could not navigate back after re-login: ${e.message}`, "warn");
          }
          sessionDeadNotified = false; // session is alive again

          // Send notification if enabled
          const { sessionNotify } = await chrome.storage.local.get("sessionNotify");
          if (sessionNotify !== false) { // default ON
            sendPushoverAlert(
              "🔄 Session Restored",
              "Capital One session expired but was auto-restored. Bot is still running."
            );
          }
        } else {
          log(`❌ Auto-login failed on tabId=${tabId} — credentials may be missing.`, "err");
          if (!sessionDeadNotified) {
            sessionDeadNotified = true;
            // Always notify on failure regardless of toggle
            sendPushoverAlert(
              "⚠️ Session Expired — Login Failed",
              "Capital One session expired and auto-login failed. Open the site to log in manually.",
              "https://entertainment.capitalone.com"
            );
          }
        }
        continue;
      }

      const result = await dismissSessionTimeout(tabId);
      if (result.found) {
        log(`🔄 Session extended on tabId=${tabId} (${url.split('/').pop()}) — clicked "${result.action}"`);
        sessionDeadNotified = false;
        continue;
      }

      // ── Proactive sign-in check ──
      // If the top-right corner shows "Sign In" instead of the user's name,
      // the session has silently expired. Re-login before the next scan.
      try {
        const signInCheck = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            // Logged in:  _topNav_ WITHOUT _isSignedOut_, has _greetingFirstName_ "Welcome, Raymond"
            // Logged out: _topNav_ WITH _isSignedOut_ class, has _signInButton_ instead
            const topNav = document.querySelector('[class*="_topNav_"]');
            if (!topNav) return { signedOut: false }; // page may still be loading
            // Primary check: _isSignedOut_ class on the nav bar
            if (topNav.className.includes('_isSignedOut_')) return { signedOut: true };
            // Fallback: _signInButton_ present instead of greeting
            if (topNav.querySelector('[class*="_signInButton_"]')) return { signedOut: true };
            return { signedOut: false };
          }
        });
        if (signInCheck[0]?.result?.signedOut) {
          log(`⚠️ Session silently expired on tabId=${tabId} (${url.split('/').pop()}) — signed out state detected. Clicking Sign In button...`, "warn");
          // Click the Sign In button so C1 handles the redirect properly
          await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              const btn = document.querySelector('[class*="_signInButton_"]');
              if (btn) { btn.click(); return true; }
              // Fallback: any button/link with "Sign in" text
              const links = document.querySelectorAll('button, a');
              for (const el of links) {
                if (/sign.?in/i.test(el.textContent?.trim() || '')) { el.click(); return true; }
              }
              return false;
            }
          });
          await waitForTabLoad(tabId);
          const { botConfig } = await chrome.storage.local.get("botConfig");
          const loggedIn = await runLogin(tabId, botConfig || {});
          if (loggedIn) {
            // After login, C1 may redirect to homepage instead of the event page.
            // Always navigate back to the event URL to be safe.
            const postLoginTab = await chrome.tabs.get(tabId);
            const postLoginUrl = postLoginTab?.url || '';
            if (!postLoginUrl.includes(url.replace(/\?.*$/, '').split('/').pop())) {
              log(`🔄 Post-login landed on ${postLoginUrl.split('?')[0]} — navigating back to event page...`);
            } else {
              log(`✅ Post-login already on event page.`);
            }
            await chrome.tabs.update(tabId, { url });
            await waitForTabLoad(tabId);
            log(`✅ Proactive re-login successful on tabId=${tabId}. Back on ${url.split('/').pop()}.`);
            sessionDeadNotified = false;
            sendPushoverAlert(
              "🔄 Session Restored",
              `Session expired on ${url.split('/').pop()} — auto re-logged in. Bot still running.`
            );
          } else {
            log(`❌ Proactive re-login failed on tabId=${tabId}.`, "err");
            if (!sessionDeadNotified) {
              sessionDeadNotified = true;
              sendPushoverAlert(
                "⚠️ Session Expired — Login Failed",
                "Detected signed out state but auto-login failed. Log in manually.",
                "https://entertainment.capitalone.com"
              );
            }
          }
        }
      } catch(e) { /* injection may fail on non-C1 pages */ }
    } catch(e) { /* tab may not exist */ }
  }
}

// ── Main check loop ────────────────────────────────────────────────────────
async function runCheck(config) {
  if (!botActive || stopRequested) return;

  // Prevent re-entry — if a check is already in progress (e.g. mid-checkout),
  // skip this cycle. This prevents the poll alarm from reloading tabs that are
  // in the middle of a checkout flow (which causes /error redirects).
  if (checkInProgress) {
    log("⏳ Check cycle already in progress — skipping this poll to avoid disrupting checkout.");
    return;
  }
  checkInProgress = true;

  checkCount++;
  loginOccurredThisCycle = false;
  broadcastStatus({ active: true, status: "monitoring", checkCount });

  // ── Quick ntfy stop-check before doing any work ──────────────────────────
  // This catches "stop" commands sent from the control page between cycles.
  if (ntfyTopic) {
    try {
      const resp = await fetch(
        `https://ntfy.sh/${ntfyTopic}/json?poll=1&since=${ntfyBgSinceTime}`,
        { headers: { Accept: "application/x-ndjson" } }
      );
      if (resp.ok) {
        const text = await resp.text();
        const lines = text.trim().split("\n").filter(Boolean);
        ntfyBgSinceTime = Math.floor(Date.now() / 1000);
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (msg.event === "open") continue;
            const raw = (msg.message || "").trim();
            const colonIdx = raw.indexOf(":");
            if (colonIdx === -1) continue;
            const command = raw.substring(0, colonIdx).toLowerCase();
            const msgPin = raw.substring(colonIdx + 1);
            if (ntfyPin && msgPin !== ntfyPin) continue;
            if (command === "stop") {
              log("🛑 STOP command caught at start of check cycle — shutting down bot.");
              sendPushoverAlert("🛑 Bot Stopped", "Stop command received from control page. Bot is shutting down.");
              stopRequested = true;
              checkInProgress = false;
              stopBot();
              return;
            }
          } catch(e) { /* skip */ }
        }
      }
    } catch(e) { /* network error, continue with check */ }
  }

  // Auto-extend any "session about to expire" modals before reloading tabs
  await keepSessionsAlive();

  const urls = config.TARGET_URLS || (config.TARGET_URL ? [config.TARGET_URL] : []);
  let checkoutSuccesses = 0;
  log(`Check #${checkCount} — scanning ${urls.length} event(s) in priority order...`);

  // First, reload ALL tabs simultaneously so they are all fresh at the same time
  await Promise.all(urls.map(url => reloadTabForUrl(url)));

  // Then scan in priority order — URL[0] is highest priority.
  // If a ticket is found and checked out, continue to the next URL
  // so lower-priority events can also be purchased if available.
  // Only stop if botActive is explicitly set to false (user hits Stop).
  for (let i = 0; i < urls.length; i++) {
    if (!botActive || stopRequested) break;
    const label = i === 0 ? "🥇 Priority 1" : `#${i + 1}`;
    const tabId = urlTabMap[urls[i]];
    log(`🔍 Checking ${label} (index ${i}): ${urls[i]} — tabId=${tabId}`);

    // If login happened on an earlier tab this cycle, the remaining tabs were
    // pre-loaded before the session existed and won't reflect the authenticated
    // state. Reload them now so they pick up the cookie/session.
    if (i > 0 && loginOccurredThisCycle) {
      log(`🔄 Login occurred this cycle — refreshing tab ${i + 1} to pick up authenticated session...`);
      await reloadTabForUrl(urls[i]);
      await waitForCardRecognition(tabId, 6000);
    }

    // Quick stop-check before processing this event
    if (await quickStopCheck()) break;

    const result = await checkUrl(urls[i], config);
    if (result === "checkout_ok") checkoutSuccesses++;
    if (stopRequested || !botActive) break; // stop was triggered during checkout
    if (i < urls.length - 1) {
      log(`✅ Done with ${label} — moving to next event...`);
    }
  }

  checkInProgress = false; // release the re-entry guard

  // ── Freeze tabs between polls — navigate to about:blank to kill the site's
  // heavy JS (animations, analytics, session heartbeats) that pin CPU at 100%.
  // Tabs are reloaded fresh on the next poll cycle anyway (reloadTabForUrl).
  // Skip blanking if checkout happened — keep tabs on confirmation/receipt page.
  if (botActive && !stopRequested && checkoutSuccesses === 0) {
    for (const url of urls) {
      const tabId = urlTabMap[url];
      if (tabId) {
        try {
          await chrome.tabs.update(tabId, { url: "about:blank" });
        } catch(e) { /* tab may not exist */ }
      }
    }
    log("💤 Tabs blanked to save CPU — will reload on next poll.");
  } else if (checkoutSuccesses > 0) {
    log("🎟️ Checkout succeeded — keeping tabs alive (not blanking).");
  }

  if (botActive) {
    // Check how many events are still being monitored (may have shrunk mid-loop)
    const remainingUrls = config.TARGET_URLS || [];
    log(`✅ Check #${checkCount} complete — ${checkoutSuccesses} checked out this cycle, ${remainingUrls.length} event(s) still monitored.`);

    // Auto-stop: if no events left to monitor, we're done (live mode only —
    // test mode never removes URLs so the list never shrinks)
    if (remainingUrls.length === 0 && !config.TEST_MODE) {
      log("🎉 All events resolved — auto-stopping bot. (checked out or exclusive sold out)");
      sendPushoverAlert(
        "🎉 All Done!",
        `No more events to monitor — all checked out or exclusive tickets sold out. Bot stopped.`
      );
      stopBot();
    }
  }
}

// ── Reload tab without scanning — used for parallel pre-load ───────────────
async function reloadTabForUrl(url) {
  try {
    let tabId = urlTabMap[url];
    if (tabId) {
      try { await chrome.tabs.get(tabId); }
      catch {
        log(`⚠️ Tab tabId=${tabId} for ${url.split('/').pop()} no longer exists — will reopen`);
        tabId = null; urlTabMap[url] = null;
      }
    }
    if (!tabId) {
      log(`🔄 No existing tab for ${url.split('/').pop()} — opening new tab`);
      await openTabForUrl(url);
      tabId = urlTabMap[url];
    }
    // Navigate to the actual URL (not reload) — tabs may be on about:blank
    // after the CPU-saving blank between polls.
    log(`🔄 Navigating tabId=${tabId} to ${url.split('/').pop()}`);
    await chrome.tabs.update(tabId, { url });
    await waitForTabLoad(tabId);
    // Small settle for React to render
    log(`⏱️ Waiting 1500ms for React to settle on tabId=${tabId}`);
    await new Promise(r => setTimeout(r, 1500));
    log(`✅ tabId=${tabId} reload complete and settled for ${url.split('/').pop()}`);
  } catch(e) {
    log(`⚠️ Could not reload tab for ${url.split('/').pop()}: ${e.message}`, "warn");
  }
}

// ── Check a single URL (tab already reloaded by reloadTabForUrl) ──────────
async function checkUrl(url, config) {
  try {
    if (!botActive) return;

    const tabId = urlTabMap[url];
    if (!tabId) {
      log(`⚠️ No tab found for ${url.split('/').pop()} — skipping`, "warn");
      return;
    }
    log(`🔍 Scanning URL: ${url} — tabId=${tabId}`);

    // Tab is already loaded — just wait for the React content to be present
    log(`🔍 Waiting for pageReady selector ('[class*="_listings_"], h2') on tabId=${tabId}`);
    const pageReady = await waitForSelector(
      tabId,
      '[class*="_listings_"], h2',
      10000
    );
    if (!pageReady.found) {
      log(`❌ pageReady selector not found on tabId=${tabId}: ${pageReady.error}`, "warn");
      return;
    }
    log(`✅ pageReady confirmed on tabId=${tabId} — page content is present`);

    // Check for "Card not eligible" popup before scanning for tickets.
    // It can appear on page load if the selected card doesn't have access to
    // this event's ticket tier. Dismiss it and skip this URL for this cycle.
    {
      log(`🔍 Checking for 'Card not eligible' popup on tabId=${tabId}`);
      const cne = await dismissCardNotEligible(tabId);
      if (cne.found) {
        log(`⚠️ 'Card not eligible' popup on ${url.split('/').pop()} — dismissed. This card cannot access this event tier.`, "warn");
        return;
      }
      log(`✅ No 'Card not eligible' popup on tabId=${tabId}`);
    }

    if (!botActive) return;

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (minTickets) => {
        try {
          const bummerEl = document.querySelector('h2');
          if (bummerEl && bummerEl.textContent.includes("No tickets available")) {
            console.log('[TicketBot] 🔍 "No tickets available" h2 detected');
            return { found: false, containerFound: false, totalCards: 0 };
          }
          // Try the listings container first; fall back to document-wide card scan
          // so pages where the container class hash differs still work.
          const listingsContainer = document.querySelector('[class*="_listings_"]');
          console.log(`[TicketBot] 🔍 Listings container found: ${!!listingsContainer}`);
          const cards = listingsContainer
            ? listingsContainer.querySelectorAll('a[class*="_listingCard_"], a[data-testid="listing-card"]')
            : document.querySelectorAll('a[class*="_listingCard_"], a[data-testid="listing-card"]');
          console.log(`[TicketBot] 🔍 Total listing cards found: ${cards.length}`);
          if (!cards.length) return { found: false, containerFound: !!listingsContainer, totalCards: 0 };

          // ── CARDHOLDER EXCLUSIVE page-level check ──
          // The exclusive badge lives in the event header, NOT on individual cards.
          // If the page has it, all listings are exclusive. If not, they're regular resell → skip.
          const hasExclusiveBadge = !!document.querySelector('[class*="_exclusiveBadge_"]')
            || /cardholder exclusive/i.test(document.querySelector('[class*="_eventInfoHeader_"]')?.textContent || '');
          console.log(`[TicketBot] 🔍 Cardholder Exclusive page: ${hasExclusiveBadge} (${cards.length} card(s))`);
          if (!hasExclusiveBadge) {
            // No badge = exclusive is sold out. Regular resell listings only appear after exclusive is gone.
            console.log(`[TicketBot] ⚠️ No CARDHOLDER EXCLUSIVE badge on page — ${cards.length} resell card(s). Exclusive sold out.`);
            return { found: false, containerFound: !!listingsContainer, totalCards: cards.length, exclusiveCards: 0, noExclusive: true };
          }

          for (let _i = 0; _i < cards.length; _i++) {
            const card = cards[_i];
            const qtyEl = card.querySelector('[class*="_lineHeight16px_"]');
            let qty = 99;
            if (qtyEl) {
              const match = qtyEl.textContent.match(/(\d+)\s*ticket/i);
              if (match) qty = parseInt(match[1], 10);
            }
            if (qty >= minTickets) {
              const sectionEl = card.querySelector('[class*="_lineHeight18px_"]');
              const priceEl = card.querySelector('[class*="_listingCardPricingContainer_"]');
              const section = sectionEl?.textContent?.trim() || "Unknown Section";
              const row = qtyEl?.textContent?.trim() || "";
              const price = priceEl?.textContent?.trim() || "Unknown Price";
              console.log(`[TicketBot] ✅ Selected EXCLUSIVE card ${_i + 1}/${cards.length}: "${section} — ${row}" price=${price} qty=${qty} (meets min ${minTickets})`);
              return {
                found: true,
                section,
                row,
                price,
                containerFound: !!listingsContainer,
                totalCards: cards.length,
                exclusiveCards: cards.length,
                selectedIndex: _i + 1
              };
            } else {
              const sectionEl = card.querySelector('[class*="_lineHeight18px_"]');
              console.log(`[TicketBot] 🔍 Exclusive card ${_i + 1}/${cards.length}: qty=${qty} < min=${minTickets} — "${sectionEl?.textContent?.trim() || '?'}" skipped`);
            }
          }
          console.log(`[TicketBot] ⚠️ ${cards.length} exclusive card(s) found but none met minTickets=${minTickets}`);
          return { found: false, containerFound: !!listingsContainer, totalCards: cards.length, exclusiveCards: exclusiveCards.length };
        } catch(e) {
          console.log(`[TicketBot] ❌ Listing scan error: ${e.message}`);
          return { found: false, error: e.message };
        }
      },
      args: [config.MIN_TICKETS || 2]
    });

    const result = results[0]?.result;

    log(`🔍 Scan result for tabId=${tabId}: containerFound=${result?.containerFound}, totalCards=${result?.totalCards}, exclusiveCards=${result?.exclusiveCards ?? '?'}, found=${result?.found}${result?.selectedIndex ? `, selectedCard=${result.selectedIndex}/${result.totalCards}` : ''}`);

    if (result?.error) {
      log(`❌ Scan error on ${url.split('/').pop()}: ${result.error}`, "err");
      return;
    }

    if (result?.noExclusive) {
      const eventSlug = url.split('/').pop();

      if (config.TEST_MODE) {
        // Test mode: log but don't close tab or remove URL — config is a shallow copy
        log(`⚠️ [TEST] No CARDHOLDER EXCLUSIVE tickets on ${eventSlug} — ${result.totalCards} regular resell card(s) only. Would remove in live mode.`, "warn");
        sendPushoverAlert(
          "🧪 [TEST] Exclusive Sold Out",
          `CARDHOLDER EXCLUSIVE tickets gone for ${eventSlug}. ${result.totalCards} resell card(s) showing. Would remove in live mode.`
        );
        return "exclusive_gone";
      }

      log(`⚠️ No CARDHOLDER EXCLUSIVE tickets on ${eventSlug} — ${result.totalCards} regular resell card(s) only. Removing from monitoring.`, "warn");

      // Close the tab — no reason to keep it open
      try {
        await chrome.tabs.remove(tabId);
        log(`🗑️ Closed tab ${tabId} for ${eventSlug}`);
      } catch(e) {
        log(`⚠️ Could not close tab: ${e.message}`, "warn");
      }
      delete urlTabMap[url];

      // Remove URL from the monitoring list
      if (config.TARGET_URLS) {
        config.TARGET_URLS = config.TARGET_URLS.filter(u => u !== url);
        chrome.storage.local.set({ botConfig: config });
        log(`📋 Removed ${eventSlug} — ${config.TARGET_URLS.length} event(s) still monitored.`);
      }

      // Notify user
      sendPushoverAlert(
        "❌ Exclusive Sold Out",
        `CARDHOLDER EXCLUSIVE tickets gone for ${eventSlug}. Removed from monitoring. ${config.TARGET_URLS?.length || 0} event(s) remaining.`
      );

      return "exclusive_gone";
    }

    if (!result?.found) {
      log(`No tickets — ${url.split('/').pop()} (${result?.totalCards ?? 0} card(s) found, exclusive=${result?.exclusiveCards ?? 0}, none met minTickets=${config.MIN_TICKETS || 2})`);
      return;
    }

    // ── TICKETS FOUND ────────────────────────────────────────────────────
    log(`🎟️ TICKETS FOUND on ${url.split('/').pop()}! ${result.section} — ${result.price}`);
    lastStatus = "found";

    // Only acquire the checkout lock if we're actually going to run checkout.
    // If auto-click is off, we just alert + focus the tab and move on —
    // no lock needed since nothing async is happening.
    // If checkout is already running for a higher priority URL, still alert
    // the user but skip the checkout for this URL this cycle

    // Always focus the tab and alert for every URL that finds tickets
    await chrome.tabs.update(tabId, { active: true });
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });

    sendPushoverAlert(
      "🎟️ Tickets Available!",
      `${result.section} ${result.row} — ${result.price}`,
      url
    );

    broadcastStatus({ found: true, section: result.section, row: result.row, price: result.price, url });

    // Always run the full checkout sequence.
    // CONFIRM_ORDER toggle controls whether Place Order is clicked at the end.
    // If checkout hits a snag, refresh the tab and retry (up to 2 retries).
    const MAX_CHECKOUT_RETRIES = 2;
    if (!checkoutLock) {
      log(`🔒 Checkout lock acquired for tabId=${tabId} (${url.split('/').pop()})`);
      checkoutLock = true;

      // runCheckout returns:
      //   true / "confirmed" — order placed (or test mode completed)
      //   "skip"    — user tapped Skip on phone
      //   "stop"    — user tapped Stop on phone (bot already stopping)
      //   "timeout" — no response from phone
      //   false     — checkout flow failed (modal issue, button not found, etc.)
      let checkoutResult = false;
      for (let attempt = 1; attempt <= MAX_CHECKOUT_RETRIES + 1; attempt++) {
        if (!botActive || stopRequested) break;

        if (attempt > 1) {
          log(`🔄 Checkout retry ${attempt - 1}/${MAX_CHECKOUT_RETRIES} — refreshing tab and starting from the top...`, "warn");
          try {
            await chrome.tabs.update(tabId, { url });
            await waitForTabLoad(tabId);
            await new Promise(r => setTimeout(r, 2000));
          } catch(e) {
            log(`⚠️ Tab refresh failed: ${e.message} — retrying anyway`, "warn");
          }
        }

        checkoutResult = await runCheckout(tabId, config);
        // Only retry on hard failure (false). Any other result means the user
        // made a decision or the checkout completed — don't retry.
        if (checkoutResult !== false) break;

        if (attempt <= MAX_CHECKOUT_RETRIES) {
          log(`❌ Checkout attempt ${attempt} failed for ${url.split('/').pop()} — will refresh and retry...`, "err");
        }
      }

      checkoutLock = false;
      log(`🔓 Checkout lock released for tabId=${tabId} (${url.split('/').pop()})`);

      const isSuccess = checkoutResult === true;
      const isSkip = checkoutResult === "skip";
      const isStop = checkoutResult === "stop";
      const isTimeout = checkoutResult === "timeout";
      const isFail = checkoutResult === false;

      if (isSuccess) {
        // ── Order confirmed — close tab and remove URL from list ──
        const modeLabel = config.TEST_MODE ? "🧪 TEST MODE" : "✅";
        log(`${modeLabel} Checkout succeeded for ${url.split('/').pop()} — closing tab and removing from list.`);
        try {
          await chrome.tabs.remove(tabId);
          log(`🗑️ Closed tab ${tabId} for ${url.split('/').pop()}`);
        } catch(e) {
          log(`⚠️ Could not close tab: ${e.message}`, "warn");
        }
        delete urlTabMap[url];
        if (config.TARGET_URLS) {
          config.TARGET_URLS = config.TARGET_URLS.filter(u => u !== url);
          if (!config.TEST_MODE) {
            chrome.storage.local.set({ botConfig: config });
          }
          log(`📋 ${config.TARGET_URLS.length} event(s) remaining in monitoring list.`);
        }
        return "checkout_ok";

      } else if (isSkip) {
        // ── User skipped — close tab, keep URL in monitoring list ──
        log(`⏭️ Order skipped for ${url.split('/').pop()} — closing tab, still monitoring.`);
        try {
          await chrome.tabs.remove(tabId);
          log(`🗑️ Closed tab ${tabId} for ${url.split('/').pop()}`);
        } catch(e) {
          log(`⚠️ Could not close tab: ${e.message}`, "warn");
        }
        delete urlTabMap[url]; // tab gone, new one will open next cycle
        return "checkout_skipped";

      } else if (isStop) {
        // ── User stopped bot — bot is already shutting down ──
        return "checkout_stopped";

      } else if (isTimeout) {
        // ── No response — leave checkout page open for manual action ──
        log(`⏰ No response for ${url.split('/').pop()} — checkout page left open.`);
        return "checkout_timeout";

      } else {
        // ── Hard failure — navigate back to event page for next cycle ──
        try {
          log(`🔄 Navigating tabId=${tabId} back to event page to release checkout session...`);
          await chrome.tabs.update(tabId, { url });
          await waitForTabLoad(tabId);
        } catch(e) {
          log(`⚠️ Tab reset failed: ${e.message}`, "warn");
        }
        log(`❌ Checkout failed for ${url.split('/').pop()} after ${MAX_CHECKOUT_RETRIES + 1} attempts — will retry next cycle.`, "err");
        return "checkout_failed";
      }
    } else {
      log(`⚠️ Checkout lock already held — skipping checkout for tabId=${tabId} (${url.split('/').pop()}) this cycle`);
      log(`ℹ️ Tickets found on ${url.split('/').pop()} but checkout already in progress — will retry next cycle.`);
      return "checkout_skipped";
    }

  } catch(e) {
    let _errTabUrl = 'unknown';
    try { const _t = await chrome.tabs.get(urlTabMap[url]); _errTabUrl = _t?.url || 'unknown'; } catch {}
    log(`❌ Unexpected error checking ${url.split('/').pop()} (tabUrl=${_errTabUrl}): ${e.message}`, "err");
    if (checkoutLock) {
      checkoutLock = false;
      log(`🔓 Checkout lock force-released after error`);
    }
    return "error";
  }
}

// ── Login sequence ────────────────────────────────────────────────────────
async function runLogin(tabId, config) {
  try {
    // Credentials live in session storage only — never in local storage or config
    const { loginCredentials } = await chrome.storage.session.get("loginCredentials");
    const username = loginCredentials?.username;
    const password = loginCredentials?.password;

    if (!username || !password) {
      log("❌ Login page detected but no credentials saved — log in manually and restart.", "err");
      return false;
    }
    log(`✅ Login credentials found in session storage (username=${username})`);

    log("🔐 Login page detected — waiting for form to appear...");

    // Wait for username field to be in the DOM
    log(`🔍 Login step 1/3: waiting for username field (input#usernameInputField) on tabId=${tabId}`);
    const usernameWait = await waitForSelector(tabId, 'input#usernameInputField', 15000);
    if (!usernameWait.found) {
      log(`❌ Login form username field did not appear: ${usernameWait.error}`, "err");
      return false;
    }
    log(`✅ Login step 1/3: username field found`);

    // Wait for password field
    log(`🔍 Login step 2/3: waiting for password field (input#pwInputField) on tabId=${tabId}`);
    const passwordWait = await waitForSelector(tabId, 'input#pwInputField', 10000);
    if (!passwordWait.found) {
      log(`❌ Login form password field did not appear: ${passwordWait.error}`, "err");
      return false;
    }
    log(`✅ Login step 2/3: password field found`);

    // Wait for submit button
    log(`🔍 Login step 3/3: waiting for submit button on tabId=${tabId}`);
    const submitWait = await waitForSelector(tabId, 'button[data-testtarget="sign-in-submit-button"]', 10000);
    if (!submitWait.found) {
      log(`❌ Login submit button did not appear: ${submitWait.error}`, "err");
      return false;
    }
    log(`✅ Login step 3/3: submit button found — filling credentials`);

    log("Filling in login credentials...");
    const fillResult = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",  // run in page context so Angular sees the native setter
      func: (username, password) => {
        try {
          const usernameField = document.querySelector('input#usernameInputField');
          const passwordField = document.querySelector('input#pwInputField');
          const submitBtn = document.querySelector('button[data-testtarget="sign-in-submit-button"]');

          if (!usernameField || !passwordField || !submitBtn) {
            return { success: false, error: "One or more login form elements missing" };
          }

          // Use native setter to bypass Angular's value tracking
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

          usernameField.focus();
          nativeSetter.call(usernameField, username);
          usernameField.dispatchEvent(new Event('input', { bubbles: true }));
          usernameField.dispatchEvent(new Event('change', { bubbles: true }));
          usernameField.blur();

          passwordField.focus();
          nativeSetter.call(passwordField, password);
          passwordField.dispatchEvent(new Event('input', { bubbles: true }));
          passwordField.dispatchEvent(new Event('change', { bubbles: true }));
          passwordField.blur();

          // Small delay before submitting so Angular registers both fields
          return new Promise(resolve => {
            setTimeout(() => {
              try {
                submitBtn.click();
                resolve({ success: true });
              } catch(e) {
                resolve({ success: false, error: e.message });
              }
            }, 600);
          });
        } catch(e) {
          return { success: false, error: e.message };
        }
      },
      args: [username, password]
    });

    const fr = fillResult[0]?.result;
    if (!fr?.success) {
      log(`❌ Failed to fill login form: ${fr?.error || "unknown error"}`, "err");
      return false;
    }

    log("✅ Login form submitted — waiting for redirect to event page...");

    // Wait for the page to leave the login domain (URL changes back to entertainment.capitalone.com)
    await new Promise((resolve) => {
      const maxWait = 20000;
      const start = Date.now();
      const poll = setInterval(async () => {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.url && !tab.url.includes('verified.capitalone.com') && !tab.url.includes('sign-in')) {
            clearInterval(poll);
            log(`✅ Login redirect complete after ${Date.now() - start}ms — redirected to: ${tab.url}`);
            resolve();
          } else if (Date.now() - start > maxWait) {
            clearInterval(poll);
            log(`⚠️ Login redirect polling timed out after ${maxWait}ms — current URL: ${tab?.url || 'unknown'}`);
            resolve(); // continue anyway, let next check handle it
          }
        } catch(e) {
          clearInterval(poll);
          log(`⚠️ Login redirect polling error: ${e.message}`);
          resolve();
        }
      }, 500);
    });

    // Wait for tab to fully load after redirect
    await waitForTabLoad(tabId);
    // Give the site time to associate the session with the user's Capital One card.
    // Without this, clicking a listing card too soon causes "Card not eligible"
    // because the payment card hasn't been recognized yet.
    await waitForCardRecognition(tabId, 6000);
    loginOccurredThisCycle = true; // signal runCheck to reload later tabs
    log("✅ Login complete — resuming ticket scan.");
    return true;

  } catch(e) {
    log(`❌ Login error: ${e.message}`, "err");
    return false;
  }
}

// ── Full checkout sequence — returns true on success, false on any failure ──
async function runCheckout(tabId, config) {
  try {

    // ── Inject non-blocking toast overlay for TEST_MODE notifications ────
    if (config.TEST_MODE) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            window.__ticketBotToast = (msg) => {
              const existing = document.getElementById('__ticketBotToast');
              if (existing) existing.remove();
              const el = document.createElement('div');
              el.id = '__ticketBotToast';
              el.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:999999;background:rgba(10,10,15,0.95);border:2px solid #7c3aed;border-radius:16px;padding:20px 28px;color:#e8e8f0;font-family:-apple-system,system-ui,sans-serif;font-size:18px;font-weight:600;white-space:pre-line;text-align:center;box-shadow:0 8px 32px rgba(124,58,237,0.4);max-width:90vw;transition:opacity 0.5s;';
              el.textContent = msg;
              document.body.appendChild(el);
              setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 600); }, 5000);
            };
          }
        });
      } catch(e) {}
    }

    // ── Step 1: Click listing card ───────────────────────────────────────
    log(`Clicking listing card on tabId=${tabId} (minTickets=${config.MIN_TICKETS})...`);
    const _step1Result = await chrome.scripting.executeScript({
      target: { tabId },
      func: (minTickets) => {
        // ── CARDHOLDER EXCLUSIVE page-level check ──
        const hasExclusiveBadge = !!document.querySelector('[class*="_exclusiveBadge_"]')
          || /cardholder exclusive/i.test(document.querySelector('[class*="_eventInfoHeader_"]')?.textContent || '');
        if (!hasExclusiveBadge) {
          console.log(`[TicketBot] ⚠️ Step 1: No CARDHOLDER EXCLUSIVE badge on page — skipping`);
          return false;
        }
        const listingsContainer = document.querySelector('[class*="_listings_"]');
        const cards = listingsContainer
          ? listingsContainer.querySelectorAll('a[class*="_listingCard_"], a[data-testid="listing-card"]')
          : document.querySelectorAll('a[class*="_listingCard_"], a[data-testid="listing-card"]');
        for (let _i = 0; _i < cards.length; _i++) {
          const card = cards[_i];
          const qtyEl = card.querySelector('[class*="_lineHeight16px_"]');
          let qty = 99;
          if (qtyEl) {
            const match = qtyEl.textContent.match(/(\d+)\s*ticket/i);
            if (match) qty = parseInt(match[1], 10);
          }
          if (qty >= minTickets) {
            const sectionEl = card.querySelector('[class*="_lineHeight18px_"]');
            const priceEl = card.querySelector('[class*="_listingCardPricingContainer_"]');
            console.log(`[TicketBot] ✅ Checkout step 1: clicking exclusive card ${_i + 1}/${cards.length}: "${sectionEl?.textContent?.trim() || '?'}" qty=${qty} price=${priceEl?.textContent?.trim() || '?'}`);
            card.click(); return true;
          }
        }
        console.log(`[TicketBot] ❌ Checkout step 1: no eligible card found (${cards.length} cards, minTickets=${minTickets})`);
        return false;
      },
      args: [config.MIN_TICKETS]
    });
    log(`🔍 Step 1 result: cardClicked=${_step1Result[0]?.result}`);

    // ── Step 2: Wait for modal ───────────────────────────────────────────
    log("Step 2: Waiting for pre-checkout modal [role='dialog']...");
    const modalWait = await waitForSelector(tabId, '[role="dialog"]', 10000);
    if (!modalWait.found) {
      log(`❌ Modal did not appear: ${modalWait.error}`, "err");
      return false;
    }
    log(`✅ Step 2: Modal appeared on tabId=${tabId}`);

    // ── Step 2a: Wait for modal CONTENT to render, then check if it's CNE or checkout ─
    // The [role="dialog"] wrapper appears instantly but the inner content (CNE text or
    // checkout button) takes time to render in React. We must wait for either signal
    // before deciding what the modal is.
    {
      log(`🔍 Step 2a: Waiting for modal content to render (CNE text or checkout button)...`);
      const modalContent = await waitForModalContent(tabId, 5000);
      log(`🔍 Step 2a: Modal content result — type=${modalContent.type}`);

      if (modalContent.type === 'card_not_eligible') {
        log("⚠️ 'Card not eligible' popup detected — dismissing and re-scanning for eligible listings...", "warn");
        // Dismiss the CNE popup
        await dismissCardNotEligible(tabId);
        // The site says "we've updated the listing to show eligible tickets"
        // Wait for the updated listings to render, then re-scan
        await new Promise(r => setTimeout(r, 2000));
        const updatedListings = await waitForSelector(tabId, '[class*="_listings_"], a[class*="_listingCard_"], a[data-testid="listing-card"]', 10000);
        if (!updatedListings.found) {
          log("❌ No eligible listings appeared after CNE dismissal — skipping.", "err");
          return false;
        }
        log("✅ Updated listings appeared — re-clicking eligible listing...");
        // Re-click the first eligible listing card
        const reClickResult = await chrome.scripting.executeScript({
          target: { tabId },
          func: (minTickets) => {
            // ── CARDHOLDER EXCLUSIVE page-level check ──
            const hasExclusiveBadge = !!document.querySelector('[class*="_exclusiveBadge_"]')
              || /cardholder exclusive/i.test(document.querySelector('[class*="_eventInfoHeader_"]')?.textContent || '');
            const listingsContainer = document.querySelector('[class*="_listings_"]');
            const cards = listingsContainer
              ? listingsContainer.querySelectorAll('a[class*="_listingCard_"], a[data-testid="listing-card"]')
              : document.querySelectorAll('a[class*="_listingCard_"], a[data-testid="listing-card"]');
            console.log(`[TicketBot] 🔍 CNE re-scan: ${cards.length} card(s), exclusive=${hasExclusiveBadge}`);
            if (!hasExclusiveBadge) {
              console.log(`[TicketBot] ⚠️ CNE re-scan: No CARDHOLDER EXCLUSIVE badge — skipping`);
              return { clicked: false, total: cards.length };
            }
            for (let _i = 0; _i < cards.length; _i++) {
              const card = cards[_i];
              const qtyEl = card.querySelector('[class*="_lineHeight16px_"]');
              let qty = 99;
              if (qtyEl) {
                const match = qtyEl.textContent.match(/(\d+)\s*ticket/i);
                if (match) qty = parseInt(match[1], 10);
              }
              if (qty >= minTickets) {
                const sectionEl = card.querySelector('[class*="_lineHeight18px_"]');
                console.log(`[TicketBot] ✅ CNE re-scan: clicking exclusive card ${_i + 1}/${cards.length}: "${sectionEl?.textContent?.trim() || '?'}" qty=${qty}`);
                card.click(); return { clicked: true, total: cards.length };
              }
            }
            return { clicked: false, total: cards.length };
          },
          args: [config.MIN_TICKETS]
        });
        const rcr = reClickResult[0]?.result;
        if (!rcr?.clicked) {
          log(`❌ No eligible cards after CNE dismissal (${rcr?.total || 0} cards, none met minTickets=${config.MIN_TICKETS}) — skipping.`, "err");
          return false;
        }
        log(`✅ Re-clicked eligible listing after CNE — waiting for new modal...`);
        // Wait for a new modal (should be the checkout modal this time)
        const newModalWait = await waitForSelector(tabId, '[role="dialog"]', 10000);
        if (!newModalWait.found) {
          log(`❌ Modal did not appear after CNE re-click: ${newModalWait.error}`, "err");
          return false;
        }
        // Wait for this new modal's content too
        await new Promise(r => setTimeout(r, 1500));
        // Check if it's ANOTHER CNE — if so, card is genuinely ineligible for all tiers
        const cne2 = await dismissCardNotEligible(tabId);
        if (cne2.found) {
          log("❌ Card not eligible on second attempt — card genuinely ineligible for all available tickets. Skipping.", "err");
          return false;
        }
        log(`✅ Step 2a: Checkout modal appeared after CNE re-scan — proceeding`);
      } else if (modalContent.type === 'checkout') {
        log(`✅ Step 2a: Checkout modal detected — proceeding`);
      } else {
        // Unknown or timeout — proceed and hope for the best
        log(`⚠️ Step 2a: Modal content type=${modalContent.type} — proceeding anyway`);
      }
    }

    // ── Step 2b: Early login check — clicking listing card may redirect immediately ─
    // Give the tab a moment to start navigating before we check the URL.
    log(`⏱️ Step 2b: Waiting 1500ms for possible redirect to settle on tabId=${tabId}`);
    await new Promise(r => setTimeout(r, 1500));
    {
      const earlyTab = await chrome.tabs.get(tabId);
      const earlyLoginRedirect = earlyTab.url.includes('verified.capitalone.com') ||
                                 earlyTab.url.includes('sign-in');
      log(`🔍 Step 2b: Early login check — tabUrl=${earlyTab.url}, redirected=${earlyLoginRedirect}`);
      if (earlyLoginRedirect) {
        log("⚠️ Login redirect triggered by listing click (before modal) — auto-logging in...");
        const loggedIn = await runLogin(tabId, config);
        if (!loggedIn) { log("❌ Early login failed — stopping checkout.", "err"); return false; }

        // Navigate back to event page and wait for it to fully settle
        const eventUrlForEarlyLogin = Object.keys(urlTabMap).find(u => urlTabMap[u] === tabId);
        if (eventUrlForEarlyLogin) {
          log(`Re-navigating to event page after early login: ${eventUrlForEarlyLogin}`);
          await chrome.tabs.update(tabId, { url: eventUrlForEarlyLogin });
          await waitForTabLoad(tabId);
          log(`⏱️ Waiting 2000ms for React to settle after early-login nav on tabId=${tabId}`);
          await new Promise(r => setTimeout(r, 2000));
          // Re-navigation resets the page — wait for card recognition again before
          // clicking a listing, or the site may show "Card not eligible".
          await waitForCardRecognition(tabId, 6000);
        }

        const listingsAfterEarlyLogin = await waitForSelector(tabId, '[class*="_listings_"]', 15000);
        if (!listingsAfterEarlyLogin.found) {
          log(`❌ Listings did not load after early login: ${listingsAfterEarlyLogin.error}`, "err");
          return false;
        }
        log("Redoing listing click after early login...");
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (minTickets) => {
            // ── CARDHOLDER EXCLUSIVE page-level check ──
            const hasExclusiveBadge = !!document.querySelector('[class*="_exclusiveBadge_"]')
              || /cardholder exclusive/i.test(document.querySelector('[class*="_eventInfoHeader_"]')?.textContent || '');
            if (!hasExclusiveBadge) {
              console.log(`[TicketBot] ⚠️ Early-login re-click: No CARDHOLDER EXCLUSIVE badge — skipping`);
              return false;
            }
            const listingsContainer = document.querySelector('[class*="_listings_"]');
            const cards = listingsContainer
              ? listingsContainer.querySelectorAll('a[class*="_listingCard_"], a[data-testid="listing-card"]')
              : document.querySelectorAll('a[class*="_listingCard_"], a[data-testid="listing-card"]');
            console.log(`[TicketBot] 🔍 Early-login re-click: ${cards.length} card(s), exclusive=true`);
            for (const card of cards) {
              const qtyEl = card.querySelector('[class*="_lineHeight16px_"]');
              let qty = 99;
              if (qtyEl) {
                const match = qtyEl.textContent.match(/(\d+)\s*ticket/i);
                if (match) qty = parseInt(match[1], 10);
              }
              if (qty >= minTickets) { card.click(); return true; }
            }
            return false;
          },
          args: [config.MIN_TICKETS]
        });

        const earlyModalRetry = await waitForSelector(tabId, '[role="dialog"]', 10000);
        if (!earlyModalRetry.found) {
          log(`❌ Modal did not appear after early-login retry: ${earlyModalRetry.error}`, "err");
          return false;
        }
      }
    }

    // ── Step 3: Set quantity + click Go to Checkout ──────────────────────
    log("Setting quantity and clicking Go to Checkout...");
    let cr = await clickQtyAndCheckout(tabId, config.DESIRED_QUANTITY || 4);
    if (!cr?.success) {
      log(`❌ Step 3 failed: ${cr?.error || "unknown error"}`, "err");
      return false;
    }
    log(`✅ Clicked checkout! Quantity: ${cr.qty}, Button text: "${cr.btnText || 'unknown'}"`);

    // ── Login check: after clicking checkout the page may redirect to login ─
    // Wait for the tab to load (navigation may take longer than a fixed 2s delay)
    log(`⏱️ Step 3 post-click: waiting for tab load on tabId=${tabId}`);
    await waitForTabLoad(tabId);
    log(`⏱️ Step 3 post-click: waiting 500ms for URL to settle`);
    await new Promise(r => setTimeout(r, 500));

    // ── Step 3b: Verify navigation actually happened ──────────────────────
    // If the page is still on the event URL (same path, just query params added),
    // the React click handler may not have fired. Retry with a longer settle and
    // direct <a> navigation fallback.
    {
      const postTab = await chrome.tabs.get(tabId);
      const stillOnEventPage = postTab.url.includes('/events/') && !postTab.url.includes('/checkout');
      const hasCheckoutSelector = await waitForSelector(tabId, 'button[class*="_checkbox_"], [class*="_completedStepItem_"], [class*="_checkoutStep_"]', 3000);
      log(`🔍 Step 3b: stillOnEventPage=${stillOnEventPage}, hasCheckoutContent=${hasCheckoutSelector.found}, tabUrl=${postTab.url}`);

      if (stillOnEventPage && !hasCheckoutSelector.found) {
        log("⚠️ Step 3b: Page did not navigate after checkout click — retrying with alternate click strategy...");
        // Wait a bit for any pending React state updates
        await new Promise(r => setTimeout(r, 1000));

        // Retry: try clicking the checkout button again, this time also trying
        // to follow its href if it's wrapped in an <a> tag
        const retryResult = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            try {
              const modal = document.querySelector('[role="dialog"]');
              // Look for checkout button or link
              const checkoutBtn =
                (modal && modal.querySelector('button[class*="_checkoutButton_"]')) ||
                (modal && Array.from(modal.querySelectorAll('button, a')).find(
                  b => /go to checkout/i.test(b.textContent.trim())
                )) ||
                document.querySelector('button[class*="_checkoutButton_"]') ||
                Array.from(document.querySelectorAll('button, a')).find(
                  b => /go to checkout/i.test(b.textContent.trim())
                );

              if (!checkoutBtn) return { success: false, error: "Checkout button not found on retry" };

              // If the element is an <a> tag or wraps one, try direct navigation
              const link = checkoutBtn.tagName === 'A' ? checkoutBtn : checkoutBtn.closest('a') || checkoutBtn.querySelector('a');
              if (link && link.href) {
                console.log(`[TicketBot] 🔍 Step 3b retry: found <a> with href=${link.href} — navigating directly`);
                window.location.href = link.href;
                return { success: true, method: 'direct_navigation', href: link.href };
              }

              // Otherwise retry the full mouse event sequence
              console.log('[TicketBot] 🔍 Step 3b retry: re-dispatching mouse events on checkout button');
              const rect = checkoutBtn.getBoundingClientRect();
              const cx = rect.left + rect.width / 2;
              const cy = rect.top + rect.height / 2;
              const eventOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
              checkoutBtn.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
              checkoutBtn.dispatchEvent(new MouseEvent('mousedown', eventOpts));
              checkoutBtn.dispatchEvent(new PointerEvent('pointerup', eventOpts));
              checkoutBtn.dispatchEvent(new MouseEvent('mouseup', eventOpts));
              checkoutBtn.dispatchEvent(new MouseEvent('click', eventOpts));
              // Also try .click() as a belt-and-suspenders fallback
              setTimeout(() => { try { checkoutBtn.click(); } catch(e) {} }, 200);
              return { success: true, method: 'retry_mouse_events' };
            } catch(e) {
              return { success: false, error: e.message };
            }
          }
        });
        const rr = retryResult[0]?.result;
        log(`🔍 Step 3b retry result: ${JSON.stringify(rr)}`);

        if (rr?.success) {
          log(`⏱️ Step 3b: waiting for tab load after retry...`);
          await waitForTabLoad(tabId);
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }

    const postCheckoutTab = await chrome.tabs.get(tabId);
    const redirectedToLogin = postCheckoutTab.url.includes('verified.capitalone.com') ||
                              postCheckoutTab.url.includes('sign-in');
    log(`🔍 Step 3 post-click: tabUrl=${postCheckoutTab.url}, redirectedToLogin=${redirectedToLogin}`);

    if (redirectedToLogin) {
      log("⚠️ Redirected to login after checkout — attempting auto-login...");
      const loggedIn = await runLogin(tabId, config);
      if (!loggedIn) {
        log("❌ Login failed — stopping checkout.", "err");
        return false;
      }
      // Check for stop after login (login is a long operation)
      if (await quickStopCheck()) return "stop";
      // Navigate back to the event page so we can redo the checkout steps
      const eventUrl = Object.keys(urlTabMap).find(u => urlTabMap[u] === tabId);
      log(`Re-navigating to event page to redo checkout after login: ${eventUrl}`);
      if (eventUrl) {
        await chrome.tabs.update(tabId, { url: eventUrl });
        await waitForTabLoad(tabId);
        // Extra settle so React fully renders before we try to interact
        log(`⏱️ Waiting 2000ms for React to settle after post-checkout login nav on tabId=${tabId}`);
        await new Promise(r => setTimeout(r, 2000));
        // Re-navigation resets the page — wait for card recognition again before
        // clicking a listing, or the site may show "Card not eligible".
        await waitForCardRecognition(tabId, 6000);
      }

      // ── Post-login content detection ─────────────────────────────────────
      // Poll continuously for up to 8 s. If a dismissible popup appears it is
      // clicked inline and we re-poll. If the qty modal or listings appear we
      // know which step to resume from. This replaces the fragile fixed-delay
      // one-shot check that previously missed popups rendered after the delay.
      log("Waiting for post-login page content (popups, modal, or listings)...");
      let postLoginState = await waitForPostLoginContent(tabId, 8000);

      // A popup was dismissed — wait briefly then re-detect the step
      if (postLoginState.state === 'popup_dismissed') {
        log("⚠️ Post-login popup dismissed — re-checking step...");
        await new Promise(r => setTimeout(r, 1000));
        postLoginState = await waitForPostLoginContent(tabId, 8000);
        // Guard against a second popup wave
        if (postLoginState.state === 'popup_dismissed') {
          log("⚠️ Second post-login popup dismissed — re-checking step...");
          await new Promise(r => setTimeout(r, 1000));
          postLoginState = await waitForPostLoginContent(tabId, 8000);
        }
      }

      log(`Post-login step detected: ${postLoginState.state}`);

      if (postLoginState.state === 'card_not_eligible') {
        // CNE immediately post-login is likely a timing issue — the site hadn't finished
        // loading the user's card before we clicked the listing. Wait for card recognition
        // then retry the listing click → modal → checkout sequence once before giving up.
        log("⚠️ 'Card not eligible' after login — likely timing issue. Waiting for card recognition and retrying once...", "warn");
        await waitForCardRecognition(tabId, 8000);
        const listingsReadyForRetry = await waitForSelector(tabId, '[class*="_listings_"], a[data-testid="listing-card"]', 10000);
        if (!listingsReadyForRetry.found) {
          log("❌ Listings not found for CNE retry — giving up.", "err");
          return false;
        }
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (minTickets) => {
            // ── CARDHOLDER EXCLUSIVE page-level check ──
            const hasExclusiveBadge = !!document.querySelector('[class*="_exclusiveBadge_"]')
              || /cardholder exclusive/i.test(document.querySelector('[class*="_eventInfoHeader_"]')?.textContent || '');
            if (!hasExclusiveBadge) {
              console.log(`[TicketBot] ⚠️ Post-login CNE retry: No CARDHOLDER EXCLUSIVE badge — skipping`);
              return false;
            }
            const listingsContainer = document.querySelector('[class*="_listings_"]');
            const cards = listingsContainer
              ? listingsContainer.querySelectorAll('a[class*="_listingCard_"], a[data-testid="listing-card"]')
              : document.querySelectorAll('a[class*="_listingCard_"], a[data-testid="listing-card"]');
            console.log(`[TicketBot] 🔍 Post-login CNE retry: ${cards.length} card(s), exclusive=true`);
            for (const card of cards) {
              const qtyEl = card.querySelector('[class*="_lineHeight16px_"]');
              let qty = 99;
              if (qtyEl) {
                const match = qtyEl.textContent.match(/(\d+)\s*ticket/i);
                if (match) qty = parseInt(match[1], 10);
              }
              if (qty >= minTickets) { card.click(); return true; }
            }
            return false;
          },
          args: [config.MIN_TICKETS]
        });
        const modalForCneRetry = await waitForSelector(tabId, '[role="dialog"]', 10000);
        if (!modalForCneRetry.found) {
          log("❌ Modal did not appear on CNE retry — giving up.", "err");
          return false;
        }
        // Check CNE again — if it's still there the card genuinely can't access this tier
        const cneRetryCheck = await dismissCardNotEligible(tabId);
        if (cneRetryCheck.found) {
          log("❌ 'Card not eligible' persists after retry — card genuinely ineligible for this ticket tier. Skipping.", "err");
          return false;
        }
        // Modal is the qty/checkout modal — fall through to the normal step2/step1 flow below
        log("✅ CNE resolved after retry — proceeding with checkout...");
        const cneRetryQty = await clickQtyAndCheckout(tabId, config.DESIRED_QUANTITY || 4);
        if (!cneRetryQty?.success) {
          log(`❌ Checkout click failed after CNE retry: ${cneRetryQty?.error}`, "err");
          return false;
        }
        log("✅ Checkout clicked after CNE retry — waiting for navigation to settle...");
        await waitForTabLoad(tabId);
        await new Promise(r => setTimeout(r, 500));
        // Skip the step2/step1 block below — fall through to step 4 (Contact Info)
      } else

      if (postLoginState.state === 'step2') {
        // Already at the quantity modal — click checkout directly
        log("Already at quantity modal — proceeding directly to checkout click...");
        const dcrr = await clickQtyAndCheckout(tabId, config.DESIRED_QUANTITY || 4);
        if (!dcrr?.success) {
          log(`❌ Direct checkout click failed: ${dcrr?.error}`, "err");
          return false;
        }
        log("✅ Checkout clicked from step 2 after login — waiting for navigation to settle...");
        // Wait for the checkout page to fully load before step 4 script injection.
        // Without this, chrome.scripting.executeScript throws "Frame with ID 0 was removed"
        // because the frame is destroyed mid-navigation.
        await waitForTabLoad(tabId);
        await new Promise(r => setTimeout(r, 500));
      } else {
        // step1, timeout, or error — attempt the full listing-click → modal → checkout flow
        if (postLoginState.state === 'timeout' || postLoginState.state === 'error') {
          log(`⚠️ Post-login state was '${postLoginState.state}' — attempting step 1 anyway...`);
        }
        const listingsReady = await waitForSelector(tabId, '[class*="_listings_"]', 15000);
        if (!listingsReady.found) {
          log(`❌ Listings did not load after login: ${listingsReady.error}`, "err");
          return false;
        }
        log("Redoing listing click and checkout after login...");
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (minTickets) => {
            // ── CARDHOLDER EXCLUSIVE page-level check ──
            const hasExclusiveBadge = !!document.querySelector('[class*="_exclusiveBadge_"]')
              || /cardholder exclusive/i.test(document.querySelector('[class*="_eventInfoHeader_"]')?.textContent || '');
            if (!hasExclusiveBadge) {
              console.log(`[TicketBot] ⚠️ Post-login re-click: No CARDHOLDER EXCLUSIVE badge — skipping`);
              return false;
            }
            const listingsContainer = document.querySelector('[class*="_listings_"]');
            const cards = listingsContainer
              ? listingsContainer.querySelectorAll('a[class*="_listingCard_"], a[data-testid="listing-card"]')
              : document.querySelectorAll('a[class*="_listingCard_"], a[data-testid="listing-card"]');
            console.log(`[TicketBot] 🔍 Post-login re-click: ${cards.length} card(s), exclusive=true`);
            for (const card of cards) {
              const qtyEl = card.querySelector('[class*="_lineHeight16px_"]');
              let qty = 99;
              if (qtyEl) {
                const match = qtyEl.textContent.match(/(\d+)\s*ticket/i);
                if (match) qty = parseInt(match[1], 10);
              }
              if (qty >= minTickets) { card.click(); return true; }
            }
            return false;
          },
          args: [config.MIN_TICKETS]
        });

        const modalRetry = await waitForSelector(tabId, '[role="dialog"]', 10000);
        if (!modalRetry.found) {
          log(`❌ Modal did not appear after login retry: ${modalRetry.error}`, "err");
          return false;
        }

        const rcr = await clickQtyAndCheckout(tabId, config.DESIRED_QUANTITY || 4);
        if (!rcr?.success) {
          log(`❌ Checkout retry after login failed: ${rcr?.error}`, "err");
          return false;
        }
        log("✅ Checkout clicked again after login — waiting for navigation to settle...");
        // Same frame-stability wait as the step2 path above.
        await waitForTabLoad(tabId);
        await new Promise(r => setTimeout(r, 500));
      } // end step1 path
    } // end if (redirectedToLogin)

    // ── Step 4: Contact Info — wait for checkbox, check it, Continue ─────
    if (await quickStopCheck()) return "stop";
    log("Waiting for Contact Info page...");
    // Try multiple selectors — the checkbox class name may have changed between deploys
    const checkboxWait = await waitForSelector(
      tabId,
      'button[class*="_checkbox_"], input[type="checkbox"], [role="checkbox"], button[aria-pressed]',
      20000
    );
    if (!checkboxWait.found) {
      // Last resort: check if we're somehow already past Contact Info (e.g. on Payment)
      const alreadyPast = await waitForSelector(tabId, '[class*="_completedStepItem_"], [class*="_billingAddressTitle_"]', 2000);
      if (alreadyPast.found) {
        log("⚠️ Contact Info checkbox not found but we appear to already be past it — continuing...");
      } else {
        log(`❌ Contact Info page did not load: ${checkboxWait.error}`, "err");
        // Log what's actually on the page for debugging
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const buttons = document.querySelectorAll('button');
            const btnTexts = Array.from(buttons).slice(0, 10).map(b => `"${b.textContent.trim().substring(0, 50)}" class=${b.className?.substring(0, 60)}`);
            console.log(`[TicketBot] 🔍 Debug: ${buttons.length} buttons on page: ${btnTexts.join(' | ')}`);
            console.log(`[TicketBot] 🔍 Debug: URL=${window.location.href}`);
            const h1s = document.querySelectorAll('h1, h2, h3');
            console.log(`[TicketBot] 🔍 Debug: headings=${Array.from(h1s).map(h => h.textContent.trim()).join(' | ')}`);
          }
        }).catch(() => {});
        return false;
      }
    }

    const contactResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          // Broader checkbox detection — handle class name changes
          const checkbox = document.querySelector('button[class*="_checkbox_"]') ||
                           document.querySelector('[role="checkbox"]') ||
                           document.querySelector('button[aria-pressed]') ||
                           document.querySelector('input[type="checkbox"]');
          const continueBtn = document.querySelector('button[class*="_nextStepButton_"]') ||
                              Array.from(document.querySelectorAll('button')).find(
                                b => b.textContent.trim().toLowerCase() === 'continue'
                              );
          const isChecked = checkbox?.getAttribute('aria-pressed') === 'true' ||
                            checkbox?.getAttribute('aria-checked') === 'true' ||
                            checkbox?.checked === true;
          console.log(`[TicketBot] 🔍 Step 4 Contact Info: checkbox=${!!checkbox} (tag=${checkbox?.tagName}, checked=${isChecked}), continueBtn=${!!continueBtn} label="${continueBtn?.textContent?.trim()}"`);
          if (!checkbox) return { success: false, error: "Acknowledgement checkbox not found" };
          if (!continueBtn) return { success: false, error: "Continue button not found on Contact Info page" };
          if (!isChecked) {
            console.log('[TicketBot] ✅ Step 4: clicking checkbox to acknowledge');
            checkbox.click();
          } else {
            console.log('[TicketBot] 🔍 Step 4: checkbox already checked');
          }
          return new Promise(resolve => {
            setTimeout(() => {
              console.log('[TicketBot] ✅ Step 4: clicking Continue on Contact Info page');
              continueBtn.click(); resolve({ success: true });
            }, 600);
          });
        } catch(e) {
          return { success: false, error: e.message };
        }
      }
    });

    const conr = contactResult[0]?.result;
    if (!conr?.success) {
      log(`❌ Step 4 failed: ${conr?.error || "unknown error"}`, "err");
      return false;
    }
    log("✅ Acknowledged and clicked Continue on Contact Info page!");

    // ── Step 5: Payment Info — wait for Continue button, click it ────────
    if (await quickStopCheck()) return "stop";
    log("Step 5: Waiting for Payment Info page (completedStepItem indicator)...");

    // Wait for the Contact Info stepper item to become completed (signals page transition)
    const paymentWait = await waitForSelector(
      tabId,
      '[class*="_completedStepItem_"]',
      15000
    );
    if (!paymentWait.found) {
      log(`❌ Payment Info page did not load: ${paymentWait.error}`, "err");
      return false;
    }
    log(`✅ Step 5: completedStepItem found — on Payment Info page`);

    // Also wait for the Continue button to be present
    log(`🔍 Step 5: waiting for Continue button (button[class*="_nextStepButton_"]) on tabId=${tabId}`);
    const paymentBtnWait = await waitForSelector(tabId, 'button[class*="_nextStepButton_"]', 10000);
    if (!paymentBtnWait.found) {
      log(`❌ Continue button not found on Payment Info page: ${paymentBtnWait.error}`, "err");
      return false;
    }

    const paymentResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          const continueBtn = document.querySelector('button[class*="_nextStepButton_"]') ||
                              Array.from(document.querySelectorAll('button')).find(
                                b => b.textContent.trim().toLowerCase() === 'continue'
                              );
          console.log(`[TicketBot] 🔍 Step 5 Payment Info: continueBtn=${!!continueBtn} label="${continueBtn?.textContent?.trim()}"`);
          if (!continueBtn) return { success: false, error: "Continue button not found on Payment Info page" };
          console.log('[TicketBot] ✅ Step 5: clicking Continue on Payment Info page');
          continueBtn.click();
          return { success: true };
        } catch(e) {
          return { success: false, error: e.message };
        }
      }
    });

    const payr = paymentResult[0]?.result;
    if (!payr?.success) {
      log(`❌ Step 5 failed: ${payr?.error || "unknown error"}`, "err");
      return false;
    }
    log("✅ Clicked Continue on Payment Info page!");

    // ── Step 6: Address — wait for Continue button, click it ─────────────
    if (await quickStopCheck()) return "stop";
    log("Step 6: Waiting for Address page (_billingAddressTitle_)...");

    // Wait for billing address content to confirm we're on the address page
    const addressWait = await waitForSelector(
      tabId,
      '[class*="_billingAddressTitle_"]',
      15000
    );
    if (!addressWait.found) {
      log(`❌ Address page did not load: ${addressWait.error}`, "err");
      return false;
    }
    log(`✅ Step 6: Address page confirmed on tabId=${tabId}`);

    log(`🔍 Step 6: waiting for Continue button on Address page`);
    const addressBtnWait = await waitForSelector(tabId, 'button[class*="_nextStepButton_"]', 10000);
    if (!addressBtnWait.found) {
      log(`❌ Continue button not found on Address page: ${addressBtnWait.error}`, "err");
      return false;
    }

    const addressResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          const continueBtn = document.querySelector('button[class*="_nextStepButton_"]') ||
                              Array.from(document.querySelectorAll('button')).find(
                                b => b.textContent.trim().toLowerCase() === 'continue'
                              );
          console.log(`[TicketBot] 🔍 Step 6 Address: continueBtn=${!!continueBtn} label="${continueBtn?.textContent?.trim()}"`);
          if (!continueBtn) return { success: false, error: "Continue button not found on Address page" };
          console.log('[TicketBot] ✅ Step 6: clicking Continue on Address page');
          continueBtn.click();
          return { success: true };
        } catch(e) {
          return { success: false, error: e.message };
        }
      }
    });

    const adr = addressResult[0]?.result;
    if (!adr?.success) {
      log(`❌ Step 6 failed: ${adr?.error || "unknown error"}`, "err");
      return false;
    }
    log("✅ Clicked Continue on Address page — landing on Confirm Order!");

    // ── Step 7: Confirm Order — waits for Pushover acknowledgement ─────
    if (await quickStopCheck()) return "stop";
    log("Step 7: Waiting for Confirm Order page (_activeStepItem_)...");

    const confirmPageWait = await waitForSelector(
      tabId,
      '[class*="_activeStepItem_"]',
      20000
    );
    if (!confirmPageWait.found) {
      log(`❌ Confirm Order page did not load: ${confirmPageWait.error}`, "err");
      return false;
    }
    log(`✅ Step 7: Confirm Order page reached on tabId=${tabId}`);

    // Scrape order summary to include in the Pushover prompt
    const orderSummary = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          // Try to find order total and ticket info on the confirm page
          const totalEl = document.querySelector('[class*="_orderTotal_"], [class*="_totalPrice_"], [class*="_total_"]');
          const sectionEl = document.querySelector('[class*="_sectionName_"], [class*="_ticketInfo_"]');
          const qtyEl = document.querySelector('[class*="_quantity_"]');
          return {
            total: totalEl?.textContent?.trim() || "",
            section: sectionEl?.textContent?.trim() || "",
            qty: qtyEl?.textContent?.trim() || ""
          };
        } catch(e) { return {}; }
      }
    });
    const summary = orderSummary[0]?.result || {};
    const summaryText = [summary.section, summary.qty, summary.total].filter(Boolean).join(" — ") || "Order ready";

    if (config.CONFIRM_ORDER) {
      // Auto-confirm mode — skip notification prompts and place order immediately
      log("CONFIRM_ORDER=true — auto-placing order...");
    } else {
      // ── Phone control flow: Pushover buzzes + control page + ntfy command ──
      // 1. Pushover emergency = gets your attention (buzzes every 30s)
      // 2. Supplementary URL opens control page in phone browser
      // 3. Control page buttons POST commands to ntfy.sh
      // 4. Bot polls ntfy.sh for the command

      // Get the event URL for context in the control page
      let eventUrl = "";
      try { const t = await chrome.tabs.get(tabId); eventUrl = t?.url || ""; } catch(e) {}

      const topic = config.NTFY_TOPIC || ntfyTopic;
      // Use configured PIN (from defaults.json or popup config)
      const orderPin = config.NTFY_PIN || ntfyPin || "";
      const ctrlUrl = buildControlUrl(summaryText, eventUrl, orderPin);

      if (!topic) {
        log("⚠️ No ntfy topic configured — falling back to Pushover-only (acknowledge = confirm, expire = skip).", "warn");
        // Fallback: old Pushover-only receipt polling
        const poCommand = await sendPushoverPrompt(
          "🎟️ Ready to Place Order!",
          `${summaryText}\n\nACKNOWLEDGE to confirm. Ignore to skip.`,
          180000
        );
        if (poCommand === "skip") {
          log("📱 Pushover expired — order SKIPPED.");
          sendPushoverAlert("⏭️ Order Skipped", "No acknowledgement. Order was not placed.");
          return "skip";
        }
        if (poCommand !== "confirm") {
          log("📱 No confirmation received — leaving checkout page open.");
          sendPushoverAlert("⏰ Confirmation Timed Out", "Checkout page still open for manual action.");
          return "timeout";
        }
        log("📱 CONFIRMED via Pushover — placing order!");
      } else {
        // ── Primary flow: Pushover alert + ntfy command channel ──
        log(`📱 Sending Pushover emergency with control page link...`);
        log(`📡 Polling ntfy.sh/${topic} for Confirm / Skip / Stop...`);

        // Send Pushover emergency — supplementary URL opens control page
        activeEmergencyReceipt = await sendPushoverAlert(
          "🎟️ Ready to Place Order!",
          `${summaryText}\n\nTap to open control page → Confirm / Skip / Stop`,
          ctrlUrl || undefined, // supplementary URL
          2 // emergency priority
        );

        // Poll ntfy for the command (with PIN verification)
        const command = await pollNtfyCommand(topic, orderPin, 180000);

        // Cancel the emergency buzzing now that we have a response
        await cancelPushoverEmergency();

        if (command === "stop") {
          log("🛑 STOP command received — stopping bot entirely.");
          if (config.TEST_MODE) {
            try { await chrome.scripting.executeScript({ target: { tabId }, func: (m) => { window.__ticketBotToast && window.__ticketBotToast(m); }, args: ["🛑 STOP BOT\nCommand received from phone — shutting down."] }); } catch(e) {}
          }
          sendPushoverAlert("🛑 Bot Stopped", "Stop command received from control page. Bot is shutting down.");
          stopRequested = true;
          stopBot();
          return "stop";
        }
        if (command === "skip") {
          log("⏭️ SKIP command received — order skipped.");
          if (config.TEST_MODE) {
            try { await chrome.scripting.executeScript({ target: { tabId }, func: (m) => { window.__ticketBotToast && window.__ticketBotToast(m); }, args: [`⏭️ SKIP ORDER\n${summaryText}\nMoving to next event...`] }); } catch(e) {}
          }
          sendPushoverAlert("⏭️ Order Skipped", `${summaryText}\nSkipped via control page.`);
          return "skip";
        }
        if (command !== "confirm") {
          log("📡 No command received — leaving checkout page open for manual action.");
          if (config.TEST_MODE) {
            try { await chrome.scripting.executeScript({ target: { tabId }, func: (m) => { window.__ticketBotToast && window.__ticketBotToast(m); }, args: ["⏰ TIMED OUT\nNo command received — page left open for manual action."] }); } catch(e) {}
          }
          sendPushoverAlert("⏰ Confirmation Timed Out", "No response received. Checkout page is still open.");
          return "timeout";
        }
        log("✅ CONFIRM command received — placing order!");
        if (config.TEST_MODE) {
          try { await chrome.scripting.executeScript({ target: { tabId }, func: (m) => { window.__ticketBotToast && window.__ticketBotToast(m); }, args: [`✅ PLACE ORDER\n${summaryText}\n(TEST MODE — order will NOT be placed)`] }); } catch(e) {}
        }
      }
    }

    // ── TEST_MODE: flash green instead of clicking Place Order ──────────
    if (config.TEST_MODE) {
      log("🧪 TEST MODE — flashing green overlay, then simulating confirmation page in 5s...");
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (summary) => {
          // Big green overlay so it's unmissable
          const overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;flex-direction:column;background:rgba(16,185,129,0.92);transition:opacity 1s;';
          overlay.innerHTML = '<div style="font-size:72px;">✅</div><div style="font-size:28px;color:#fff;font-weight:bold;margin-top:16px;">TEST MODE — Order would be placed here</div><div style="font-size:16px;color:rgba(255,255,255,0.8);margin-top:8px;">Place Order button was NOT clicked</div><div style="font-size:14px;color:rgba(255,255,255,0.5);margin-top:12px;">Simulating confirmation page in 5s...</div>';
          document.body.appendChild(overlay);

          // After 5s, replace overlay with a simulated confirmation page
          setTimeout(() => {
            overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;flex-direction:column;background:#0a0a0f;color:#e8e8f0;font-family:-apple-system,system-ui,sans-serif;';
            overlay.innerHTML = `
              <div style="text-align:center;max-width:500px;padding:40px;">
                <div style="font-size:64px;margin-bottom:16px;">🎉</div>
                <div style="font-size:24px;font-weight:700;color:#10b981;margin-bottom:12px;">Order Confirmed!</div>
                <div style="font-size:14px;color:#7070a0;margin-bottom:20px;">TEST MODE — No real order was placed</div>
                <div style="background:#13131a;border:1px solid #2a2a3a;border-radius:12px;padding:16px;margin-bottom:16px;">
                  <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#7070a0;margin-bottom:8px;">Order Summary</div>
                  <div style="font-size:16px;font-weight:600;">${summary}</div>
                </div>
                <div style="background:#13131a;border:1px solid #2a2a3a;border-radius:12px;padding:16px;">
                  <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#7070a0;margin-bottom:8px;">Confirmation Number</div>
                  <div style="font-size:20px;font-weight:700;font-family:monospace;color:#a78bfa;">TEST-${Date.now().toString(36).toUpperCase()}</div>
                </div>
              </div>`;
            // Mark the page so the confirmation detector picks it up
            document.title = 'Order Confirmed — TEST MODE';
          }, 5000);
        },
        args: [summaryText]
      });
      sendPushoverAlert("🧪 TEST: Order Would Be Placed", `${summaryText}\nTest mode — Place Order was NOT clicked. Simulating confirmation...`);

      // Wait for the simulated confirmation page (5s delay + detection)
      log("⏳ Waiting for simulated confirmation page...");
      await new Promise(r => setTimeout(r, 6000)); // wait for the 5s timeout + 1s buffer
      log("✅ TEST MODE — simulated order confirmation detected.");
      sendPushoverAlert("🧪 TEST: Order Confirmed!", `${summaryText}\nTest mode confirmation simulated successfully.`);
      return true;
    }

    // ── LIVE MODE: actually click Place Order ─────────────────────────────
    const placeOrderWait = await waitForSelector(
      tabId,
      'button[class*="_buttonTextContainedGreen"]',
      10000
    );
    if (!placeOrderWait.found) {
      log(`❌ Place Order button did not appear: ${placeOrderWait.error}`, "err");
      return false;
    }

    const confirmResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          const confirmBtn =
            Array.from(document.querySelectorAll('button[class*="_nextStepButton_"]')).find(
              b => b.textContent.trim().toLowerCase().includes('place order')
            ) ||
            Array.from(document.querySelectorAll('button[class*="_buttonTextContainedGreen"]')).find(
              b => b.textContent.trim().toLowerCase().includes('place order')
            ) ||
            Array.from(document.querySelectorAll('button')).find(
              b => b.textContent.trim().toLowerCase().includes('place order')
            );
          if (!confirmBtn) return { success: false, error: "Place Order button not found" };
          console.log(`[TicketBot] ✅ Step 7: clicking Place Order — "${confirmBtn.textContent.trim()}"`);
          confirmBtn.click();
          return { success: true, label: confirmBtn.textContent.trim() };
        } catch(e) {
          return { success: false, error: e.message };
        }
      }
    });

    const confr = confirmResult[0]?.result;
    if (!confr?.success) {
      log(`❌ Step 7 failed: ${confr?.error || "unknown error"}`, "err");
      return false;
    }
    log(`✅ Place Order clicked: "${confr.label}" — waiting for confirmation page...`);

    // Wait for the page to navigate to an order confirmation / success state.
    // Capital One typically redirects or renders a confirmation section.
    // We poll for up to 30 seconds looking for common confirmation signals.
    const confirmationStart = Date.now();
    const confirmationTimeout = 10000;
    let orderConfirmed = false;
    let confirmationDetails = "";

    while (Date.now() - confirmationStart < confirmationTimeout) {
      try {
        const pageCheck = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            try {
              const url = window.location.href.toLowerCase();
              const body = document.body?.innerText?.toLowerCase() || "";

              // Check URL for confirmation indicators
              const urlConfirmed = /confirm|success|complete|receipt|thank/i.test(url);

              // Check page content for confirmation signals
              const textConfirmed =
                /order\s*(is\s*)?(confirmed|complete|placed|successful)/i.test(body) ||
                /thank\s*you\s*for\s*(your\s*)?(order|purchase)/i.test(body) ||
                /confirmation\s*number/i.test(body) ||
                /order\s*number/i.test(body) ||
                /you('re|\s*are)\s*all\s*set/i.test(body);

              // Check for confirmation-specific elements
              const confirmEl =
                document.querySelector('[class*="_orderConfirm"]') ||
                document.querySelector('[class*="_confirmationPage"]') ||
                document.querySelector('[class*="_successPage"]') ||
                document.querySelector('[class*="_receiptPage"]') ||
                document.querySelector('[data-testid*="confirmation"]') ||
                document.querySelector('[data-testid*="success"]');

              // Try to grab a confirmation/order number
              let confNumber = "";
              const confMatch = body.match(/(?:confirmation|order)\s*(?:number|#|:)\s*([A-Z0-9-]+)/i);
              if (confMatch) confNumber = confMatch[1];

              const confirmed = urlConfirmed || textConfirmed || !!confirmEl;
              return { confirmed, url: window.location.href, confNumber };
            } catch(e) {
              return { confirmed: false, error: e.message };
            }
          }
        });

        const result = pageCheck[0]?.result;
        if (result?.confirmed) {
          orderConfirmed = true;
          confirmationDetails = result.confNumber ? ` (Confirmation #${result.confNumber})` : "";
          log(`✅ Order confirmation page detected!${confirmationDetails} URL: ${result.url}`);
          break;
        }
      } catch(e) {
        // Tab might be navigating — keep polling
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    if (orderConfirmed) {
      log(`🎉 Order confirmed!${confirmationDetails}`);
      sendPushoverAlert(
        "🎉 Order Confirmed!",
        `${summaryText}${confirmationDetails}\nOrder has been confirmed successfully.`
      );
    } else {
      // Place Order was clicked but we couldn't verify the confirmation page.
      // Still return true — the click went through, just couldn't verify the result.
      log("⚠️ Place Order was clicked but confirmation page not detected within 10s. Order may still have gone through.", "warn");
      sendPushoverAlert(
        "⚠️ Order Submitted — Unverified",
        `${summaryText}\nPlace Order was clicked but the confirmation page didn't load. Check your email for confirmation.`
      );
    }

    return true;

  } catch(e) {
    let _checkoutTabUrl = 'unknown';
    try { const _ct = await chrome.tabs.get(tabId); _checkoutTabUrl = _ct?.url || 'unknown'; } catch {}
    log(`❌ Checkout error on tabId=${tabId} (tabUrl=${_checkoutTabUrl}): ${e.message}`, "err");
    return false;
  }
}

// ── Message Handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "START_BOT") {
    startBot(msg.config);
    sendResponse({ ok: true });
  } else if (msg.type === "STOP_BOT") {
    stopBot();
    sendResponse({ ok: true });
  } else if (msg.type === "GET_STATUS") {
    sendResponse({ active: botActive, status: lastStatus, checkCount });
  }
  return true;
});

// ── Restore after service worker restart ───────────────────────────────────
chrome.storage.local.get(["botConfig", "botWasActive"], ({ botConfig, botWasActive }) => {
  if (botWasActive && botConfig) {
    log("Restoring bot after service worker restart...");
    startBot(botConfig);
  }
});

setInterval(() => {
  chrome.storage.local.set({ botWasActive: botActive });
}, 10000);

// ── Keepalive — prevents Chrome from suspending the service worker ─────────
// Chrome MV3 kills idle service workers after ~30s. We ping chrome.storage
// every 25s to keep the worker alive while the bot is running.
// The chrome.alarms API will still wake us up if we do get suspended,
// but this prevents missed checks during the wake-up gap.
setInterval(() => {
  if (botActive) {
    chrome.storage.local.get("botWasActive", () => {
      // Just reading storage is enough to reset the idle timer
    });
  }
}, 25000);

// Also use a 1-minute alarm as a secondary heartbeat to ensure the service
// worker is revived even if the keepalive interval somehow stops
chrome.alarms.create("keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    // Revive the worker and re-attach the tick alarm if it somehow got lost
    if (botActive) {
      chrome.alarms.get("ticketCheck", (existing) => {
        if (!existing) {
          chrome.storage.local.get("botConfig", ({ botConfig }) => {
            if (botConfig && botActive) {
              log("⚠️ Ticket check alarm was missing — restoring...", "warn");
              chrome.alarms.create("ticketCheck", {
                periodInMinutes: botConfig.POLL_INTERVAL_MINUTES || 5
              });
            }
          });
        }
      });
    }
  }
});
