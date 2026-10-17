(() => {
  if (globalThis.__pauseGuardStarted) return;
  globalThis.__pauseGuardStarted = true;
  let settings = null;
  let timer = null;
  let timerAt = 0;
  let observer = null;
  let inFlight = false;
  let dirty = false;
  let generation = 0;
  let lastRequest = 0;
  let lastFingerprint = "";
  let lastUrl = location.href;
  let retryAfter = 0;
  let aiRetryAt = 0;
  const dismissed = new Set();
  const locallyShown = new Set();
  const core = globalThis.PauseCore;
  const send = message => chrome.runtime.sendMessage(message);

  function reset() {
    generation++;
    lastFingerprint = "";
    retryAfter = 0;
    aiRetryAt = 0;
    dismissed.clear();
    locallyShown.clear();
    globalThis.PauseOverlay.close();
  }

  function schedule(delay = 1000) {
    if (!settings?.enabled || document.hidden) return;
    dirty = true;
    // A fixed window instead of a trailing debounce prevents animated pages starving scans.
    const due = Date.now() + Math.max(delay, 5000 - (Date.now() - lastRequest), retryAfter - Date.now());
    if (timer && timerAt <= due) return;
    clearTimeout(timer);
    timerAt = due;
    timer = setTimeout(() => { timer = null; timerAt = 0; scan(); }, Math.max(0, due - Date.now()));
  }

  async function scan(force = false) {
    if (!settings?.enabled) return;
    if (inFlight) { dirty = true; return; }
    if (!force && document.hidden) return;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      reset();
      await send({ type: "RESET_PAGE" }).catch(() => {});
    }
    dirty = false;
    const page = globalThis.PauseExtractor.extractPage();
    const fingerprint = JSON.stringify(page);
    if (!force && fingerprint === lastFingerprint && (!aiRetryAt || Date.now() < aiRetryAt)) {
      if (aiRetryAt) schedule(aiRetryAt - Date.now());
      return;
    }
    const currentGeneration = generation;
    const currentUrl = location.href;
    const threshold = settings.thresholdGBP;
    inFlight = true;
    lastRequest = Date.now();
    try {
      const response = await send({ type: "ANALYZE", page });
      if (generation !== currentGeneration || location.href !== currentUrl || !settings.enabled) return;
      if (!response?.ok) { retryAfter = Date.now() + 30000; dirty = true; return; }
      if (response.state === "stale") { dirty = true; return; }
      if (response.state !== "complete") return;
      // Keep valid matches even on pages with live clocks, but discard removed prices.
      const currentSource = dirty ? globalThis.PauseExtractor.extractPage() : page;
      const evidenceText = `${currentSource.text} ${currentSource.html}`.replace(/\s+/g, " ").trim();
      lastFingerprint = fingerprint;
      retryAfter = 0;
      aiRetryAt = response.retryInMs ? Date.now() + response.retryInMs : 0;
      const products = response.products.filter(p => evidenceText.includes(p.evidence) && !dismissed.has(`${p.name}\0${p.price}`) && !locallyShown.has(p.price));
      if (products.length) {
        products.forEach(p => dismissed.add(`${p.name}\0${p.price}`));
        if (response.source === "local") products.forEach(p => locallyShown.add(p.price));
        globalThis.PauseOverlay.show(products, threshold, { source: response.source });
      }
    } catch {
      // Usually an extension reload invalidated this script; refreshing the tab reconnects it.
      stop();
    } finally {
      inFlight = false;
      if (dirty) schedule();
      else if (aiRetryAt) schedule(Math.max(1000, aiRetryAt - Date.now()));
    }
  }

  function start() {
    if (!settings?.enabled || !document.body) return;
    if (!observer) {
      observer = new MutationObserver(records => {
        const relevant = records.some(record => {
          if (record.target.closest?.("[data-pause-guard]")) return false;
          return record.type !== "childList" || [...record.addedNodes, ...record.removedNodes].some(n => !(n.nodeType === 1 && n.matches("[data-pause-guard]")));
        });
        if (relevant) schedule();
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["content", "class", "style", "hidden", "aria-hidden"] });
    }
    schedule(200);
  }

  function stop() {
    observer?.disconnect(); observer = null;
    clearTimeout(timer); timer = null;
    dirty = false;
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === "SETTINGS_CHANGED") {
      stop(); reset(); settings = message.settings; start(); respond({ ok: true });
    } else if (message.type === "SCAN_NOW") {
      lastFingerprint = ""; retryAfter = 0; aiRetryAt = 0; dismissed.clear(); locallyShown.clear();
      scan(true); respond({ ok: true });
    } else if (message.type === "PREVIEW") {
      globalThis.PauseOverlay.show([{ name: "Studio wireless headphones · sample", price: Math.round((settings?.thresholdGBP || 1000) * 1.299 * 100) / 100 }], settings?.thresholdGBP || 1000, { preview: true });
      respond({ ok: true });
    }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(200); });
  // Covers pushState/replaceState URL changes without injecting code into the page's world.
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href; reset();
      send({ type: "RESET_PAGE" }).catch(() => {});
      schedule(200);
    }
  }, 1000);
  send({ type: "GET_SETTINGS" }).then(response => {
    if (response?.ok) { settings = response.settings; start(); }
  }).catch(() => {});
})();
