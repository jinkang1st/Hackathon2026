import "../shared.js";
const core = globalThis.PauseCore;
const $ = id => document.getElementById(id);
function message(text, error = false) { $("message").textContent = text; $("message").className = `message${error ? " error" : ""}`; }
async function readForm() {
  const current = core.settings((await chrome.storage.local.get("settings")).settings);
  return core.validateSettings({ ...current, thresholdGBP: Number($("threshold").value), apiBaseUrl: $("base-url").value, apiModel: $("model").value, apiKey: $("api-key").value });
}
$("settings-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("save").disabled = true;
  try {
    const settings = await readForm();
    await chrome.storage.local.set({ settings });
    message(settings.apiBaseUrl ? "Settings saved. Open pages will apply your new rules." : "Settings saved. Local price checks are active; you can add AI later.");
  } catch (e) { message(e.message, true); }
  finally { $("save").disabled = false; }
});
$("test").addEventListener("click", async () => {
  $("test").disabled = true;
  message("Testing the local model and response format…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "TEST_API", settings: await readForm() });
    if (!response?.ok) throw new Error(response?.error || "Connection failed. Please check your server.");
    message("Connected. The response format is valid. Save settings to use this connection.");
  } catch (e) { message(e.message, true); }
  finally { $("test").disabled = false; }
});
try {
  const settings = core.settings((await chrome.storage.local.get("settings")).settings);
  $("threshold").value = settings.thresholdGBP;
  $("base-url").value = settings.apiBaseUrl;
  $("model").value = settings.apiModel;
  $("api-key").value = settings.apiKey;
} catch (e) { message(e.message, true); }
