/* The 18+ confirmation: an in-page dialog shown before the first staked create / join / start (and whenever the server answers
   AGE_NOT_CONFIRMED). Free play never needs it. Confirming calls POST /v1/me/age { adult: true }, refreshes /v1/me and then runs
   whatever the player was trying to do. The dialog lives in #ageGate (outside #main, so page renders never touch it); while it is
   open the page behind it is inert, Escape or "Not now" closes it, and focus goes back to where it came from.
   Styles: account.css (.age-). */
import { esc } from "../ui.js";

let resume = null;   // what to do once confirmed (create / join / start the lobby), or null
let opener = null;   // the element that had focus when the dialog opened
let busy = false;
const BEHIND = ["top", "nav", "main"];

const $ = (id) => document.getElementById(id);

/* has the server recorded this player as an adult? `undefined` (a server without the field) counts as "unknown": do not block, let the server's own 403 decide */
export const confirmed = (S) => !!(S.me && S.me.responsible && S.me.responsible.adultConfirmed);
export const known = (S) => !!(S.me && S.me.responsible && typeof S.me.responsible.adultConfirmed === "boolean");
/* true when a staked action must show the dialog first */
export const needed = (S, stake) => stake != null && BigInt(stake) > 0n && known(S) && !confirmed(S);

function markup(S) {
  const real = !!(S.cfg && S.cfg.chain && S.cfg.chain.realMoney), sym = (S.cfg && S.cfg.chain && S.cfg.chain.symbol) || "ETH";
  const chain = (S.cfg && S.cfg.chain && S.cfg.chain.name) || "Ethereum";
  return `<div class="age-card" role="dialog" aria-modal="true" aria-labelledby="ageTitle" aria-describedby="ageText">
    <p class="age-eyebrow">Staked play · 18+</p>
    <h2 class="age-title" id="ageTitle">${real ? `Confirm your age to play for real ${esc(sym)}` : "Confirm your age to play for stakes"}</h2>
    <p class="age-text" id="ageText">${real
      ? `Staked matches use real ${esc(sym)} on ${esc(chain)} and can be lost. They are for adults only. You confirm once, and it is saved to your account.`
      : "Staked matches are for adults only. You confirm once, and it is saved to your account."}</p>
    <label class="age-check" for="ageCheck"><input type="checkbox" id="ageCheck"><span>${real ? "I am 18 or older and play with real money at my own risk" : "I am 18 or older and want to play staked matches"}</span></label>
    <div class="age-err err" id="ageErr" role="alert"></div>
    <div class="age-acts">
      <button type="button" class="dg-btn primary" id="ageConfirm" data-act="age-confirm" disabled><span>Confirm and continue</span></button>
      <button type="button" class="dg-btn" id="ageCancel" data-act="age-cancel"><span>Not now</span></button>
    </div>
  </div>`;
}

/* open the dialog; `then` runs after a successful confirmation */
export function ask(app, then) {
  const gate = $("ageGate");
  if (!gate) return;
  resume = then || null;
  if (gate.hidden) opener = document.activeElement;
  busy = false;
  gate.innerHTML = markup(app.S);
  gate.hidden = false;
  for (const id of BEHIND) { const el = $(id); if (el) el.setAttribute("inert", ""); }
  document.body.classList.add("age-open");
  const box = $("ageCheck");
  if (box) box.focus();
}

export function close(app, { restore = true } = {}) {
  const gate = $("ageGate");
  if (!gate || gate.hidden) return;
  gate.hidden = true; gate.innerHTML = "";
  for (const id of BEHIND) { const el = $(id); if (el) el.removeAttribute("inert"); }
  document.body.classList.remove("age-open");
  resume = null; busy = false;
  if (restore && opener) {
    const target = opener.isConnected ? opener : (opener.id ? $(opener.id) : null); // #main was re-rendered: find the same control again
    if (target && target.focus) target.focus();
  }
  opener = null;
}

export const actions = {
  "age-open": async (el, app) => ask(app, null),
  "age-cancel": async (el, app) => close(app),
  "age-confirm": async (el, app) => {
    if (busy) return;
    const box = $("ageCheck"), err = $("ageErr"), btn = $("ageConfirm");
    if (!box || !box.checked) { if (err) err.textContent = "Tick the box to confirm."; return; }
    busy = true; if (err) err.textContent = "";
    if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
    try {
      await app.api("POST", "/v1/me/age", { adult: true });
      await app.refreshMe();
      const r = app.S.me && app.S.me.responsible;
      if (r && r.adultConfirmed !== true) r.adultConfirmed = true; // the answer was ok: do not ask again even if /v1/me lags
    } catch (e) {
      busy = false;
      if (err) err.textContent = e.message;
      if (btn) { btn.disabled = !box.checked; btn.removeAttribute("aria-busy"); }
      return;
    }
    const next = resume;
    close(app, { restore: !next });
    app.render(true);
    if (next) next();
  },
};

/* the button waits for the tick */
export function onChange(e) {
  if (e.target.id !== "ageCheck") return false;
  const btn = $("ageConfirm"), err = $("ageErr");
  if (btn) btn.disabled = !e.target.checked || busy;
  if (err) err.textContent = "";
  return true;
}

/* Escape closes; Tab stays inside the dialog (the page behind is inert as well) */
document.addEventListener("keydown", (e) => {
  const gate = $("ageGate");
  if (!gate || gate.hidden) return;
  if (e.key === "Escape") { e.preventDefault(); if (!busy) { const c = $("ageCancel"); if (c) c.click(); } return; }
  if (e.key !== "Tab") return;
  const items = [...gate.querySelectorAll("input,button")].filter((x) => !x.disabled);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (!gate.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
