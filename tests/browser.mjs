import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoServer } from "../scripts/demo-server.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "test-results"), { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), "pause-browser-"));
const requests = [];
let mode = "success";
let delay = 0;
const api = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  assert.equal(req.url, "/v1/chat/completions");
  const body = JSON.parse(raw);
  const snapshot = JSON.parse(body.messages[1].content);
  requests.push({ body, snapshot, headers: req.headers });
  const thisMode = mode;
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  res.setHeader("Content-Type", "application/json");
  if (thisMode === "error") { res.writeHead(503); res.end("{}"); return; }
  if (thisMode === "invalid") { res.end(JSON.stringify({ choices: [{ message: { content: "not JSON" } }] })); return; }
  // Deliberately a deterministic test double, not an AI implementation or production fallback.
  const price = snapshot.html.match(/<p>£([\d,]+)<\/p>/);
  const products = price ? [{ name: "Studio One", price: Number(price[1].replaceAll(",", "")), currency: "GBP", priceType: "total", evidence: `£${price[1]}` }] : [];
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ products }) } }] }));
});
const demo = createDemoServer();
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const apiPort = await listen(api);
const demoPort = await listen(demo);
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, viewport: { width: 1360, height: 960 },
    args: [`--disable-extensions-except=${path.join(root, "extension")}`, `--load-extension=${path.join(root, "extension")}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).host;
  const errors = [];
  context.on("weberror", error => errors.push(error.error().message));
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options/options.html`);
  await expect(options.locator("#base-url")).toHaveValue("");
  await expect(options.locator("#model")).toHaveValue("");
  await expect(options.locator("#threshold")).toHaveValue("1000");
  await options.screenshot({ path: path.join(root, "test-results/settings.png"), fullPage: true, animations: "disabled" });
  const offlineShop = await context.newPage();
  await offlineShop.goto(`http://127.0.0.1:${demoPort}/`);
  await offlineShop.bringToFront();
  await expect(offlineShop.getByRole("dialog")).toBeVisible({ timeout: 10000 });
  await expect(offlineShop.getByRole("dialog")).toContainText("Local price check");
  await expect(offlineShop.getByRole("dialog")).toContainText("£1,299");
  assert.equal(requests.length, 0, "blank configuration must use local detection without network requests");
  await offlineShop.screenshot({ path: path.join(root, "test-results/local-reminder.png"), fullPage: true, animations: "disabled" });
  await offlineShop.close();
  await options.bringToFront();
  console.log("PASS: blank API configuration immediately uses local price detection without network requests");
  await options.locator("#base-url").fill(`http://127.0.0.1:${apiPort}/v1`);
  await options.locator("#model").fill("test-model");
  await options.locator("#api-key").fill("test-only-key");
  await options.locator("#test").click();
  await expect(options.locator("#message")).toContainText("Connected", { timeout: 10000 });
  await options.locator("#save").click();
  await expect(options.locator("#message")).toContainText("Settings saved");
  console.log("PASS: empty defaults, configuration and API connection test");

  const shop = await context.newPage();
  await shop.goto(`http://127.0.0.1:${demoPort}/?private=do-not-send#private`);
  await shop.bringToFront();
  const dialog = shop.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 15000 });
  await expect(dialog).toContainText("£1,299");
  await expect(dialog).toContainText("£299 over your amount");
  await shop.screenshot({ path: path.join(root, "test-results/reminder.png"), fullPage: true, animations: "disabled" });
  assert(!requests.at(-1).snapshot.url.includes("private"));
  assert.equal(requests.at(-1).headers.authorization, "Bearer test-only-key");
  await shop.getByRole("button", { name: "Continue browsing", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const before = requests.length;
  await shop.waitForTimeout(5500);
  assert.equal(requests.length, before, "unchanged page must not trigger another API request");
  console.log("PASS: actual content-script → service-worker → local API → reminder; no unchanged-page requests");

  await shop.getByRole("button", { name: "Below threshold", exact: true }).click();
  await expect.poll(() => requests.length, { timeout: 12000 }).toBeGreaterThan(before);
  await shop.waitForTimeout(300);
  await expect(dialog).toHaveCount(0);
  await shop.getByRole("button", { name: "At threshold", exact: true }).click();
  await expect(dialog).toBeVisible({ timeout: 12000 });
  await expect(dialog).toContainText("Alert amount reached");
  await shop.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await shop.getByRole("button", { name: "Above threshold", exact: true }).click();
  await expect(dialog).toBeVisible({ timeout: 12000 });
  await expect(dialog).toContainText("£1,499");
  console.log("PASS: dynamic prices below, at and above threshold; Escape dismisses");

  // Use the real popup page to test the toggle and threshold controls.
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 370, height: 600 });
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  await expect(popup.locator("#enabled")).toBeChecked();
  await popup.waitForTimeout(200);
  assert(await popup.evaluate(() => document.documentElement.scrollHeight <= 600), "popup should fit Chrome's height limit");
  await popup.screenshot({ path: path.join(root, "test-results/popup.png"), fullPage: true, animations: "disabled" });
  await popup.locator("#enabled").uncheck();
  await expect(popup.locator("#protection-label")).toContainText("Paused");
  await expect(dialog).toHaveCount(0);
  await shop.bringToFront();
  const pausedCount = requests.length;
  await shop.getByRole("button", { name: "Below threshold", exact: true }).click();
  await shop.waitForTimeout(5500);
  assert.equal(requests.length, pausedCount);
  await popup.bringToFront();
  await popup.locator("#threshold").fill("500");
  await popup.getByRole("button", { name: "Save", exact: true }).click();
  await expect(popup.locator("#message")).toContainText("Amount saved");
  await popup.locator("#enabled").check();
  await expect(popup.locator("#protection-label")).toContainText("On.");
  await shop.bringToFront();
  await expect(dialog).toBeVisible({ timeout: 12000 });
  await expect(dialog).toContainText("£799");
  await expect(dialog).toContainText("£500");
  await shop.getByRole("button", { name: "Give me a moment", exact: true }).click();
  console.log("PASS: disable stops requests and closes the dialog; new amount applies immediately");

  // Observe real sanitised payload after adding sensitive and hidden content.
  await shop.evaluate(() => {
    const fixture = document.createElement("section");
    fixture.innerHTML = '<input value="INPUT_PRIVATE"><textarea>TEXTAREA_PRIVATE</textarea><div contenteditable="true">EDITABLE_PRIVATE</div><div hidden>HIDDEN_PRIVATE £5000</div><script>const token="SCRIPT_PRIVATE";</script><p>Visible test text</p>';
    document.body.append(fixture);
  });
  await expect.poll(() => JSON.stringify(requests.at(-1).snapshot), { timeout: 12000 }).toContain("Visible test text");
  for (const marker of ["INPUT_PRIVATE", "TEXTAREA_PRIVATE", "EDITABLE_PRIVATE", "HIDDEN_PRIVATE", "SCRIPT_PRIVATE"]) assert(!JSON.stringify(requests.at(-1).snapshot).includes(marker));
  await expect(dialog).toHaveCount(0);
  console.log("PASS: form fields, editable content, hidden content and scripts excluded; same item stays dismissed");

  await shop.getByRole("button", { name: "Simulate navigation", exact: true }).click();
  await expect(dialog).toBeVisible({ timeout: 12000 });
  await shop.getByRole("button", { name: "Continue browsing", exact: true }).click();
  mode = "invalid";
  await shop.getByRole("button", { name: "Above threshold", exact: true }).click();
  await expect(dialog).toBeVisible({ timeout: 12000 });
  await expect(dialog).toContainText("Local price check");
  await expect(dialog).toContainText("£1,499");
  await expect.poll(async () => {
    return worker.evaluate(async () => Object.values(await chrome.storage.session.get(null)).some(s => s.source === "local" && s.message?.includes("invalid JSON")));
  }, { timeout: 12000 }).toBe(true);
  await shop.getByRole("button", { name: "Continue browsing", exact: true }).click();
  console.log("PASS: SPA navigation resets reminders; invalid AI output switches to local price detection");

  // Recovery is automatic even when the content itself is unchanged.
  mode = "success";
  await expect.poll(async () => worker.evaluate(async () => Object.values(await chrome.storage.session.get(null)).some(s => s.source === "ai" && s.state === "warning" && s.count === 1)), { timeout: 40000, intervals: [1000] }).toBe(true);
  await expect(dialog).toHaveCount(0);
  console.log("PASS: AI recovery after backoff does not repeat a dismissed fallback reminder");

  mode = "error";
  await popup.bringToFront();
  await popup.locator("#threshold").fill("1400");
  await popup.getByRole("button", { name: "Save", exact: true }).click();
  await expect(popup.locator("#message")).toContainText("Amount saved");
  await shop.bringToFront();
  await expect(dialog).toBeVisible({ timeout: 12000 });
  await expect(dialog).toContainText("Local price check");
  assert(await worker.evaluate(async () => Object.values(await chrome.storage.session.get(null)).some(s => s.source === "local" && s.message?.includes("HTTP 503"))));
  await shop.getByRole("button", { name: "Continue browsing", exact: true }).click();
  console.log("PASS: unavailable API (HTTP 503) preserves protection with local detection");

  mode = "success";
  delay = 2000;
  await popup.bringToFront();
  await popup.locator("#threshold").fill("600");
  await popup.getByRole("button", { name: "Save", exact: true }).click();
  await shop.bringToFront();
  await expect.poll(async () => worker.evaluate(async () => Object.values(await chrome.storage.session.get(null)).some(s => s.state === "scanning")), { timeout: 12000 }).toBe(true);
  await popup.bringToFront();
  await popup.locator("#enabled").uncheck();
  await expect(popup.locator("#protection-label")).toContainText("Paused");
  await shop.bringToFront();
  await shop.waitForTimeout(2600);
  await expect(dialog).toHaveCount(0);
  console.log("PASS: disabling while the model is running discards the late response");

  // Direct extraction fixture covers schema.org offers and split price markup.
  const fixture = await context.newPage();
  await fixture.goto(`http://127.0.0.1:${demoPort}/`);
  await fixture.setContent('<title>Metadata test</title><h1>Product</h1><p><span>£</span><span>1,200</span></p><del><span>£2,000</span></del><script type="application/ld+json">{"@type":"Product","name":"Camera","offers":{"@type":"Offer","price":"1500","priceCurrency":"GBP"}}</script><input value="NEVER_SEND">');
  await fixture.addScriptTag({ content: await readFile(path.join(root, "extension/shared.js"), "utf8") });
  await fixture.addScriptTag({ content: await readFile(path.join(root, "extension/extractor.js"), "utf8") });
  const extracted = await fixture.evaluate(() => PauseExtractor.extractPage());
  assert(extracted.text.includes("GBP 1500"));
  assert(extracted.text.includes("£ 1,200"));
  assert(extracted.html.includes("<del>£2,000</del>"));
  assert(!JSON.stringify(extracted).includes("NEVER_SEND"));
  assert.deepEqual(await fixture.evaluate(() => PauseCore.localPriceCheck(PauseExtractor.extractPage(), 1000).map(p => p.price)), [1500, 1200]);
  assert.deepEqual(errors, []);
  console.log("PASS: structured product metadata, split prices, no unhandled browser errors");
  console.log("All browser checks passed. Screenshots are in test-results/.");
} finally {
  await context?.close();
  api.closeAllConnections(); demo.closeAllConnections();
  await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => demo.close(resolve))]);
  await rm(profile, { recursive: true, force: true });
}
