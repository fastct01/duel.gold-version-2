/* PlayVault platform — UI helpers: DOM shortcuts, icons, meters, toasts, in-page modals. */
(function () {
  "use strict";
  const DG = window.DG, U = DG.util, P = window.DGP;
  const esc = (s) => U.esc(s == null ? "" : s);
  P.esc = esc;
  P.$ = (s, r) => (r || document).querySelector(s);
  P.$$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  P.fmt = (n) => U.fmt(n);
  P.signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "±") + U.fmt(Math.abs(n));

  /* ---------------- icons (inline SVG, stroke = currentColor) ---------------- */
  const I = {
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    games: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
    watch: '<rect x="2.5" y="5" width="19" height="13" rx="2"/><path d="M10 9v5l4-2.5z" fill="currentColor"/><path d="M8 21h8"/>',
    trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3M12 14v4M8 21h8M9 18h6"/>',
    social: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.4 3-5.5 6-5.5s5.4 2.1 6 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14.6c2.4.2 4 1.9 4.5 4.6"/>',
    profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.2 4-7 8-7s7.2 2.8 8 7"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3"/>',
    lock: '<rect x="5" y="11" width="14" height="9.5" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    star: '<path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  };
  P.icon = (name, cls) => '<svg class="ico ' + (cls || "") + '" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (I[name] || "") + "</svg>";

  /* ---------------- meters ---------------- */
  P.meter = function (label, n, cls) {
    let segs = "";
    for (let i = 0; i < 10; i++) segs += '<i class="' + (i < n ? "on" : "") + '"></i>';
    return '<div class="meter ' + cls + '" role="img" aria-label="' + esc(label) + " " + n + ' out of 10"><span>' + esc(label) + '</span><span class="segs">' + segs + '</span><b class="dg-mono">' + n + "</b></div>";
  };

  /* ---------------- toasts ---------------- */
  P.toast = function (text, kind, ms) {
    const box = P.$("#toasts");
    if (!box) return;
    const ov = document.getElementById("ov");
    if (ov && !ov.hidden) return; // the match overlay shows its own inline notes; no toasts over play or results
    const t = document.createElement("div");
    t.className = "toast " + (kind || "");
    t.setAttribute("role", "status");
    t.textContent = text;
    const x = document.createElement("button");
    x.className = "toast-x"; x.setAttribute("aria-label", "Dismiss"); x.innerHTML = P.icon("close");
    x.onclick = () => t.remove();
    t.appendChild(x);
    box.appendChild(t);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => t.remove(), ms || 4200);
  };

  /* ---------------- modals ----------------
     P.modal({title, body (HTML), actions:[{label, id, kind:'primary'|'danger', onClick(close) → false keeps open}],
              dismissable, wide, onClose, testId}) → {el, close} */
  const stack = [];
  P.modal = function (o) {
    const root = P.$("#modalRoot");
    const wrap = document.createElement("div");
    wrap.className = "modal-back";
    const tid = o.testId ? ' data-test="' + esc(o.testId) + '"' : "";
    wrap.innerHTML =
      '<div class="modal' + (o.wide ? " wide" : "") + '" role="dialog" aria-modal="true" aria-labelledby="mt' + stack.length + '"' + tid + ">" +
      '<div class="modal-head"><h2 class="dg-h" id="mt' + stack.length + '">' + esc(o.title || "") + "</h2>" +
      (o.dismissable === false ? "" : '<button class="icon-btn modal-x" aria-label="Close">' + P.icon("close") + "</button>") +
      '</div><div class="modal-body"></div><div class="modal-actions"></div></div>';
    const body = wrap.querySelector(".modal-body");
    if (typeof o.body === "string") body.innerHTML = o.body; else if (o.body) body.appendChild(o.body);
    const acts = wrap.querySelector(".modal-actions");
    let closed = false;
    const prevFocus = document.activeElement;
    const close = () => {
      if (closed) return; closed = true;
      wrap.remove();
      const i = stack.indexOf(api); if (i >= 0) stack.splice(i, 1);
      if (o.onClose) try { o.onClose(); } catch (e) { console.error(e); }
      let target = typeof o.returnFocus === "function" ? o.returnFocus() : o.returnFocus;
    if (!target) target = prevFocus;
    const sc = P.focusScope();
    if (target && target.focus && document.contains(target) && P.focusable(target) && (!sc || sc.contains(target))) try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    else P.focusHome();
    };
    (o.actions || []).forEach((a) => {
      const b = document.createElement("button");
      b.className = "dg-btn " + (a.kind || "");
      if (a.id) b.id = a.id;
      b.textContent = a.label;
      b.onclick = () => { const r = a.onClick ? a.onClick(close) : undefined; if (r !== false) close(); };
      acts.appendChild(b);
    });
    if (!acts.children.length) acts.remove();
    const x = wrap.querySelector(".modal-x");
    if (x) x.onclick = close;
    if (o.dismissable !== false) wrap.addEventListener("pointerdown", (e) => { if (e.target === wrap) close(); });
    root.appendChild(wrap);
    const api = { el: wrap, body, close, dismissable: o.dismissable !== false, tag: o.tag || null };
    stack.push(api);
    const f = wrap.querySelector("[autofocus]") || wrap.querySelector(".modal-actions .primary") || wrap.querySelector("button, input, select");
    if (f) try { f.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    return api;
  };
  P.topModal = () => stack[stack.length - 1] || null;
  P.closeModals = (tag) => { stack.slice().forEach((m) => { if (!tag || m.tag === tag) m.close(); }); };

  /* ---------------- focus management ---------------- */
  const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  P.focusable = (el) => !!el && !el.closest("[hidden]") && el.getClientRects().length > 0 && !el.disabled;
  function tabbables(root) { return Array.from(root.querySelectorAll(FOCUSABLE)).filter(P.focusable); }
  /* the element that currently owns keyboard focus: top modal, else the match overlay, else the page */
  P.focusScope = function () {
    const m = P.topModal();
    if (m) return m.el.querySelector(".modal");
    const ov = document.getElementById("ov");
    if (ov && !ov.hidden) return ov;
    return null;
  };
  /* move focus somewhere sensible inside the current scope */
  P.focusHome = function (el) {
    const scope = P.focusScope();
    let t = el && P.focusable(el) ? el : null;
    if (!t && scope && scope.id === "ov") {
      const gr = document.getElementById("gameRoot");
      t = gr || null;
      if (!t) t = tabbables(scope).find((x) => x.id !== "ovForfeit") || null;
    } else if (!t && scope) t = tabbables(scope)[0] || null;
    if (t) { if (!t.matches(FOCUSABLE) && !t.hasAttribute("tabindex")) t.setAttribute("tabindex", "-1"); try { t.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  };
  /* capture phase: Escape closes the top modal; while any modal is open no key reaches the game;
     Tab is trapped inside the top modal or the match overlay */
  window.addEventListener("keydown", (e) => {
    const m = P.topModal();
    if (m) {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); if (m.dismissable) m.close(); return; }
      if (e.key !== "Tab" && !(e.target && m.el.contains(e.target))) { e.stopImmediatePropagation(); if (e.key === " " || e.key.startsWith("Arrow")) e.preventDefault(); return; }
      if (e.key !== "Tab") { e.stopImmediatePropagation(); return; } // keys inside the modal are for the modal only
    }
    if (e.key !== "Tab") return;
    const scope = P.focusScope();
    if (!scope) return;
    if (m) e.stopImmediatePropagation(); // Tab inside a dialog is not a game key either
    const list = tabbables(scope);
    if (!list.length) { e.preventDefault(); return; }
    const i = list.indexOf(document.activeElement);
    if (!scope.contains(document.activeElement) || i === -1) { e.preventDefault(); (e.shiftKey ? list[list.length - 1] : list[0]).focus(); return; }
    if (!e.shiftKey && i === list.length - 1) { e.preventDefault(); list[0].focus(); }
    else if (e.shiftKey && i === 0) { e.preventDefault(); list[list.length - 1].focus(); }
  }, true);
  document.addEventListener("focusin", (e) => {
    const scope = P.focusScope();
    if (scope && !scope.contains(e.target)) { const l = tabbables(scope); if (l[0]) l[0].focus({ preventScroll: true }); }
  });
  P.confirm = function (o) {
    return P.modal({
      title: o.title, body: '<p class="modal-text">' + esc(o.text) + "</p>", testId: o.testId || "confirm",
      actions: [{ label: o.cancel || "Cancel", id: "confirmNo" }, { label: o.ok || "Confirm", id: "confirmYes", kind: o.danger ? "danger" : "primary", onClick: () => { o.onOk && o.onOk(); } }],
    });
  };
})();
