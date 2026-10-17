(() => {
  const { formatGBP } = globalThis.PauseCore;
  let active = null;
  function close() { active?.close(); }
  function show(products, threshold, { preview = false, source = "ai", onDismiss = () => {} } = {}) {
    close();
    const previousFocus = document.activeElement;
    const host = document.createElement("div");
    host.dataset.pauseGuard = "true";
    const shadow = host.attachShadow({ mode: "open" });
    // Static markup only. Every string from a page or AI is inserted with textContent.
    shadow.innerHTML = `
      <style>
        :host{all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;color-scheme:light!important}
        *{box-sizing:border-box}dialog{position:fixed;inset:0;width:min(620px,calc(100vw - 40px));max-height:calc(100dvh - 40px);margin:auto;border:1px solid #e6e4db;border-radius:24px;background:#faf9f5;color:#233c33;padding:0;box-shadow:0 32px 120px #12282045;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;overflow:auto}
        dialog::backdrop{background:#132b25a6;backdrop-filter:blur(7px)}
        header{display:flex;justify-content:space-between;align-items:center;padding:23px 30px;border-bottom:1px solid #e5e7de;font-size:12px;font-weight:650;letter-spacing:.08em}
        .brand{display:flex;align-items:center;gap:10px}.mark{display:grid;place-items:center;width:29px;height:29px;background:#294b3d;color:#f6f3e8;border-radius:9px;font-size:15px;letter-spacing:2px}
        .tag{color:#7c857e;font-size:11px;font-weight:500;letter-spacing:.04em}.body{padding:30px 36px 32px}.eyebrow{color:#9d5a38;font-size:11px;letter-spacing:.12em;font-weight:700}.heading{font-size:32px;line-height:1.35;font-weight:650;letter-spacing:-1px;margin:12px 0}.intro{color:#768078;margin:0 0 24px;font-size:14px}
        .item{border:1px solid #e2e5da;background:#f0f2e9;border-radius:14px;padding:19px 21px;margin-bottom:10px}.name{font-size:14px;font-weight:600;word-break:break-word}.price-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-top:8px}.price{font-size:35px;font-weight:600;letter-spacing:-1.2px;font-variant-numeric:tabular-nums}.over{font-size:12px;color:#a05b3b}.meta{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:#7b8378;margin-top:8px;padding-top:10px;border-top:1px solid #dce0d3}
        .extra{font-size:12px;color:#758074;margin:10px 0 0}.thought{display:flex;gap:12px;margin:23px 0;color:#526555;font-size:13px}.spark{font-size:20px;color:#9aa977}.thought p{margin:0}.thought strong{display:block;color:#345141;font-weight:600;margin-bottom:3px}
        .actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}button{font:inherit;cursor:pointer;border-radius:11px;padding:13px 10px;font-size:13px;font-weight:600;border:1px solid #dce0d5;background:transparent;color:#526457}button.primary{background:#294b3d;color:white;border-color:#294b3d}button:hover{filter:brightness(.95)}button:focus-visible{outline:3px solid #a8b883;outline-offset:3px}.footer{font-size:11px;color:#92988d;text-align:center;margin:16px 0 0}.preview{color:#a05b3b}
        @media(max-width:480px){.body{padding:24px}.heading{font-size:27px}header{padding:19px 24px}.price{font-size:29px}.price-row{flex-wrap:wrap}.actions{grid-template-columns:1fr}}
        @media(prefers-reduced-motion:no-preference){dialog{animation:enter .2s ease-out}@keyframes enter{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}}
      </style>
      <dialog aria-labelledby="pause-title" aria-describedby="pause-description">
        <header><span class="brand"><span class="mark" aria-hidden="true">Ⅱ</span> PAUSE <span class="tag">Shopping Guard</span></span><span class="tag" id="source"></span></header>
        <div class="body"><div class="eyebrow">A MOMENT FOR YOURSELF</div><h1 id="pause-title" class="heading">A pause before the purchase.</h1>
          <p id="pause-description" class="intro">This price reaches your personal alert amount. Take a moment to decide if it is worth it to you.</p>
          <div class="item"><div class="name" id="name"></div><div class="price-row"><span class="price" id="price"></span><span class="over" id="over"></span></div><div class="meta"><span>Your alert amount</span><span id="threshold"></span></div></div>
          <p class="extra" id="extra" hidden></p>
          <div class="thought"><span class="spark" aria-hidden="true">✳</span><p><strong>Would you still want it tomorrow?</strong>You can love something without buying it right now. The choice is always yours.</p></div>
          <div class="actions"><button class="primary" id="pause" autofocus>Give me a moment</button><button id="continue">Continue browsing</button></div>
          <p class="footer">A reminder, never a purchase. This item will not interrupt you again on this page.</p>
        </div>
      </dialog>`;
    const $ = id => shadow.getElementById(id);
    const first = products[0];
    $("name").textContent = first.name;
    $("price").textContent = formatGBP(first.price);
    $("threshold").textContent = formatGBP(threshold);
    $("over").textContent = first.price > threshold ? `${formatGBP(first.price - threshold)} over your amount` : "Alert amount reached";
    $("source").textContent = preview ? "Preview · sample product" : source === "local" ? "Local price check" : "Detected by local AI";
    if (source === "local" && !preview) $("pause-description").textContent = "A price on this page reaches your alert amount. This is a simple local check — take a moment to confirm what it refers to.";
    if (preview) $("source").className = "tag preview";
    if (products.length > 1) {
      $("extra").hidden = false;
      $("extra").textContent = `${products.length - 1} more item(s) reach your amount: ${products.slice(1).map(p => `${p.name} ${formatGBP(p.price)}`).join(", ")}`;
    }
    const dialog = shadow.querySelector("dialog");
    let closed = false;
    function cleanup(reason = "dismiss") {
      if (closed) return;
      closed = true;
      if (dialog.open) dialog.close();
      host.remove();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      active = null;
      onDismiss(reason);
    }
    $("pause").addEventListener("click", () => cleanup("pause"));
    $("continue").addEventListener("click", () => cleanup("continue"));
    dialog.addEventListener("cancel", event => { event.preventDefault(); cleanup("dismiss"); });
    dialog.addEventListener("close", () => cleanup("dismiss"));
    document.documentElement.append(host);
    dialog.showModal();
    active = { close: () => cleanup("programmatic") };
  }
  globalThis.PauseOverlay = Object.freeze({ show, close });
})();
