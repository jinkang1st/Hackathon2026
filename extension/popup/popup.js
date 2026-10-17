import "../shared.js";
const core = globalThis.PauseCore;
const $ = id => document.getElementById(id);
let settings;
let tabId;
function message(text, error = false) { $("message").textContent = text; $("message").className = `message${error ? " error" : ""}`; }

async function refreshStatus() {
  const stored = await chrome.storage.local.get("settings");
  settings = core.settings(stored.settings);
  $("enabled").checked = settings.enabled;
  const configured = !!(settings.apiBaseUrl && settings.apiModel);
  $("protection-label").textContent = !settings.enabled ? "Paused. Ready when you are." : !configured ? "On · local price check" : "On. Watching as you browse.";
  $("scan").disabled = !settings.enabled;
  const status = tabId != null ? (await chrome.storage.session.get(`status:${tabId}`))[`status:${tabId}`] : null;
  const labels = { scanning: "Your local AI is reading this page…", clear: "No items at your alert amount found in this scan.", warning: `${status?.count || 1} item(s) reach your alert amount.`, error: status?.message, waiting: "Waiting to analyse page content.", disabled: "Shopping protection is paused.", unconfigured: "Add your local API URL and model in Settings." };
  const statusText = labels[status?.state] || "Open or refresh a webpage to start scanning.";
  $("page-status").textContent = !settings.enabled ? labels.disabled : (status?.source === "local" ? `Local price check · ${statusText}${configured ? " AI unavailable; retrying shortly." : ""}` : statusText);
  $("dot").className = `status-dot${!settings.enabled ? " off" : !configured || ["error", "warning"].includes(status?.state) ? " pending" : ""}`;
}

async function save(update) {
  const current = core.settings((await chrome.storage.local.get("settings")).settings);
  await chrome.storage.local.set({ settings: core.validateSettings({ ...current, ...update }) });
  await refreshStatus();
}
$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("enabled").addEventListener("change", async () => {
  const enabled = $("enabled").checked;
  $("enabled").disabled = true;
  try { await save({ enabled }); message(enabled ? "Shopping protection is on." : "Shopping protection is paused."); }
  catch (e) { message(e.message, true); }
  finally { $("enabled").disabled = false; }
});
$("threshold-form").addEventListener("submit", async event => {
  event.preventDefault();
  try { await save({ thresholdGBP: Number($("threshold").value) }); message("Amount saved. Open pages will be scanned again."); }
  catch (e) { message(e.message, true); }
});
async function sendToPage(type) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type });
    if (!response?.ok) throw new Error();
    if (type === "PREVIEW") window.close();
    else { message("A fresh scan has been requested."); setTimeout(refreshStatus, 200); }
  } catch { message("Open a regular webpage and refresh it first. Browser settings pages are not supported.", true); }
}
$("scan").addEventListener("click", () => sendToPage("SCAN_NOW"));
$("preview").addEventListener("click", () => sendToPage("PREVIEW"));
chrome.storage.onChanged.addListener(() => refreshStatus().catch(() => {}));
try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  await refreshStatus();
  $("threshold").value = settings.thresholdGBP;
} catch (e) { message(e.message, true); }
