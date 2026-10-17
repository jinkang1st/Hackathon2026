(() => {
  const core = globalThis.PauseCore;
  const excluded = "script,style,noscript,template,svg,canvas,iframe,input,textarea,select,option,[contenteditable]:not([contenteditable='false']),[hidden],[aria-hidden='true'],[data-pause-guard]";
  const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const compact = text => text.replace(/\s+/g, " ").trim();

  function extractPage() {
    const visibility = new WeakMap();
    function visible(element) {
      if (!element || element === document.documentElement) return true;
      if (visibility.has(element)) return visibility.get(element);
      const style = getComputedStyle(element);
      const result = !element.matches(excluded) && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && visible(element.parentElement);
      visibility.set(element, result);
      return result;
    }
    let visits = 0;
    const lines = [];
    const priceContexts = [];
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) return visible(node) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    // Bound traversal and payload; put price-adjacent HTML before general page text.
    while (walker.nextNode() && visits++ < 16000) {
      const node = walker.currentNode;
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const text = compact(node.textContent);
      if (!text) continue;
      const parent = node.parentElement;
      const tag = parent.closest("del,s") ? "del" : /^(h[1-6]|p|li|button|a|strong|small|span)$/.test(parent.localName) ? parent.localName : "p";
      lines.push({ text, html: `<${tag}>${escape(text)}</${tag}>` });
      if (/(£|\bGBP\b|\bprice\b)/i.test(text) && priceContexts.length < 40) {
        const container = parent.closest("article,li,[itemtype*='Product'],[class*='product-card']") || parent.parentElement || parent;
        if (!seen.has(container)) {
          seen.add(container);
          const parts = [];
          const contextWalker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode(child) {
              if (child.nodeType === Node.ELEMENT_NODE) return visible(child) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            }
          });
          let length = 0;
          while (contextWalker.nextNode() && length < 1000) {
            const child = contextWalker.currentNode;
            if (child.nodeType !== Node.TEXT_NODE) continue;
            const value = compact(child.textContent);
            if (value) { parts.push(value); length += value.length; }
          }
          const context = parts.join(" ").slice(0, 1000);
          if (context.includes(text) || context.includes("£")) priceContexts.push(context);
          else priceContexts.push(text.slice(0, 1000));
        }
      }
    }
    // Only allowlisted Product/Offer fields from JSON-LD, never raw script bodies.
    const offers = [];
    let structuredVisits = 0;
    function readStructured(value, productName = "") {
      if (!value || typeof value !== "object" || structuredVisits++ > 500) return;
      if (Array.isArray(value)) { value.slice(0, 80).forEach(v => readStructured(v, productName)); return; }
      const types = [].concat(value["@type"] || []);
      const name = types.includes("Product") ? String(value.name || "").slice(0, 160) : productName;
      if (name && value.price != null && typeof value.priceCurrency === "string" && /^[A-Z]{3}$/i.test(value.priceCurrency)) {
        const price = String(value.price);
        if (/^\d+(\.\d{1,2})?$/.test(price)) offers.push(`${name} — ${value.priceCurrency.toUpperCase()} ${price}`);
      }
      for (const key of ["@graph", "mainEntity", "itemListElement", "item", "offers"]) if (value[key]) readStructured(value[key], name);
    }
    for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 12)) {
      if (script.textContent.length > 100000) continue;
      try { readStructured(JSON.parse(script.textContent)); } catch { /* Ignore broken site metadata. */ }
    }
    const focused = [...new Set([...priceContexts, ...offers.slice(0, 30)])].join("\n");
    const title = document.title.slice(0, 240);
    return core.snapshot({
      url: location.href, title,
      html: `<title>${escape(title)}</title>\n${lines.map(line => line.html).join("\n")}`,
      text: `${focused}\n${lines.map(line => line.text).join("\n")}`
    });
  }
  globalThis.PauseExtractor = Object.freeze({ extractPage });
})();
