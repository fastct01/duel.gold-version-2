#!/usr/bin/env node
/* UI layout audit for the Duel.gold web client (/play/).

     node scripts/ui-audit.js                         every screen at 360, 390, 768, 1024, 1280, 1440
     node scripts/ui-audit.js --only=lobby,waiting    just these screens (the flows needed to reach them still run)
     node scripts/ui-audit.js --widths=360,1280       just these widths
     node scripts/ui-audit.js --offline-fonts         block Google Fonts (fallback font metrics; faster, no network)
     node scripts/ui-audit.js --list                  print the screen names and exit

   Starts the same dev stack as test/browser.test.js (local chain + server on ephemeral ports, in-memory DB), drives real
   Chromium through every reachable screen with burner-wallet players, and for each screen and width:
     - saves a full-page screenshot to test/shots/audit/<screen>-<width>.png
     - page overflow     document wider than the viewport
     - offscreen         elements whose visible box sticks out of the viewport horizontally (outermost offender only)
     - overlap           two visible content leaves (text glyph boxes, buttons, inputs, icons, images, pills) whose boxes
                         intersect by more than 2px on both axes, neither containing the other, same layer
     - covered           an interactive element whose centre is hit by some other element (elementFromPoint), checked at
                         the top and the bottom of the page, plus fixed pointer-events:none overlays (toasts) covering it
     - clipped           text cut off by an overflow:hidden/clip ancestor (ellipsis / line-clamp listed as "truncated")
     - char-wrap         text squeezed into a box so narrow it wraps every few characters
     - tap               interactive targets under 32x32 at widths <= 390 (warnings)
   Writes test/shots/audit/report.json and prints a summary. Always exits 0: it is a report, not a test. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { startDevStack } from "./dev-stack.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "test", "shots", "audit");
const pwChrome = () => { try { return chromium.executablePath(); } catch { return null; } };
const CHROME = [process.env.CHROME_PATH, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/opt/pw-browsers/chromium/chrome-linux/chrome", pwChrome()].find((p) => p && fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCREENS = [
  "signin", "lobby", "lobby-how", "toast", "avatar-menu", "games", "games-rules", "practice-ready", "practice-play", "practice-done",
  "game-page", "tournaments", "settings", "waiting", "lobby-hosting", "invite-signedout", "invite", "found", "found-ready", "playing",
  "playing-forfeit", "result-win", "result-loss", "history", "wallet",
];

/* ------------------------------------------------------------------ args */
const argv = process.argv.slice(2);
const arg = (n) => { const a = argv.find((x) => x === `--${n}` || x.startsWith(`--${n}=`)); return a == null ? null : a.includes("=") ? a.slice(a.indexOf("=") + 1) : true; };
const MAIN = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href; // importable: export { pageAudit }
if (MAIN && arg("list")) { console.log(SCREENS.join("\n")); process.exit(0); }
const WIDTHS = String(arg("widths") || "360,390,768,1024,1280,1440").split(",").map(Number).filter((n) => n > 0);
const HEIGHT = Number(arg("height")) || 900;
const ONLY = arg("only") ? new Set(String(arg("only")).split(",").map((s) => s.trim()).filter(Boolean)) : null;
const OFFLINE_FONTS = !!arg("offline-fonts");
if (MAIN && ONLY) for (const n of ONLY) if (!SCREENS.includes(n)) console.warn(`  note: "${n}" is not a known screen (see --list); it only matches a nav page discovered at runtime`);
const want = (name) => !ONLY || ONLY.has(name);
const wantAny = (...names) => names.some(want);

/* ------------------------------------------------------------------ the in-page audit (runs in the browser; self-contained) */
export function pageAudit({ small = false, tol = 2 } = {}) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const de = document.scrollingElement || document.documentElement;
  const INF = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
  const isect = (a, b) => ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });
  const R = (r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
  const W = (r) => r.r - r.l, H = (r) => r.b - r.t;
  const empty = (r) => W(r) < 1 || H(r) < 1;
  const contains = (a, b, e = 1) => b.l >= a.l - e && b.r <= a.r + e && b.t >= a.t - e && b.b <= a.b + e;
  const round = (r) => ({ x: Math.round(r.l), y: Math.round(r.t + de.scrollTop), w: Math.round(W(r)), h: Math.round(H(r)) });
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "BR", "WBR", "HEAD", "TITLE", "OPTION"]);
  const ACTION = "button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [data-act], [data-go]";
  const scrollTo = (y) => window.scrollTo({ top: y, left: 0, behavior: "instant" });
  scrollTo(0);

  /* ---- short readable selectors */
  const shortSel = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return s + "#" + el.id;
    const cls = [...el.classList].filter((c) => c !== "ico").slice(0, 3);
    if (cls.length) s += "." + cls.join(".");
    for (const a of ["data-act", "data-go", "data-test", "data-game"]) if (el.hasAttribute(a)) { s += `[${a}=${el.getAttribute(a)}]`; break; }
    return s;
  };
  const sel = (el) => {
    let s = shortSel(el);
    if (!el.id) {
      let p = el.parentElement, direct = true;
      for (let n = 0; p && p !== document.body && n < 4; n++, p = p.parentElement, direct = false) {
        if (p.id || p.classList.length) { s = shortSel(p) + (direct ? " > " : " ") + s; break; }
      }
    }
    return s;
  };
  const snip = (el) => {
    let t = el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.value || el.placeholder : el.innerText;
    t = (t || el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    return t.length > 34 ? t.slice(0, 33) + "…" : t;
  };
  const label = (el) => { const t = snip(el); return t ? `${sel(el)} "${t}"` : sel(el); };

  /* ---- per-element computed info, memoised down the tree (parents first) */
  const memo = new Map();
  const ROOT = { vis: true, op: 1, fixed: null, deco: false, popup: null, clipKids: INF, scrollKids: INF, hscrollKids: null, off: false };
  const POPUP = "[role=menu],[role=dialog],[role=listbox],[popover],#acctMenu";
  /* a control laid over a horizontal scroller from outside it (carousel prev/next arrows over faded edges): by design */
  const carouselOverlay = (inner, over) => {
    const sc = inner.hscroll;
    if (!sc || sc.contains(over) || !sc.parentElement || !sc.parentElement.contains(over)) return false;
    for (let e = over; e && e !== sc.parentElement; e = e.parentElement) if (/absolute|fixed/.test(getComputedStyle(e).position)) return true;
    return false;
  };
  function info(el) {
    if (!el || el === document.documentElement || el === document.body) return ROOT;
    let v = memo.get(el);
    if (v) return v;
    const p = info(el.parentElement), s = getComputedStyle(el);
    const op = p.op * (parseFloat(s.opacity) || 0);
    const pe = el.parentElement;
    const inClosedDetails = pe && pe.tagName === "DETAILS" && !pe.open && el !== pe.querySelector(":scope > summary");
    const vis = p.vis && !inClosedDetails && s.display !== "none" && s.visibility !== "hidden" && s.visibility !== "collapse" && op > 0.05 && s.clip === "auto"
      && s.contentVisibility !== "hidden" && (!el.checkVisibility || el.checkVisibility({ contentVisibilityAuto: true }));
    const rect = R(el.getBoundingClientRect());
    let deco = p.deco;
    if (!deco && el.getAttribute("aria-hidden") === "true" && W(rect) * H(rect) > 6000) deco = true; // big decorative art (aria-hidden)
    const ox = s.overflowX, oy = s.overflowY, clipping = ox !== "visible" || oy !== "visible" || /paint|strict|content/.test(s.contain);
    let clipKids = p.clipKids, scrollKids = p.scrollKids;
    if (clipping) {
      const pad = { l: rect.l + el.clientLeft, t: rect.t + el.clientTop, r: rect.l + el.clientLeft + el.clientWidth, b: rect.t + el.clientTop + el.clientHeight };
      const box = { l: ox !== "visible" ? pad.l : -Infinity, r: ox !== "visible" ? pad.r : Infinity, t: oy !== "visible" ? pad.t : -Infinity, b: oy !== "visible" ? pad.b : Infinity };
      clipKids = isect(clipKids, box);
      if (/auto|scroll/.test(ox + oy)) scrollKids = isect(scrollKids, box);
    }
    const hscroll = /auto|scroll/.test(ox) ? el : p.hscrollKids;
    const popup = p.popup || (el.matches(POPUP) ? el : null);
    v = { s, vis, op, rect, deco, popup, fixed: s.position === "fixed" ? el : p.fixed, clipSelf: p.clipKids, scrollSelf: p.scrollKids, clipKids, scrollKids, hscroll: p.hscrollKids, hscrollKids: hscroll, off: p.off };
    memo.set(el, v);
    return v;
  }
  const depth = (el) => { let d = 0; for (let p = el; p; p = p.parentElement) d++; return d; };

  /* text glyph cores: the line-box rect of each text fragment, shrunk vertically to the middle ~70% of the font size so
     tight line-heights do not make consecutive lines "overlap" */
  function textCores(node, fs, clip) {
    const rg = document.createRange(); rg.selectNodeContents(node);
    const out = [];
    for (const r of rg.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      const cy = (r.top + r.bottom) / 2, hh = Math.min(r.height / 2, fs * 0.36);
      const c = isect({ l: r.left, r: r.right, t: cy - hh, b: cy + hh }, clip);
      if (!empty(c)) out.push(c);
    }
    return out;
  }
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3 && /\S/.test(n.data));

  /* ---- collect */
  const res = { overflowX: Math.max(0, de.scrollWidth - vw), docWidth: de.scrollWidth, offscreen: [], overlaps: [], covered: [], clipped: [], truncated: [], charWrap: [], tap: [] };
  const items = [], actions = [];
  const all = document.body.querySelectorAll("*");
  for (const el of all) {
    if (SKIP.has(el.tagName) || (el.ownerSVGElement && el.tagName !== "svg")) continue;
    const inf = info(el);
    if (!inf.vis) continue;
    const r = inf.rect;
    if (W(r) < 1.5 || H(r) < 1.5) continue;
    const vr = isect(r, inf.clipSelf);
    if (empty(vr)) continue;
    const s = inf.s;

    // offscreen (outermost offender only)
    const isOff = vr.r > vw + 1 || vr.l < -1;
    if (isOff && !inf.off) res.offscreen.push({ el: label(el), box: round(vr), past: Math.round(Math.max(vr.r - vw, -vr.l)) });
    if (isOff) inf.off = true;

    if (inf.deco) continue;
    const edge = !contains(inf.scrollSelf, r, 1); // partly scrolled out of a scroller (carousel edge): transient, skip
    const tag = el.tagName;
    const isAction = el.matches(ACTION);
    if (isAction) actions.push({ el, inf, edge });
    const media = tag === "svg" || tag === "IMG" || tag === "CANVAS" || tag === "VIDEO";
    const formy = /^(BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(tag) || el.getAttribute("role") === "button";
    const hasBg = (s.backgroundColor && !/rgba\(.*,\s*0\)|transparent/.test(s.backgroundColor)) || s.backgroundImage !== "none" || parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderLeftWidth) > 0;
    const pill = !formy && !media && hasBg && el.querySelectorAll("*").length <= 4 && W(r) * H(r) < 30000 && !el.querySelector(ACTION);
    const linkBox = tag === "A" && (s.display !== "inline" || hasBg);
    const boxy = formy || media || pill || linkBox || (isAction && s.display !== "inline");
    const fs = parseFloat(s.fontSize) || 16;
    const texts = ownText(el);
    let text = [];
    for (const n of texts) text.push(...textCores(n, fs, inf.clipKids));
    if (!boxy && !text.length) continue;
    let box = null;
    if (boxy) {
      const rs = s.display === "inline" ? [...el.getClientRects()].map(R) : [r];
      box = rs.map((x) => isect(x, inf.clipSelf)).filter((x) => !empty(x));
      if (!box.length) continue;
    }
    items.push({ el, inf, edge, box, text, fixed: inf.fixed, d: depth(el) });

    // char-by-char wrapping: a text node spread over 3+ lines with only a few characters per line
    for (const n of texts) {
      const rg = document.createRange(); rg.selectNodeContents(n);
      const tops = new Set([...rg.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)));
      const chars = n.data.replace(/\s+/g, "").length, words = n.data.trim().split(/\s+/).length, per = chars / tops.size;
      // every few characters on a new line, or a short word broken across lines (long tokens like addresses may break)
      if ((tops.size >= 3 && per <= 4) || (tops.size > words && per <= 6)) res.charWrap.push({ el: label(el), lines: tops.size, chars, width: Math.round(W(r)) });
    }
  }

  /* ---- overlaps */
  const geom = (it) => (it.box || it.text);
  const ub = (rs) => rs.reduce((a, x) => ({ l: Math.min(a.l, x.l), t: Math.min(a.t, x.t), r: Math.max(a.r, x.r), b: Math.max(a.b, x.b) }), { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity });
  for (const it of items) { it.g = geom(it); it.u = ub(it.g); it.tu = it.text.length ? ub(it.text) : null; }
  function hit(A, B) {
    let best = null;
    for (const a of A) for (const b of B) {
      const ix = Math.min(a.r, b.r) - Math.max(a.l, b.l), iy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (ix <= tol || iy <= tol) continue;
      if (contains(a, b) || contains(b, a)) continue;
      if (!best || ix * iy > best.ix * best.iy) best = { ix, iy, at: isect(a, b) };
    }
    return best;
  }
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a.edge) continue;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (b.edge || a.fixed !== b.fixed || a.inf.popup !== b.inf.popup) continue;
      if (carouselOverlay(a.inf, b.el) || carouselOverlay(b.inf, a.el)) continue;
      let A, B;
      if (a.el.contains(b.el)) { if (!a.text.length) continue; A = a.text; B = b.g; if (!(a.tu.r > b.u.l && b.u.r > a.tu.l && a.tu.b > b.u.t && b.u.b > a.tu.t)) continue; }
      else { if (!(a.u.r > b.u.l && b.u.r > a.u.l && a.u.b > b.u.t && b.u.b > a.u.t)) continue; A = a.g; B = b.g; }
      const h = hit(A, B);
      if (h) pairs.push({ a, b, h });
    }
  }
  /* drop a pair when an ancestor pair already explains it (button box vs X, then button's label vs X) */
  pairs.sort((p, q) => (p.a.d + p.b.d) - (q.a.d + q.b.d));
  const kept = [];
  for (const p of pairs) {
    const dup = kept.some((k) => (k.a.el.contains(p.a.el) && k.b.el.contains(p.b.el)) || (k.a.el.contains(p.b.el) && k.b.el.contains(p.a.el)));
    if (!dup) kept.push(p);
  }
  for (const p of kept) res.overlaps.push({ a: label(p.a.el), b: label(p.b.el), by: `${Math.round(p.h.ix)}x${Math.round(p.h.iy)}`, at: round(p.h.at), layer: p.a.fixed ? sel(p.a.fixed) : "page" });

  /* ---- covered: what elementFromPoint says is on top of each interactive element (top and bottom of the page) */
  const overlays = [];
  for (const el of document.querySelectorAll("body *")) {
    const inf = memo.get(el);
    if (!inf || !inf.vis || !inf.fixed || inf.s.pointerEvents !== "none") continue;
    const bg = inf.s.backgroundColor;
    if (bg && !/rgba\(.*,\s*0(\.0\d*)?\)|transparent/.test(bg) && W(inf.rect) > 4 && H(inf.rect) > 4) overlays.push(el);
  }
  const seen = new Set();
  const maxY = Math.max(0, de.scrollHeight - vh);
  for (const [phase, y] of [["top", 0], ["bottom", maxY]]) {
    if (phase === "bottom" && maxY < 2) break;
    scrollTo(y);
    const ovr = overlays.map((el) => ({ el, r: R(el.getBoundingClientRect()) }));
    /* page content under a fixed bar only counts where scrolling cannot reveal it: the top half of the viewport at
       scroll 0, the bottom half at the end of the page. In-flow covering of controls counts anywhere (at scroll 0). */
    const stuckAt = (cy, layered) => (phase === "top" ? (!layered || cy < vh / 2) : (layered && cy >= vh / 2));
    const shiftBox = (b, inf) => { const d = inf.fixed ? 0 : y; return { l: b.l, r: b.r, t: b.t - d, b: b.b - d }; }; // measured at scroll 0
    for (const { el, inf, edge } of actions) {
      if (edge || seen.has(el)) continue;
      const box = isect(R(el.getBoundingClientRect()), shiftBox(inf.clipSelf, inf));
      if (empty(box) || W(box) < 2 || H(box) < 2) continue;
      const cx = (box.l + box.r) / 2, cy = (box.t + box.b) / 2;
      if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;
      const top = document.elementFromPoint(cx, cy);
      if (top && !(top === el || el.contains(top) || top.contains(el))) {
        const ti = memo.get(top) || info(top);
        const layered = !!ti.fixed && ti.fixed !== inf.fixed;
        if (stuckAt(cy, layered) && !(ti.popup && ti.popup !== inf.popup) && !carouselOverlay(inf, top)) {
          seen.add(el);
          res.covered.push({ el: label(el), by: label(top), where: phase, at: round(box) });
          continue;
        }
      }
      if (!inf.fixed && stuckAt(cy, true)) for (const o of ovr) {
        if (o.el.contains(el)) continue;
        const x = isect(box, o.r);
        if (!empty(x) && W(x) * H(x) > 0.3 * W(box) * H(box)) { seen.add(el); res.covered.push({ el: label(el), by: label(o.el) + " (overlay)", where: phase, at: round(box) }); break; }
      }
    }
    /* text hidden under a fixed layer (top bar, bottom nav) where no scrolling can reveal it */
    for (const it of items) {
      if (it.edge || it.fixed || !it.text.length || seen.has(it.el)) continue;
      for (const c of it.text.slice(0, 4)) {
        const b = shiftBox(c, it.inf);
        const cx = (b.l + b.r) / 2, cy = (b.t + b.b) / 2;
        if (cx < 0 || cy < 0 || cx >= vw || cy >= vh || !stuckAt(cy, true)) continue;
        const top = document.elementFromPoint(cx, cy);
        if (!top || top === it.el || it.el.contains(top) || top.contains(it.el)) continue;
        const ti = memo.get(top) || info(top);
        if (!ti.fixed || ti.popup) continue;
        seen.add(it.el);
        res.covered.push({ el: label(it.el), by: label(top), where: phase, at: round(b), text: true });
        break;
      }
    }
  }
  scrollTo(0);

  /* ---- clipped text: text whose glyphs fall outside its nearest clipping ancestor (overflow hidden/clip) */
  const cutSeen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!/\S/.test(n.data)) continue;
    const pe = n.parentElement;
    if (!pe || SKIP.has(pe.tagName)) continue;
    const pinf = memo.get(pe);
    if (!pinf || !pinf.vis || pinf.deco) continue;
    // nearest clipping ancestor (pe itself included)
    let c = pe;
    for (; c && c !== document.body; c = c.parentElement) {
      const ci = memo.get(c) || info(c);
      if (ci.s.overflowX !== "visible" || ci.s.overflowY !== "visible") break;
    }
    if (!c || c === document.body) continue;
    const ci = info(c), s = ci.s;
    const hx = /hidden|clip/.test(s.overflowX), hy = /hidden|clip/.test(s.overflowY);
    if (!hx && !hy) continue; // a scroll container: scrolling, not clipping
    if (W(ci.rect) < 2 || H(ci.rect) < 2) continue; // sr-only style boxes
    if (!contains(ci.clipSelf, ci.rect, 1)) continue; // the clipper itself is partly scrolled away
    const pad = { l: ci.rect.l + c.clientLeft, t: ci.rect.t + c.clientTop, r: ci.rect.l + c.clientLeft + c.clientWidth, b: ci.rect.t + c.clientTop + c.clientHeight };
    const fs = parseFloat(pinf.s.fontSize) || 16;
    let cut = 0, axis = "";
    for (const r of textCores(n, fs, INF)) {
      if (hx) { const d = Math.max(pad.l - r.l, r.r - pad.r); if (d > 1 && d > cut) { cut = d; axis = "x"; } }
      if (hy) { const d = Math.max(pad.t - r.t, r.b - pad.b); if (d > 1 && d > cut) { cut = d; axis = "y"; } }
    }
    if (!cut) continue;
    const key = c;
    if (cutSeen.has(key)) continue;
    cutSeen.add(key);
    const intentional = s.textOverflow === "ellipsis" || pinf.s.textOverflow === "ellipsis" || (s.webkitLineClamp && s.webkitLineClamp !== "none");
    const txt = n.data.replace(/\s+/g, " ").trim();
    (intentional ? res.truncated : res.clipped).push({ el: label(c), text: txt.length > 40 ? txt.slice(0, 39) + "…" : txt, axis, by: Math.round(cut) });
  }

  /* ---- tap targets */
  if (small) {
    for (const { el, inf, edge } of actions) {
      if (edge) continue;
      const r = inf.rect, s = inf.s;
      if (s.display === "inline" && el.parentElement && ownText(el.parentElement).length) continue; // inline link inside a sentence
      if (el.disabled) continue;
      if (W(r) < 32 || H(r) < 32) res.tap.push({ el: label(el), size: `${Math.round(W(r))}x${Math.round(H(r))}` });
    }
  }
  return res;
}

/* ------------------------------------------------------------------ browser helpers */
const NO_MOTION = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}`;

let stack, browser;
const pages = [];
async function open(width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: HEIGHT }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|ERR_FAILED|favicon/.test(m.text() + (m.location().url || ""))) page.errors.push("console: " + m.text()); });
  if (OFFLINE_FONTS) await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto(`${stack.url}/play/?test=1`);
  pages.push(page);
  return page;
}
const view = (page) => page.evaluate(() => (window.__duel ? window.__duel.S.view : null));
const until = async (fn, label, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* page navigating */ }
    if (Date.now() > end) throw new Error("timed out: " + label);
    await sleep(80);
  }
};
const text = (page, sel) => page.locator(sel).first().innerText();
const jsClick = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) throw new Error("no element " + s); el.click(); }, sel);
async function settle(page, ms = 120) {
  await page.evaluate(async (css) => {
    if (!document.getElementById("__auditNoMotion")) { const st = document.createElement("style"); st.id = "__auditNoMotion"; st.textContent = css; document.head.appendChild(st); }
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, NO_MOTION);
  await sleep(ms);
}

/* open a page of the signed-in app the way a player does (nav or top-bar link), falling back to the URL hash */
async function goTab(page, tab, waitSel) {
  await page.evaluate((t) => {
    const el = document.querySelector(`#nav [data-go="${t}"], #topRight [data-go="${t}"], [data-go="${t}"]`);
    if (el) el.click(); else location.hash = t;
  }, tab);
  await until(() => page.evaluate((t) => window.__duel.S.view === "lobby" && window.__duel.S.tab === t, tab), "the " + tab + " page", 8000);
  if (waitSel) await page.waitForSelector(waitSel, { timeout: 15000 });
  await settle(page, 200);
}
const note = (screen, reason) => { if (want(screen)) { skipped.push({ screen, reason }); console.log(`  - ${screen}: skipped (${reason})`); } };

async function signInAndFund(page) {
  await page.click("#signBurner");
  await page.waitForSelector("#faucetBtn");
  await page.click("#faucetBtn");
  await until(async () => parseFloat(await text(page, "#balAvail")) >= 1, "test ETH credited");
}
async function autoplay(page, ms, which = "__duel", done = () => view(page).then((v) => v === "result")) {
  await until(() => page.evaluate((w) => !!(window[w].ctx && window[w].ctx.test), which), "the game to start", 20000);
  await until(async () => {
    if (await done()) return true;
    await page.evaluate(([w, m]) => { const c = window[w].ctx; return c && c.test && c.test.fire(m); }, [which, ms]).catch(() => {});
    return false;
  }, "the game to finish", 40000);
}

/* ------------------------------------------------------------------ capture + bookkeeping */
const results = [], skipped = [];
const broken = {}; // chain → reason it stopped

async function capture(chain, name, page, { setup, perWidth, check, keepToasts = false } = {}) {
  if (!want(name)) return;
  if (broken[chain]) { skipped.push({ screen: name, reason: "prerequisite failed: " + broken[chain] }); console.log(`  - ${name}: skipped (prerequisite failed)`); return; }
  const t0 = Date.now();
  try {
    if (setup) await setup();
    const done = [];
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: HEIGHT });
      if (!keepToasts) await page.evaluate(() => { for (const t of document.querySelectorAll("#toasts > *")) t.remove(); });
      if (perWidth) await perWidth(w);
      await settle(page);
      if (check) { const why = await check(); if (why) throw new Error(why); }
      const r = await page.evaluate(pageAudit, { small: w <= 390, tol: 2 });
      const shot = path.join(OUT, `${name}-${w}.png`);
      await page.screenshot({ path: shot, fullPage: true, animations: "disabled", caret: "hide" });
      results.push({ screen: name, width: w, shot: path.relative(path.join(here, ".."), shot), ...r });
      done.push(w);
    }
    console.log(`  ✓ ${name} (${done.join(",")}) ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    skipped.push({ screen: name, reason: e.message.split("\n")[0] });
    console.log(`  - ${name}: skipped (${e.message.split("\n")[0]})`);
  } finally {
    await page.setViewportSize({ width: 1280, height: HEIGHT }).catch(() => {});
  }
}
/* a flow step other screens depend on: if it fails, the rest of the chain is skipped (not retried for every screen) */
async function flow(chain, label, fn) {
  if (broken[chain]) return false;
  try { await fn(); return true; }
  catch (e) { broken[chain] = `${label}: ${e.message.split("\n")[0]}`; console.log(`  ! ${label} failed: ${e.message.split("\n")[0]}`); return false; }
}

/* ------------------------------------------------------------------ the tour */
async function tour() {
  const MATCH_SCREENS = ["waiting", "lobby-hosting", "invite-signedout", "invite", "found", "found-ready", "playing", "playing-forfeit", "result-win", "result-loss", "history", "wallet"];
  const needAccount = !ONLY || [...ONLY].some((n) => n !== "signin" && !MATCH_SCREENS.includes(n)); // incl. nav pages found at runtime
  const needMatch = wantAny(...MATCH_SCREENS);
  const needSignedOut = wantAny("signin", "invite-signedout");

  const V = needSignedOut ? await open() : null;
  const A = needAccount || needMatch ? await open() : null;
  const B = needMatch ? await open() : null;
  const signing = [A, B].filter(Boolean).map((p) => signInAndFund(p));
  const signed = Promise.all(signing).then(() => true, (e) => { broken.account = broken.match = "sign in: " + e.message.split("\n")[0]; return false; });

  if (V) await capture("signedout", "signin", V, { setup: () => V.waitForSelector("#signBurner") });
  await signed;

  /* ---------------- signed-in pages (player A) */
  if (A && needAccount) {
    const C = "account";
    await flow(C, "lobby", () => A.waitForSelector("#createBtn"));
    await capture(C, "lobby", A);
    await capture(C, "lobby-how", A, {
      setup: () => jsClick(A, "#lbHowBtn"),
      perWidth: () => A.evaluate(() => { const b = document.querySelector("#lbHowBtn"); if (b && b.getAttribute("aria-expanded") !== "true") b.click(); }),
    });
    await A.evaluate(() => { const b = document.querySelector("#lbHowBtn"); if (b && b.getAttribute("aria-expanded") === "true") b.click(); }).catch(() => {});
    await capture(C, "toast", A, {
      keepToasts: true,
      perWidth: () => A.evaluate(() => {
        for (const t of document.querySelectorAll("#toasts > *")) t.remove();
        /* any action that answers with a toast and changes nothing else: copy address (ok or "could not copy"),
           or an empty invite code ("Invite codes are 8 characters.") */
        const el = document.querySelector("[data-act=top-copy], [data-act=copy], [data-act=lb-join-code]");
        if (!el) throw new Error("no toast trigger found");
        el.click();
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      }).then(() => until(() => A.evaluate(() => !!document.querySelector("#toasts .toast")), "toast", 3000)),
      check: () => A.evaluate(() => (document.querySelector("#toasts .toast") ? "" : "no toast showed up")),
    });
    await A.evaluate(() => { for (const t of document.querySelectorAll("#toasts .toast")) t.remove(); });
    await capture(C, "avatar-menu", A, {
      perWidth: () => A.evaluate(() => { const m = document.querySelector("#acctMenu"); if (m && m.hidden) document.querySelector("#acctBtn").click(); }),
      check: () => A.evaluate(() => (document.querySelector("#acctMenu:not([hidden])") ? "" : "menu did not open")),
    });
    await A.keyboard.press("Escape").catch(() => {});

    await flow(C, "games tab", () => goTab(A, "games", ".lb-gcard"));
    await capture(C, "games", A);
    const card = await A.evaluate(() => (document.querySelector('.lb-gcard[data-game="reaction"]') ? "reaction" : (document.querySelector(".lb-gcard") || { dataset: {} }).dataset.game)).catch(() => null);
    const cardSel = `.lb-gcard[data-game="${card}"]`;
    /* the library cards have had a "How to play" <details>; newer builds link each card to its own game page instead */
    const has = (sel) => A.evaluate((x) => !!document.querySelector(x), sel).catch(() => false);
    if (await has(`${cardSel} details`)) {
      await capture(C, "games-rules", A, {
        perWidth: () => A.evaluate((s) => { const d = document.querySelector(s + " details"); if (d) d.open = true; }, cardSel),
        check: () => A.evaluate((s) => (document.querySelector(s + " details[open]") ? "" : "rules did not open"), cardSel),
      });
    } else note("games-rules", "the game cards have no How to play <details>");
    if (await has(`${cardSel} [data-go="game"]`)) {
      await capture(C, "game-page", A, {
        setup: async () => { await jsClick(A, `${cardSel} [data-go="game"]`); await until(() => A.evaluate(() => window.__duel.S.tab === "game"), "game page"); },
      });
    } else note("game-page", "the game cards do not link to a game page");

    if (wantAny("practice-ready", "practice-play", "practice-done")) {
      const P = "practice";
      await flow(P, "open practice", async () => {
        /* wherever "Try out" / "Practice" lives in this build: the current page, the game page, or the lobby's How to play panel */
        const click = () => A.evaluate(() => { const el = document.querySelector('[data-act="try-game"]'); if (el) el.click(); return !!el; });
        if (!(await click()) && card) { await A.evaluate((id) => { location.hash = "game/" + id; }, card); await settle(A, 300); }
        if (!(await click())) { await goTab(A, "lobby", "#createBtn"); await A.evaluate(() => { const b = document.querySelector("#lbHowBtn"); if (b) b.click(); }); await settle(A); }
        if (!(await click())) throw new Error("no Try out / Practice button found");
        await A.waitForSelector("#prStart");
      });
      await capture(P, "practice-ready", A);
      await flow(P, "practice start", async () => { await jsClick(A, "#prStart"); await A.waitForSelector("#prStage > *"); });
      await capture(P, "practice-play", A, { check: () => A.evaluate(() => (document.querySelector("#prStage > *") ? "" : "practice game ended before the capture finished")) });
      await capture(P, "practice-done", A, {
        setup: async () => { await autoplay(A, 230, "__practice", () => A.locator("[data-test=practice-result]").count().then((n) => n > 0)); await A.waitForSelector("[data-test=practice-result]"); },
      });
      await A.evaluate(() => { const b = document.querySelector("#prBack"); if (b) b.click(); }).catch(() => {});
    }
    await capture(C, "tournaments", A, { setup: () => goTab(A, "tournaments") });
    await capture(C, "settings", A, { setup: () => goTab(A, "settings") });
    /* any other page the navigation or top bar links to that this script does not know yet */
    const extra = await A.evaluate((known) => [...new Set([...document.querySelectorAll("#nav [data-go], #topRight [data-go]")].map((e) => e.dataset.go))].filter((t) => !known.includes(t)), [...SCREENS, "game"]).catch(() => []);
    for (const t of extra) if (want(t)) await capture(C, t, A, { setup: () => goTab(A, t) });
  }

  /* ---------------- invite → match → result (players A and B, visitor V) */
  if (A && B && needMatch) {
    const C = "match";
    let link = null;
    await flow(C, "create lobby", async () => {
      await goTab(A, "lobby", "#createBtn");
      await A.click('[data-act=stake][data-v="1000000000000000"]');
      await A.click("#createBtn");
      await A.waitForSelector("#inviteLink", { timeout: 15000 });
      link = await A.inputValue("#inviteLink");
    });
    await capture(C, "waiting", A, { check: () => view(A).then((v) => (v === "waiting" ? "" : "not in the waiting room: " + v)) });
    await capture(C, "lobby-hosting", A, {
      setup: () => goTab(A, "lobby", "#createBtn"),
    });
    if (V && want("invite-signedout")) {
      if (broken[C]) await capture(C, "invite-signedout", V);
      else await capture(C, "invite-signedout", V, { setup: async () => { await V.goto(link + "&test=1"); await V.waitForSelector("#inviteBanner:not(.bad)", { timeout: 15000 }); } });
    }
    if (V) { await V.context().close().catch(() => {}); }
    await flow(C, "open invite", async () => { await B.goto(link + "&test=1"); await B.waitForSelector("#joinBtn", { timeout: 15000 }); });
    await capture(C, "invite", B);
    await flow(C, "join", async () => { await B.click("#joinBtn"); await Promise.all([A, B].map((p) => p.waitForSelector("#readyBtn", { timeout: 15000 }))); });
    await capture(C, "found", A, { check: () => view(A).then((v) => (v === "found" ? "" : "left the found screen: " + v)) });
    await flow(C, "ready (host)", () => A.click("#readyBtn"));
    await capture(C, "found-ready", A, { check: () => view(A).then((v) => (v === "found" ? "" : "left the found screen: " + v)) });
    await flow(C, "ready (guest) + start", async () => {
      await B.click("#readyBtn");
      await until(() => A.evaluate(() => window.__duel.S.view === "play" && !!window.__duel.ctx), "game started on A", 20000);
      await until(() => B.evaluate(() => !!window.__duel.ctx), "game started on B", 20000);
    });
    await capture(C, "playing", A, { check: () => view(A).then((v) => (v === "play" ? "" : "match ended during the capture: " + v)) });
    await capture(C, "playing-forfeit", A, {
      perWidth: () => A.evaluate(() => { const b = document.querySelector("#forfeitBtn"); if (b) b.click(); }),
      check: () => A.evaluate(() => (document.querySelector("#forfeitYes") ? "" : "forfeit confirmation not shown")),
    });
    await A.evaluate(() => { const b = document.querySelector("[data-act=forfeit-no]"); if (b) b.click(); }).catch(() => {});
    await flow(C, "play to the end", async () => {
      await Promise.all([autoplay(A, 200), autoplay(B, 500)]);
      await Promise.all([A, B].map((p) => p.waitForSelector("[data-test=result]", { timeout: 15000 })));
    });
    await capture(C, "result-win", A);
    await capture(C, "result-loss", B);
    await flow(C, "back to lobby", async () => { await A.click("#backBtn"); await A.waitForSelector("#createBtn"); });
    await capture(C, "history", A, { setup: () => goTab(A, "history", ".hist li") });
    await capture(C, "wallet", A, { setup: () => goTab(A, "wallet", "#wdAmt") });
  } else if (V) await V.context().close().catch(() => {});
}

/* ------------------------------------------------------------------ report */
function summarise(totalMs) {
  const byScreen = new Map();
  for (const r of results) { if (!byScreen.has(r.screen)) byScreen.set(r.screen, []); byScreen.get(r.screen).push(r); }
  const totals = { overflow: 0, offscreen: 0, overlaps: 0, covered: 0, clipped: 0, truncated: 0, charWrap: 0, tap: 0 };
  const lines = [];
  const agg = (rows, field, key) => {
    const m = new Map();
    for (const r of rows) for (const x of r[field]) { const k = key(x); if (!m.has(k)) m.set(k, { x, widths: [] }); m.get(k).widths.push(r.width); }
    return [...m.values()];
  };
  const W = (ws) => (ws.length === WIDTHS.length ? "all" : ws.join(","));
  const MAX = 6;
  for (const [screen, rows] of byScreen) {
    const out = [];
    const ov = rows.filter((r) => r.overflowX > 0);
    totals.overflow += ov.length;
    if (ov.length) out.push(`    page overflow  ${ov.map((r) => `${r.width}:+${r.overflowX}px`).join("  ")}`);
    const sections = [
      ["offscreen", "offscreen", (x) => x.el, (x) => `${x.el}  (${x.past}px past the edge)`],
      ["overlaps", "overlap", (x) => x.a + "|" + x.b, (x) => `${x.a}  ×  ${x.b}  (${x.by}px${x.layer !== "page" ? ", in " + x.layer : ""})`],
      ["covered", "covered", (x) => x.el + "|" + x.by, (x) => `${x.el}  under  ${x.by}  [${x.where}]`],
      ["clipped", "clipped", (x) => x.el, (x) => `${x.el}  cuts "${x.text}" (${x.axis} ${x.by}px)`],
      ["charWrap", "char-wrap", (x) => x.el, (x) => `${x.el}  ${x.lines} lines for ${x.chars} chars, ${x.width}px wide`],
      ["truncated", "truncated", (x) => x.el, (x) => `${x.el}  "${x.text}"`],
    ];
    for (const [field, name, key, fmt] of sections) {
      const a = agg(rows, field, key);
      totals[field] += rows.reduce((n, r) => n + r[field].length, 0);
      a.slice(0, MAX).forEach((e) => out.push(`    ${name.padEnd(10)} ${fmt(e.x)}  @${W(e.widths)}`));
      if (a.length > MAX) out.push(`    ${"".padEnd(10)} … ${a.length - MAX} more ${name} (see report.json)`);
    }
    const tap = agg(rows, "tap", (x) => x.el);
    totals.tap += rows.reduce((n, r) => n + r.tap.length, 0);
    if (tap.length) out.push(`    tap<32     ${tap.length}: ${tap.slice(0, 4).map((e) => `${e.x.el.replace(/ ".*$/, "")} ${e.x.size}`).join(", ")}${tap.length > 4 ? ", …" : ""}`);
    lines.push(`  ${screen}${out.length ? "" : "  ok"}`, ...out);
  }
  console.log("\n─── UI audit ─────────────────────────────────────────────");
  console.log(lines.join("\n"));
  if (skipped.length) { console.log("\n  skipped:"); for (const s of skipped) console.log(`    ${s.screen}: ${s.reason}`); }
  const errs = pages.flatMap((p) => p.errors || []);
  if (errs.length) { console.log("\n  page errors:"); for (const e of [...new Set(errs)].slice(0, 8)) console.log("    " + e); }
  console.log(`\n  ${byScreen.size} screens × ${WIDTHS.length} widths, ${results.length} captures in ${(totalMs / 1000).toFixed(0)}s`);
  console.log(`  totals: overflow ${totals.overflow} · offscreen ${totals.offscreen} · overlaps ${totals.overlaps} · covered ${totals.covered} · clipped ${totals.clipped} · char-wrap ${totals.charWrap} · truncated ${totals.truncated} · tap<32 ${totals.tap}`);
  console.log(`  screenshots + report.json: ${path.relative(process.cwd(), OUT) || OUT}\n`);
  return totals;
}

/* ------------------------------------------------------------------ main */
if (MAIN) await (async () => {
  const t0 = Date.now();
  let stopping = false;
  async function shutdown() {
    if (stopping) return; stopping = true;
    if (browser) await browser.close().catch(() => {});
    if (stack) await stack.stop().catch(() => {});
  }
  process.on("SIGINT", async () => { console.log("\n  interrupted, shutting down…"); await shutdown(); process.exit(0); });

  try {
    if (!CHROME) throw new Error("no Chromium found (set CHROME_PATH or install playwright's chromium)");
    fs.mkdirSync(OUT, { recursive: true });
    console.log(`  starting dev stack…`);
    stack = await startDevStack({
      memory: true, quiet: true,
      overrides: { match: { countdownMs: 1500, acceptMs: 180000, queueTimeoutMs: 30000, pairIntervalMs: 100, durationScale: 1 }, rate: { authPerMin: 1000, apiPerMin: 100000, wsPerSec: 200 } },
    });
    browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
    console.log(`  ${stack.url}/play/  ·  widths ${WIDTHS.join(",")}  ·  height ${HEIGHT}${ONLY ? `  ·  only ${[...ONLY].join(",")}` : ""}`);
    await tour();
  } catch (e) {
    console.error("  audit run failed:", e.stack || e.message);
    skipped.push({ screen: "*", reason: "run aborted: " + e.message.split("\n")[0] });
  } finally {
    await shutdown();
  }
  const totals = summarise(Date.now() - t0);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ generatedAt: new Date().toISOString(), widths: WIDTHS, height: HEIGHT, totals, skipped, results }, null, 2));
  process.exit(0);
})();
