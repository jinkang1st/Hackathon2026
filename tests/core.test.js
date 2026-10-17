import test from "node:test";
import assert from "node:assert/strict";
import "../extension/shared.js";
import { analyzePage, buildRequest } from "../extension/api.js";
const core = globalThis.PauseCore;
const page = { url: "https://shop.example/item", title: "Headphones", html: "<p>£1,299</p>", text: "Headphones £1,299. Lower price £999. GBP 1000. Monthly £120. Original £2,000." };
const item = { name: "Headphones", price: 1299, currency: "GBP", priceType: "total", evidence: "£1,299" };
const parse = (products, threshold = 1000) => core.parseAnalysis(JSON.stringify({ products }), page, threshold);
const settings = { ...core.defaults, apiBaseUrl: "http://localhost:1234/v1", apiModel: "local-model" };

test("settings start enabled at £1,000 with API configuration blank", () => {
  assert.deepEqual(core.settings(), core.defaults);
  assert.deepEqual(core.publicSettings({ ...settings, apiKey: "secret" }), { enabled: true, thresholdGBP: 1000, configured: true });
  for (const thresholdGBP of [0, -1, NaN, Infinity, 1000000001, 0.001]) assert.throws(() => core.validateSettings({ thresholdGBP }));
  assert.equal(core.validateSettings({ thresholdGBP: 99.99 }).thresholdGBP, 99.99);
  assert.throws(() => core.validateSettings({ thresholdGBP: 1000, apiBaseUrl: settings.apiBaseUrl }));
});

test("endpoint supports local base URLs and full paths, rejects remote or credentialed URLs", () => {
  for (const input of ["http://localhost:1234", "http://localhost:1234/v1/", "http://localhost:1234/v1/chat/completions"]) assert.equal(core.endpoint(input), "http://localhost:1234/v1/chat/completions");
  assert.equal(core.endpoint("http://127.0.0.1:8080/api/v1"), "http://127.0.0.1:8080/api/v1/chat/completions");
  for (const input of ["", "abc", "https://example.com", "http://localhost.evil.example", "ftp://localhost", "http://key@localhost", "http://localhost?token=x", "http://localhost/#x"]) assert.throws(() => core.endpoint(input));
});

test("threshold is inclusive and excludes low prices, other currencies, installments and old prices", () => {
  assert.equal(parse([item]).length, 1);
  assert.equal(parse([item], 1300).length, 0);
  assert.equal(parse([{ ...item, price: 1000, evidence: "GBP 1000" }])[0].price, 1000);
  for (const patch of [{ price: 999, evidence: "£999" }, { currency: "USD" }, { priceType: "installment" }, { priceType: "original" }]) assert.deepEqual(parse([{ ...item, ...patch }]), []);
});

test("requires verbatim evidence with matching GBP amount; ignores hallucinated findings", () => {
  for (const patch of [{ evidence: "£9,999" }, { price: 2000 }, { evidence: "Headphones" }, { evidence: "" }]) assert.deepEqual(parse([{ ...item, ...patch }]), []);
  assert.equal(parse([item, item]).length, 1);
  assert.equal(core.parseAnalysis("```json\n" + JSON.stringify({ products: [item] }) + "\n```", page, 1000).length, 1);
});

test("invalid AI output is an error rather than a clean-page result", () => {
  for (const content of [null, "not json", "{}", '{"products": null}', '{"products": [null]}', JSON.stringify({ products: [{ ...item, price: "1299" }] })]) assert.throws(() => core.parseAnalysis(content, page, 1000));
});

test("snapshots remove URL credentials, query parameters and fragment; enforce payload limits", () => {
  const snapshot = core.snapshot({ ...page, url: "https://user:secret@shop.example/item?token=private#secret", html: "x".repeat(30000), text: "y".repeat(20000) });
  assert.equal(snapshot.url, "https://shop.example/item");
  assert.equal(snapshot.html.length, 24000);
  assert.equal(snapshot.text.length, 16000);
});

test("uses the OpenAI-compatible wire format without mandatory vendor-specific options", async () => {
  let captured;
  const products = await analyzePage({ ...settings, apiKey: "test-key" }, page, { fetchImpl: async (url, init) => {
    captured = { url, ...init };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ products: [item] }) } }] }));
  } });
  assert.equal(products.length, 1);
  assert.equal(captured.url, "http://localhost:1234/v1/chat/completions");
  assert.equal(captured.headers.Authorization, "Bearer test-key");
  assert.equal(captured.credentials, "omit");
  assert.equal(captured.redirect, "error");
  assert.deepEqual(JSON.parse(captured.body), buildRequest(settings, page));
  assert.equal(JSON.parse(captured.body).response_format, undefined);
});

test("surfaces network, HTTP and malformed completion errors", async () => {
  await assert.rejects(analyzePage(settings, page, { fetchImpl: async () => { throw new Error("private detail"); } }), /Cannot connect/);
  await assert.rejects(analyzePage(settings, page, { fetchImpl: async () => { throw new DOMException("timeout", "TimeoutError"); } }), /timed out/);
  await assert.rejects(analyzePage(settings, page, { fetchImpl: async () => new Response("bad", { status: 401 }) }), /HTTP 401/);
  await assert.rejects(analyzePage(settings, page, { fetchImpl: async () => new Response("bad") }), /did not return JSON/);
  await assert.rejects(analyzePage(settings, page, { fetchImpl: async () => new Response("{}") }), /valid text/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(analyzePage(settings, page, { signal: controller.signal, fetchImpl: async () => { throw new Error(); } }), /cancelled/);
});

test("local fallback finds GBP formats without an API and honours the threshold", () => {
  const sample = { title: "Local store", html: "", text: "Headphones £1,299\nCamera GBP 1 500.50\nChair 1200 GBP\nLow price £999\nAt threshold £1000\nUSD $5000\nEUR 4000" };
  assert.deepEqual(core.localPriceCheck(sample, 1000).map(p => p.price), [1500.5, 1299, 1200, 1000]);
  assert.deepEqual(core.localPriceCheck(sample, 2000), []);
  assert.equal(core.localPriceCheck({ ...sample, text: "£\n1,299\n£1,299" }, 1000).length, 1);
});

test("local fallback skips obvious old prices, instalments, savings and ranges", () => {
  const sample = { title: "Local store", html: "<del>£2,000</del>", text: "Was £1,500\nOriginal price: GBP 1800\nMonthly £1200\n£1400 / month\nSave £1600\nFrom £1100\n£1700 – £1900\n£2,000\nCurrent price £1299" };
  assert.deepEqual(core.localPriceCheck(sample, 1000).map(p => p.price), [1299]);
});
