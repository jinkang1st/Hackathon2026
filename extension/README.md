# Pause · Shopping Guard

A Chrome Manifest V3 extension for the shopping reminder scenario. All controls, reminders and status messages are in English. There is no build step and no production JavaScript dependency.

## Load it in Chrome

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked**, then select this repository's **extension/** folder (the folder containing `manifest.json`).
3. Pin **Pause · Shopping Guard** to the toolbar.
4. Refresh any shopping tabs that were already open when the extension was loaded.

Protection starts enabled, with an inclusive **£1,000** alert threshold. Open the toolbar popup to turn protection on/off, change the amount, scan again or preview the reminder. Changing a setting applies to open tabs immediately.

You can use it with no API configured. The local price check recognises explicit GBP amounts such as `£1,299`, `£ 1 299.50`, `GBP 1299` and `1299 GBP`. It skips some obvious crossed-out prices, instalments and savings, but may still mistake a number for a product price. Local reminders are labelled **Local price check**.

## Optional local AI

Open **Settings** from the toolbar popup:

| Setting | Initial value | What to enter |
| --- | --- | --- |
| API URL | Blank | Local OpenAI-compatible base URL, e.g. `http://127.0.0.1:8000/v1` |
| Model name | Blank | The exact model ID accepted by your local service |
| API Key | Blank | Optional bearer token, if your local endpoint needs one |

Use **Test connection**, then **Save settings**. This extension does not start or configure a model server. The repository's backend can provide the compatible endpoint; see the root README for its setup. Keys remain in trusted extension storage and are not sent to content scripts.

Only `localhost` and `127.0.0.1` HTTP/HTTPS endpoints are accepted in this version. The extension sends requests to that endpoint; whether the server forwards them to a cloud model depends on your server configuration.

The adapter in `api.js` sends a non-streaming `POST /v1/chat/completions` with `model` and `messages`, and reads `choices[0].message.content`. Full completion URLs also work. The request does not require vendor-specific structured-output options. The model is prompted to return this JSON inside its response content:

```json
{
  "products": [
    {
      "name": "Studio One headphones",
      "price": 1299,
      "currency": "GBP",
      "priceType": "total",
      "evidence": "£1,299"
    }
  ]
}
```

`priceType` can be `total`, `installment`, `original` or `other`; only GBP `total` prices at or above the threshold trigger an AI reminder. Evidence must appear in the supplied page and contain the matching price and currency. No currency conversion is guessed. An empty `products` array means no product was identified; it does not trigger the fallback.

When configuration is blank, no API request is made. Network failures, a 25-second timeout, non-success HTTP responses and invalid model output fall back to local price detection. While the server is unavailable, new page content is still checked locally; the AI is retried after a 30-second backoff on visible tabs. Recovering the AI does not repeat a dismissed local reminder for the same price.

## Try the demo

From the repository root, with Node.js 20+:

```sh
npm run demo
```

Open [the local test store](http://127.0.0.1:4173). With the extension loaded, the £1,299 product triggers a reminder even with the API fields blank. Dismiss it, then use **Below threshold**, **At threshold**, **Above threshold**, and **Simulate navigation** to test updates. These are fictional products; nothing can be purchased.

## Behaviour and limits

- An initial scan runs shortly after page load. DOM changes are coalesced, with at least five seconds between automatic scans per tab. Identical content is skipped; hidden tabs pause scans. URL changes, including SPA navigation, reset the page's reminders.
- The content script creates a bounded snapshot of visible text and simplified HTML. Price context is prioritised, and allowlisted Product/Offer metadata is extracted from JSON-LD. Inputs, textareas, editable areas, scripts, hidden content, URL query strings and fragments are excluded. This is not comprehensive redaction of arbitrary personal information displayed as normal page text.
- Each request contains at most 24,000 HTML characters and 16,000 text characters; DOM traversal is also bounded. Image-only prices, iframe content, shadow roots, browser-internal pages and content outside those limits are not covered. On very long pages or with ambiguous prices, both AI and the local heuristic can miss items or produce false positives.
- The reminder uses an isolated Shadow DOM and a modal dialog with keyboard focus handling, Escape dismissal, and safe text insertion. Turning protection off closes it and discards pending AI responses.
- Reminders are dismissed for the current page visit. Refreshing, changing settings or choosing **Scan this page** resets dismissal. **Give me a moment** and **Continue browsing** both dismiss the reminder; neither triggers a purchase or enforces a waiting period.
- This is a voluntary browsing reminder, not guaranteed payment interception. It does not store purchase history or permanently store page snapshots. Current tab status is held temporarily in browser session storage.

## Verify changes

```sh
npm test
npm ci
npx playwright install chromium
npm run test:browser
```

Unit tests cover price validation, local heuristics, payload limits, API formatting and errors. Browser tests load the real extension into an isolated Chromium profile and exercise settings, API-free operation, the content-script/service-worker flow, DOM price updates, dismissal, disable, sanitisation, SPA navigation, fallback and recovery. They use a deterministic local API test double, not a live model, and save screenshots in ignored `test-results/`.

The `demo/` folder is only the sample storefront. The mock API exists only inside `tests/browser.mjs`; it is never shipped in the extension.

## Safari later

This prototype targets Chrome first. Safari supports Web Extensions, but requires a separate packaging and compatibility pass. No Safari package or Safari test is included yet. See [Apple's Safari Web Extensions documentation](https://developer.apple.com/documentation/safariservices/safari-web-extensions).

Implementation references: [Chrome cross-origin extension requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) and [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).
