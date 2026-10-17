// Shared by the service worker, extension pages and isolated content scripts.
(() => {
  const defaults = Object.freeze({ enabled: true, thresholdGBP: 1000, apiBaseUrl: "", apiModel: "", apiKey: "" });
  const MAX_HTML = 24000;
  const MAX_TEXT = 16000;

  function settings(value = {}) {
    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
      thresholdGBP: Number.isFinite(value.thresholdGBP) && value.thresholdGBP > 0 ? value.thresholdGBP : 1000,
      apiBaseUrl: typeof value.apiBaseUrl === "string" ? value.apiBaseUrl.trim() : "",
      apiModel: typeof value.apiModel === "string" ? value.apiModel.trim() : "",
      apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : ""
    };
  }

  function endpoint(base) {
    if (!base?.trim()) throw new Error("Add your local API URL first.");
    let url;
    try { url = new URL(base.trim()); } catch { throw new Error("Enter a full local API URL, such as http://localhost:1234/v1."); }
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
      throw new Error("Use localhost or 127.0.0.1 without credentials, query parameters or fragments.");
    }
    let path = url.pathname.replace(/\/+$/, "");
    if (!path) path = "/v1";
    if (!path.endsWith("/chat/completions")) path += "/chat/completions";
    url.pathname = path;
    return url.href;
  }

  function validateSettings(input) {
    const result = settings(input);
    if (!Number.isFinite(Number(input.thresholdGBP)) || Number(input.thresholdGBP) <= 0 || Number(input.thresholdGBP) > 1000000000) {
      throw new Error("Enter an alert amount above zero and no greater than £1 billion.");
    }
    result.thresholdGBP = Math.round(Number(input.thresholdGBP) * 100) / 100;
    if (result.thresholdGBP <= 0) throw new Error("The minimum alert amount is £0.01.");
    if (result.apiBaseUrl) endpoint(result.apiBaseUrl);
    if (!!result.apiBaseUrl !== !!result.apiModel) throw new Error("Fill in both the API URL and model name, or leave both blank.");
    return result;
  }

  function publicSettings(input) {
    const s = settings(input);
    return { enabled: s.enabled, thresholdGBP: s.thresholdGBP, configured: !!(s.apiBaseUrl && s.apiModel) };
  }

  function cleanUrl(input) {
    const url = new URL(input);
    return `${url.origin}${url.pathname}`;
  }

  function snapshot(input) {
    if (!input || typeof input.html !== "string" || typeof input.text !== "string") throw new Error("Invalid page content.");
    return {
      url: cleanUrl(input.url),
      title: String(input.title || "").slice(0, 240),
      html: input.html.slice(0, MAX_HTML),
      text: input.text.slice(0, MAX_TEXT)
    };
  }

  const normalizeText = value => value.replace(/\s+/g, " ").trim();
  function parseAnalysis(content, page, threshold) {
    if (typeof content !== "string" || content.length > 100000) throw new Error("The AI did not return a valid text response.");
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let data;
    try { data = JSON.parse(cleaned); } catch { throw new Error("The AI returned invalid JSON. Check that your model can follow the JSON format."); }
    if (!data || !Array.isArray(data.products) || data.products.length > 50) throw new Error("The AI response is missing a valid products array.");
    const source = normalizeText(`${page.text} ${page.html}`);
    const products = [];
    for (const p of data.products) {
      if (!p || typeof p.name !== "string" || typeof p.price !== "number" || !Number.isFinite(p.price) || p.price <= 0 || typeof p.currency !== "string" || typeof p.evidence !== "string" || !["total", "installment", "original", "other"].includes(p.priceType)) {
        throw new Error("The AI product fields do not match the expected response format.");
      }
      // Never use an AI-provided 'expensive' flag or exchange-rate guess.
      if (p.currency.toUpperCase() !== "GBP" || p.priceType !== "total" || p.price < threshold) continue;
      const evidence = normalizeText(p.evidence).slice(0, 800);
      if (!evidence || !source.includes(evidence)) continue;
      const numbers = evidence.match(/\d{1,3}(?:[,\s]\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?/g) || [];
      if (!/(£|\bGBP\b)/i.test(evidence) || !numbers.some(n => Math.abs(Number(n.replace(/[,\s]/g, "")) - p.price) < 0.005)) continue;
      const item = { name: p.name.trim().slice(0, 160) || "Product on this page", price: p.price, currency: "GBP", evidence };
      if (!products.some(other => other.name === item.name && other.price === item.price)) products.push(item);
    }
    return products.sort((a, b) => b.price - a.price).slice(0, 8);
  }

  const formatGBP = value => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);

  function localPriceCheck(page, threshold) {
    const amount = "(?:\\d{1,3}(?:[, \\u00a0]\\d{3})+|\\d+)(?:\\.\\d{1,2})?";
    const pricePattern = () => new RegExp(`(?:£|\\bGBP\\s*)\\s*(${amount})(?![\\d.,])|(${amount})\\s*\\bGBP\\b`, "gi");
    const crossedOut = new Set();
    for (const old of page.html.matchAll(/<(?:del|s)>[\s\S]*?<\/(?:del|s)>/gi)) {
      for (const match of old[0].replace(/<[^>]*>/g, " ").matchAll(pricePattern())) crossedOut.add(Number((match[1] || match[2]).replace(/[,\s]/g, "")));
    }
    const text = page.text;
    const products = [];
    for (const match of text.matchAll(pricePattern())) {
      const price = Number((match[1] || match[2]).replace(/[,\s]/g, ""));
      if (!Number.isFinite(price) || price < threshold || crossedOut.has(price) || products.some(p => p.price === price)) continue;
      const before = text.slice(Math.max(0, match.index - 70), match.index);
      const after = text.slice(match.index + match[0].length, match.index + match[0].length + 50);
      // Modest heuristics only: skip obvious monthly payments, old prices and ranges.
      if (/(?:\bwas|\boriginal(?: price)?|\brrp|\bmsrp|\bsave|\bsavings?|\bdeposit|\bfrom|\bup to|\bunder|\bbalance|\bsalary|\bmonthly|\bper month|\bshipping over|\bdelivery over)\s*[:=]?\s*$/i.test(before)) continue;
      if (/^\s*(?:\/(?:\s*)(?:mo(?:nth)?|week|wk|year|yr)\b|per\s+(?:month|week|year)|a\s+month|monthly|[-–]\s*(?:£|GBP))/i.test(after)) continue;
      if (/(?:£|GBP)\s*[\d,.]+\s*[-–]\s*$/i.test(before)) continue;
      products.push({ name: page.title || "Possible price on this page", price, currency: "GBP", evidence: normalizeText(match[0]) });
    }
    return products.sort((a, b) => b.price - a.price).slice(0, 8);
  }
  globalThis.PauseCore = Object.freeze({ defaults, MAX_HTML, MAX_TEXT, settings, endpoint, validateSettings, publicSettings, cleanUrl, snapshot, parseAnalysis, localPriceCheck, formatGBP });
})();
