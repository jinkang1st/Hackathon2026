import "./shared.js";
import { analyzePage } from "./api.js";
const core = globalThis.PauseCore;
const jobs = new Map();
let revision = 0;
let unavailableUntil = 0;
let unavailableReason = "";

// Keys stay in trusted extension contexts; content scripts only receive public settings.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
const readSettings = async () => {
  await storageReady;
  return core.settings((await chrome.storage.local.get("settings")).settings);
};

async function setStatus(tabId, status) {
  await chrome.storage.session.set({ [`status:${tabId}`]: { ...status, updatedAt: Date.now() } });
  const badge = { warning: "!", error: "?", unconfigured: "…", scanning: "·" }[status.state] || "";
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text: badge }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: status.state === "warning" ? "#ba5b38" : "#536960" })
  ]);
}

async function handle(message, sender) {
  if (!message || typeof message.type !== "string") return;
  const tabId = sender.tab?.id;
  const trusted = !sender.tab && sender.url?.startsWith(chrome.runtime.getURL(""));
  const extensionPage = sender.url?.startsWith(chrome.runtime.getURL(""));
  if (message.type === "GET_SETTINGS") return { ok: true, settings: core.publicSettings(await readSettings()) };
  if (message.type === "OPEN_OPTIONS") { await chrome.runtime.openOptionsPage(); return { ok: true }; }
  if (message.type === "TEST_API" && extensionPage) {
    const s = core.validateSettings(message.settings);
    await analyzePage(s, { url: "https://example.invalid/", title: "Connection test", html: "<p>No products.</p>", text: "No products." });
    return { ok: true };
  }
  if (message.type === "RESET_PAGE" && Number.isInteger(tabId)) {
    jobs.get(tabId)?.controller.abort();
    jobs.delete(tabId);
    await setStatus(tabId, { state: "waiting", message: "Waiting for page analysis" });
    return { ok: true };
  }
  if (message.type !== "ANALYZE" || !Number.isInteger(tabId) || sender.frameId !== 0 || trusted) return { ok: false, error: "Unsupported request." };
  const requestRevision = revision;
  const s = await readSettings();
  if (requestRevision !== revision) return { ok: true, state: "stale", products: [] };
  if (!s.enabled) { await setStatus(tabId, { state: "disabled" }); return { ok: true, state: "disabled", products: [] }; }
  const page = core.snapshot(message.page);
  if (page.url !== core.cleanUrl(sender.url)) throw new Error("The page changed. Please scan again.");
  async function fallback(reason, retryInMs = 0) {
    const products = core.localPriceCheck(page, s.thresholdGBP);
    await setStatus(tabId, { state: products.length ? "warning" : "clear", source: "local", count: products.length, message: reason, url: page.url });
    return { ok: true, state: "complete", source: "local", products, retryInMs };
  }
  if (!s.apiBaseUrl || !s.apiModel) return fallback("AI is not configured. Using a local price check.");
  if (Date.now() < unavailableUntil) return fallback(unavailableReason, unavailableUntil - Date.now());
  jobs.get(tabId)?.controller.abort();
  const job = { controller: new AbortController(), revision: requestRevision };
  jobs.set(tabId, job);
  await setStatus(tabId, { state: "scanning", url: page.url });
  try {
    const products = await analyzePage(s, page, { signal: job.controller.signal });
    if (jobs.get(tabId) !== job || job.revision !== revision) return { ok: true, state: "stale", products: [] };
    unavailableUntil = 0;
    await setStatus(tabId, { state: products.length ? "warning" : "clear", source: "ai", count: products.length, url: page.url });
    return { ok: true, state: "complete", source: "ai", products };
  } catch (error) {
    if (jobs.get(tabId) !== job || job.revision !== revision) return { ok: true, state: "stale", products: [] };
    unavailableUntil = Date.now() + 30000;
    unavailableReason = error.message;
    return fallback(error.message, 30000);
  } finally {
    if (jobs.get(tabId) === job) jobs.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(respond).catch(error => respond({ ok: false, error: error.message }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  revision++;
  unavailableUntil = 0;
  unavailableReason = "";
  for (const job of jobs.values()) job.controller.abort();
  jobs.clear();
  const s = core.publicSettings(changes.settings.newValue);
  chrome.tabs.query({}).then(tabs => Promise.allSettled(tabs.map(async tab => {
    await setStatus(tab.id, { state: !s.enabled ? "disabled" : "waiting", source: !s.configured ? "local" : "ai" });
    await chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_CHANGED", settings: s });
  })));
});

chrome.tabs.onRemoved.addListener(tabId => {
  jobs.get(tabId)?.controller.abort();
  jobs.delete(tabId);
  chrome.storage.session.remove(`status:${tabId}`);
});
