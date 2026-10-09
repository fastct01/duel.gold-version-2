import { DuelClient } from "/play/sdk/duel-client.js";
import { makeHelpers, esc, netBadge } from "/play/ui.js";
import * as shell from "/play/views/shell.js";
import * as lobby from "/play/views/lobby.js";
import * as matchUI from "/play/views/match.js";
import * as account from "/play/views/account.js";
import * as practice from "/play/views/practice.js";
import * as celebrate from "/play/views/celebrate.js";
import * as gamelobby from "/play/views/gamelobby.js";
import * as age from "/play/views/age.js";

const { ethers, DG } = window;
const $ = (s, r = document) => r.querySelector(s);
const TEST = new URLSearchParams(location.search).has("test");
const store = {
  get(k, area = "localStorage") { try { return window[area].getItem(k); } catch { return null; } },
  set(k, v, area = "localStorage") { try { window[area].setItem(k, v); } catch { /* storage blocked: fine, just not remembered */ } },
  del(k, area = "localStorage") { try { window[area].removeItem(k); } catch { /* ignore */ } },
};

/* Pages reachable from the navigation while no match is running (S.view === "lobby").
   Invite-only: there is no player search, no public queue and no leaderboard page. Games are joined with an invite link or code.
   "join" (enter an invite code) is opened from the Join button in the top bar, not from the sidebar.
   "game" is one game's own lobby page (#game/<id>, views/gamelobby.js), opened from its card in the Game library. */
const TABS = ["lobby", "games", "tournaments", "history", "wallet", "settings", "join", "game"];
/* "#games" → { tab: "games" }; "#game/sudoku" → { tab: "game", id: "sudoku" }; anything else → null */
function parseHash(hash = location.hash) {
  const t = hash.slice(1);
  if (t.startsWith("game/")) { const id = decodeURIComponent(t.slice(5)); return id ? { tab: "game", id } : null; }
  return TABS.includes(t) && t !== "game" ? { tab: t } : null;
}

const S = {
  cfg: null, games: [], client: null, me: null, wallet: null, activity: null,
  view: "signin", busy: false, error: "",
  tab: (parseHash() || { tab: "lobby" }).tab,
  pick: { game: "", stake: "0", custom: "", code: "" },
  lobby: null,     // the lobby I am in while it waits for its start (member view: players[], role "host" | "guest"), else null
  host: null,      // that same lobby while I am its host (kept so older code paths keep working), else null
  invite: null,    // { code, lobby|null, error, loading } while the page was opened with ?join=CODE and not yet consumed
  match: null, result: null, startInfo: null,
  handle: null, myScore: 0, oppScore: 0, submitted: false, confirmForfeit: false, oppFinished: false, oppReady: false, youReady: false,
  forfeited: false, // I forfeited a match with 3+ players: it goes on for the others and I wait for its result
  seats: {},       // the other players of the running match by seat → { ready, finished, forfeited, score }; oppScore/oppReady/oppFinished summarise it
  history: null,   // GET /v1/matches?limit=30
  ui: {},          // free-form view state owned by the view modules (filters, open panels, …)
  practice: null,  // local practice game vs a bot in the Games tab (views/practice.js)
  depositing: null, // amount (test ETH, local chain only) of a deposit on its way in; Deposit buttons show "Depositing…" and stay disabled
};

if (S.tab === "game") S.ui.gameId = parseHash().id;

const MODULES = [shell, lobby, matchUI, account, practice, celebrate, gamelobby, age];
const VIEWS = Object.assign({}, ...MODULES.map((m) => m.views || {}));
const ACTIONS = Object.assign({}, ...MODULES.map((m) => m.actions || {}));
const h = makeHelpers(S);
const CODE_RE = /^[A-Za-z0-9]{4,16}$/;
readInviteParam();

/* ------------------------------------------------------------------ helpers */

/* at most 3 on screen (oldest dropped, repeats replaced); time on screen grows with the text, errors stay a bit longer */
function toast(text, kind = "") {
  const box = $("#toasts");
  for (const t of [...box.children]) if (t.textContent === text) t.remove();
  while (box.children.length >= 3) box.firstElementChild.remove();
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = text;
  box.appendChild(el);
  const ms = Math.min(7000, 2600 + String(text).length * 40) + (kind === "bad" ? 1500 : 0);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 220); }, ms);
}

async function http(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((data.error && data.error.message) || res.statusText), { code: data.error && data.error.code });
  return data;
}

function pickedStake() {
  if (S.pick.stake === "0") return 0n;
  if (S.pick.stake === "custom") {
    try { return S.pick.custom.trim() ? ethers.parseEther(S.pick.custom.trim()) : null; } catch { return null; }
  }
  return BigInt(S.pick.stake);
}

/* What every view and action receives. Views are pure: (ctx) => html. Actions: async (el, app) => void. */
const inviteUrl = (code) => `${location.origin}/?join=${encodeURIComponent(code)}`;
const ctx = { S, h, pickedStake, inviteUrl };
const app = {
  S, h, ctx, store, toast, http, render, go, act, createLobby, joinLobby, inviteUrl, askAge,
  api: (method, path, body, headers) => S.client.api(method, path, body, headers),
  refreshMe, refreshWallet, loadHistory,
};

/* render unless the player is typing: a re-render would steal focus from the field */
let renderQueued = false, pointerDown = false, lastPage = "", enterTimer = 0;
window.addEventListener("pointerdown", () => { pointerDown = true; }, true);
window.addEventListener("pointerup", () => { pointerDown = false; }, true);
window.addEventListener("pointercancel", () => { pointerDown = false; }, true);
function render(force = false) {
  const a = document.activeElement;
  if (!force && a && a !== document.body && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.closest("#main")) {
    if (!renderQueued) {
      renderQueued = true;
      /* if the field lost focus because a button is being pressed, render only after that click has landed,
         otherwise the DOM would be swapped between mousedown and click and the press would be lost */
      a.addEventListener("blur", () => {
        const run = () => { renderQueued = false; render(); };
        if (pointerDown) window.addEventListener("pointerup", () => setTimeout(run, 0), { once: true }); else run();
      }, { once: true });
    }
    return;
  }
  renderTop();
  document.body.dataset.view = S.view;
  document.body.dataset.tab = S.view === "lobby" ? S.tab : "";
  if (S.view === "play") return renderPlay(); // keeps the running game's DOM intact
  if (practice.running()) {
    if (S.view === "lobby" && S.tab === "games") return; // a practice game is running here: leave its DOM alone
    practice.stop(S); // left the Games tab, or a real match arrived: stop practising
  }
  const name = S.view === "lobby" ? S.tab : S.view;
  $("#main").innerHTML = (VIEWS[name] || VIEWS.lobby)(ctx);
  /* page entrance (app.css .pg-enter): only when the page actually changes, so background refreshes never replay it */
  if (name !== lastPage) {
    lastPage = name;
    const main = $("#main");
    main.classList.remove("pg-enter"); void main.offsetWidth; main.classList.add("pg-enter");
    clearTimeout(enterTimer); enterTimer = setTimeout(() => main.classList.remove("pg-enter"), 1200);
  }
  for (const m of MODULES) if (m.mount) m.mount(name, app);
}

/* the bar and nav are rebuilt on every render; unchanged markup is left alone so focus, hover and the open menu survive polls */
function setHTML(el, html) { if (el && el._html !== html) { el._html = html; el.innerHTML = html; } }
function renderTop() {
  setHTML($("#topNet"), S.view === "signin" ? "" : netBadge(S));
  setHTML($("#topRight"), shell.topBar(ctx));
  setHTML($("#nav"), shell.nav(ctx));
}

/* the play view builds its frame once; afterwards only small pieces are updated so the game's DOM is never rebuilt */
function renderPlay() {
  if (!$("#stage")) $("#main").innerHTML = matchUI.playFrame(ctx);
  updatePlayBar();
}
function updatePlayBar() { matchUI.playBar(ctx); }

/* switch page (lobby tabs). Leaves matches alone: during a match the nav only changes S.tab for afterwards.
   go("game", id) opens that game's lobby page and makes it the picked game; it gets its own history entry so Back
   returns to the library. An unknown id falls back to the library. */
function go(tab, arg) {
  if (!TABS.includes(tab)) tab = "lobby";
  if (tab === "game") {
    const id = arg || S.ui.gameId;
    if (!id || (S.games.length && !S.games.some((g) => g.id === id))) tab = "games";
    else { S.ui.gameId = id; S.pick.game = id; }
  }
  const from = S.tab;
  S.tab = tab;
  const hash = tab === "game" ? "game/" + encodeURIComponent(S.ui.gameId) : tab;
  if (location.hash.slice(1) !== hash) {
    const url = tab === "lobby" ? location.pathname + location.search : "#" + hash;
    if (tab === "game" && from !== "game") history.pushState(null, "", url); else history.replaceState(null, "", url);
  }
  if (S.view === "result") { S.result = null; S.view = "lobby"; }
  if (S.view === "waiting" || S.view === "invite") S.view = "lobby"; // the open lobby / pending invite stay reachable from the top bar
  render(true);
  window.scrollTo(0, 0);
  if (tab === "history") loadHistory();
  if (tab === "wallet" && S.wallet) refreshWallet().then(() => render());
  if (tab === "join") { const i = document.getElementById("joinCode"); if (i && matchMedia("(pointer:fine)").matches) i.focus(); }
}

/* ------------------------------------------------------------------ data */

async function refreshMe() {
  if (!S.client) return;
  try {
    S.me = await S.client.api("GET", "/v1/me");
    S.client.me = S.me;
    if (S.cfg.chain && !S.wallet) await refreshWallet();
    else if (S.wallet) S.wallet.balances = S.me.balances;
    render();
  } catch (e) { if (e.status === 401) signOut(); }
}

async function refreshWallet() {
  if (!S.cfg.chain) return;
  try {
    const [w, wd, dep, acts] = await Promise.all([S.client.api("GET", "/v1/wallet"), S.client.api("GET", "/v1/wallet/withdrawals"), S.client.api("GET", "/v1/wallet/deposits"), S.client.api("GET", "/v1/matches?limit=6")]);
    S.wallet = { ...w, withdrawals: wd.withdrawals, deposits: dep.deposits };
    S.activity = { matches: acts.matches };
  } catch (e) { S.error = e.message; }
}

async function loadHistory() {
  if (!S.client) return;
  try { const r = await S.client.api("GET", "/v1/matches?limit=30"); S.history = r.matches; render(); }
  catch (e) { toast(e.message, "bad"); }
}

setInterval(() => { if (S.client && !document.hidden && S.view === "invite") loadInvite(true); }, 5000);

/* ------------------------------------------------------------------ invites (?join=CODE) */

function readInviteParam() {
  const q = new URLSearchParams(location.search);
  let code = q.get("join");
  if (code != null) {
    q.delete("join");
    const qs = q.toString();
    try { history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash); } catch { /* ignore */ }
    code = code.trim().toUpperCase();
    if (CODE_RE.test(code)) store.set("dg.invite", code, "sessionStorage"); else code = null;
  }
  if (!code) code = store.get("dg.invite", "sessionStorage");
  if (code && CODE_RE.test(code)) S.invite = { code, lobby: null, error: "", loading: true };
}

/* fetch the public lobby behind the invite; `quiet` re-renders only when something visible changed.
   The visible part is the lobby's state or error plus who is in it: a changed roster is patched in place (focus stays on Join). */
const inviteKind = (inv) => (inv.lobby ? inv.lobby.state : inv.error);
const inviteSig = (inv) => (inv.lobby ? [inv.lobby.state, matchUI.countOf(inv.lobby), matchUI.lobbyPlayers(inv.lobby).map((p) => p.name).join(",")].join("|") : inv.error);
async function loadInvite(quiet = false) {
  const inv = S.invite;
  if (!inv) return;
  const before = inviteSig(inv), kindBefore = inviteKind(inv);
  try { const r = await http(`/v1/lobbies/${encodeURIComponent(inv.code)}`); inv.lobby = r.lobby; inv.error = ""; }
  catch (e) {
    if (S.invite !== inv) return;
    inv.lobby = null;
    inv.error = e.code === "LOBBY_NOT_FOUND" || /not found/i.test(e.message) ? "LOBBY_NOT_FOUND" : e.message;
  }
  inv.loading = false;
  if (S.invite !== inv) return;
  if (quiet && before === inviteSig(inv)) return;
  if (S.view === "signin") render(true);
  else if (S.view === "invite") { if (quiet && inviteKind(inv) === kindBefore && matchUI.patchInvite(ctx)) return; render(true); }
}

function clearInvite() { S.invite = null; store.del("dg.invite", "sessionStorage"); }

/* after sign-in: send the player to the invite screen unless they are busy with something else */
function routeInvite() {
  const inv = S.invite;
  if (!inv) return;
  if (S.lobby && S.lobby.code === inv.code) { clearInvite(); S.view = "waiting"; return; } // my own lobby's link (host), or a reload while already in it (guest)
  if (S.lobby) { clearInvite(); toast(S.lobby.role === "host" ? "You already have an open lobby. Close it first to accept an invite." : "You are already in a lobby. Leave it first to accept an invite.", "gold"); return; }
  if (S.view !== "lobby") { clearInvite(); toast("Finish your current match first, then open the invite link again.", "gold"); return; }
  S.error = ""; S.view = "invite";
}

/* ------------------------------------------------------------------ sign-in / session */

async function signIn(kind) {
  S.error = "";
  if (!window.ethereum) throw new Error("No browser wallet found. Install a wallet such as MetaMask, then reload this page.");
  const signer = await new ethers.BrowserProvider(window.ethereum).getSigner();
  const address = await signer.getAddress(), sign = (m) => signer.signMessage(m);
  const client = new DuelClient({ baseUrl: location.origin, address, sign, bufferEvents: false });
  await client.login();
  store.set("dg.token", client.token, "sessionStorage");
  store.set("dg.address", address, "sessionStorage");
  await startSession(client);
}

/* ------------------------------------------------------------------ email accounts (views/shell.js emailForm) */

const postJSON = (path, body) => http(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/* a session from an email sign-in, a confirmed link or a password reset: the same client a wallet sign-in builds, without a signer */
async function emailSession(out) {
  const address = out.me && out.me.address;
  const client = new DuelClient({ baseUrl: location.origin, address, sign: () => { throw new Error("Link a wallet first."); }, bufferEvents: false });
  client.token = out.token;
  client.me = out.me;
  store.set("dg.token", out.token, "sessionStorage");
  if (address) store.set("dg.address", address, "sessionStorage"); else store.del("dg.address", "sessionStorage");
  S.ui.emailMode = "signin"; S.ui.resetToken = null;
  await startSession(client);
}

async function emailSubmit(form, kind, e) {
  const err = $("#emErr"), btn = e.submitter || form.querySelector("button[type=submit]");
  const email = (($("#emEmail") || {}).value || "").trim(), password = ($("#emPw") || {}).value || "";
  if (err) err.textContent = "";
  form.dataset.busy = "1";
  if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
  try {
    if (kind === "email-signin") await emailSession(await postJSON("/v1/auth/email/login", { email, password }));
    else if (kind === "email-signup") { await postJSON("/v1/auth/email/signup", { email, password }); S.ui.emailMode = "sent"; S.ui.emailTo = email; render(true); }
    else if (kind === "email-forgot") { await postJSON("/v1/auth/email/forgot", { email }); S.ui.emailMode = "sent-reset"; S.ui.emailTo = email; render(true); }
    else if (kind === "email-reset") await emailSession(await postJSON("/v1/auth/email/reset", { token: S.ui.resetToken, password }));
  } catch (ex) {
    if (err && err.isConnected) err.textContent = ex.message; else { S.error = ex.message; render(true); }
  } finally {
    delete form.dataset.busy;
    if (btn && btn.isConnected) { btn.disabled = false; btn.removeAttribute("aria-busy"); }
  }
}

/* ?verify=TOKEN (confirms the email and signs in) and ?reset=TOKEN (opens "choose a new password"), from the links we email;
   the token leaves the address bar at once */
function readEmailLink() {
  const q = new URLSearchParams(location.search);
  const kind = q.has("verify") ? "verify" : q.has("reset") ? "reset" : null;
  if (!kind) return null;
  const token = q.get(kind);
  q.delete("verify"); q.delete("reset");
  const qs = q.toString();
  try { history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash); } catch { /* ignore */ }
  return { kind, token };
}

/* an email account proves it owns a wallet: the wallet signs a sign-in nonce, the server links it (once) */
async function linkWallet(el) {
  if (!window.ethereum) { toast("No browser wallet found. Install a wallet such as MetaMask, then reload this page.", "bad"); return; }
  el.disabled = true;
  try {
    const signer = await new ethers.BrowserProvider(window.ethereum).getSigner();
    const address = await signer.getAddress();
    const n = await S.client.api("POST", "/v1/auth/nonce", { address });
    await S.client.api("POST", "/v1/me/wallet/link", { address, nonce: n.nonce, signature: await signer.signMessage(n.message) });
    S.client.address = address;
    store.set("dg.address", address, "sessionStorage");
    toast("Wallet linked. Withdrawals go to this wallet.", "good");
    await refreshMe();
    if (S.wallet) await refreshWallet();
    render(true);
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    if (el.isConnected) el.disabled = false;
  }
}

async function resume(token) {
  const address = store.get("dg.address", "sessionStorage");
  const client = new DuelClient({ baseUrl: location.origin, address, sign: () => { throw new Error("sign in again"); }, bufferEvents: false });
  client.token = token;
  client.me = await client.api("GET", "/v1/me");
  await startSession(client);
}

async function startSession(client) {
  S.client = client;
  wire(client);
  await client.connect();
  S.me = client.me;
  await refreshMe();
  S.view = "lobby";
  S.error = "";
  applyActive(S.me.active);
  if (S.invite) { if (S.invite.loading || !S.invite.lobby) await loadInvite(true); routeInvite(); }
  if (TEST) window.__duel = { client, S, get ctx() { return S.handle && S.handle.ctx; } };
  render(true);
  if (S.tab !== "lobby") go(S.tab);
}

function signOut() {
  if (S.client) {
    S.client.api("POST", "/v1/auth/logout").catch(() => {}); // best effort: the token also expires by itself
    S.client.close();
  }
  store.del("dg.token", "sessionStorage");
  Object.assign(S, { client: null, me: null, wallet: null, activity: null, view: "signin", match: null, result: null, host: null, lobby: null, seats: {} });
  render(true);
}

/* ------------------------------------------------------------------ live events */

/* ---- the lobby I am in (S.lobby; S.host is the same object while I am its host) ---- */

const gone = new Set(); // codes of lobbies I left, cancelled, or that started: a late lobby.updated for one of them is ignored
let exiting = null;     // code of the lobby I am leaving / cancelling right now: its lobby.closed event needs no toast of its own

/* the server tags member views with role; guess one only for a server that does not */
function normLobby(l, hint) {
  if (!l || l.role) return l || null;
  const me = Array.isArray(l.players) ? l.players.find((p) => p.you) : null;
  return { ...l, role: hint || (me && !me.host ? "guest" : "host") };
}
function setLobby(l, hint) {
  l = normLobby(l, hint);
  S.lobby = l;
  S.host = l && l.role === "host" ? l : null;
  if (l) gone.delete(l.code);
}
function dropLobby() { if (S.lobby) gone.add(S.lobby.code); S.lobby = null; S.host = null; }
/* the roster, Start button and pot changed: patch them in place when the waiting room is on screen */
function refreshLobbyView() {
  if (S.view === "waiting") { if (!matchUI.patchLobby(ctx)) render(true); }
  else if (S.view === "lobby") render();
}

/* ---- the running match: the other players by seat ---- */

function initMatchState(m) {
  const ps = matchUI.playersOf(m, S.me);
  S.seats = {};
  for (const p of ps) if (!p.you) S.seats[p.seat] = { ready: !!p.ready, finished: !!p.finished, forfeited: !!p.forfeited, score: 0 };
  S.youReady = !!(ps.find((p) => p.you) || m.you || {}).ready;
  S.myScore = 0; S.submitted = false; S.confirmForfeit = false;
  S.forfeited = !!(ps.find((p) => p.you) || {}).forfeited;
  summariseSeats();
}
/* oppReady / oppFinished / oppScore: one answer for "the others" (the first opponent in a duel) */
function summariseSeats() {
  const all = Object.values(S.seats);
  S.oppReady = all.length > 0 && all.every((x) => x.ready);
  S.oppFinished = all.length > 0 && all.every((x) => x.finished || x.forfeited);
  S.oppScore = Math.max(0, ...all.map((x) => (x.forfeited ? 0 : Number(x.score) || 0)));
}
/* an event about another player of my match; the server names that player by seat (a server without lobbies sends none: the one opponent) */
function seatEvent(m, apply) {
  if (!S.match || (m.matchId != null && String(m.matchId) !== String(S.match.id))) return false;
  const seat = m.seat != null ? m.seat : Object.keys(S.seats)[0];
  if (seat == null) return false;
  apply(S.seats[seat] || (S.seats[seat] = { ready: false, finished: false, forfeited: false, score: 0 }));
  summariseSeats();
  return true;
}
/* a match was made from my lobby: everyone goes to the found screen. Safe to call twice for the same match. */
function enterMatch(match) {
  if (S.match && S.match.id === match.id && ["found", "play"].includes(S.view)) return;
  clearInvite(); dropLobby();
  S.match = match; S.result = null; S.error = ""; S.busy = false; S.view = "found";
  initMatchState(match);
  render(true); refreshMe();
}

function applyActive(active) {
  if (!active) {
    dropLobby();
    if (["found", "orphan", "waiting"].includes(S.view)) S.view = "lobby";
    return;
  }
  if (active.kind === "lobby") { setLobby(active.lobby); if (S.view !== "invite") S.view = "waiting"; return; }
  dropLobby();
  if (!active.match) { if (S.view !== "play") S.view = "lobby"; return; } // an unknown kind of activity: nothing to resume
  S.match = active.match;
  if (active.match.state === "found") { initMatchState(active.match); S.view = "found"; }
  else {
    S.forfeited = !!(matchUI.playersOf(active.match, S.me).find((p) => p.you) || {}).forfeited; // reloaded after forfeiting a match that is still going
    if (S.view !== "play") S.view = "orphan";
  }
}

/* someone joined or left the lobby I am in (the server sends the new member view to every member, including me) */
function onLobbyUpdated(raw) {
  if (!raw) return;
  const l = normLobby(raw, S.lobby ? S.lobby.role : undefined);
  if (gone.has(l.code) || (S.lobby && S.lobby.code !== l.code)) return;
  if (l.state && l.state !== "open") return; // a started or closed lobby is announced by match.found / lobby.closed
  const before = S.lobby ? matchUI.lobbyPlayers(S.lobby).map((p) => p.name) : null;
  setLobby(l);
  if (S.view === "invite" && S.invite && S.invite.code === l.code) { /* my own join: this event and the HTTP answer race, the first one moves me into the room */
    clearInvite(); S.view = "waiting"; S.busy = false; S.error = "";
    render(true); window.scrollTo(0, 0); return;
  }
  if (before) {
    const now = matchUI.lobbyPlayers(l);
    for (const p of now) if (!p.you && !before.includes(p.name)) toast(`${p.name} joined the lobby.`, "gold");
    for (const name of before) if (!now.some((p) => p.name === name)) toast(`${name} left the lobby.`, "");
  }
  refreshLobbyView();
}

/* the lobby ended without me pressing anything: the host cancelled it, it expired, or it started (match.found follows) */
function onLobbyClosed(l) {
  const cur = S.lobby;
  if (!cur || (l && l.code !== cur.code)) return; // already handled locally, or not mine
  const reason = l && l.closedReason, host = cur.role === "host", back = String(cur.stake) === "0" ? "" : " Stake returned.";
  const mine = exiting === cur.code;
  dropLobby();
  if (reason === "matched" || mine) return; // match.found follows / leaveLobby() and closeLobby() finish the job themselves
  if (S.view === "waiting") S.view = "lobby";
  toast(reason === "left" ? "You left the lobby." + back // my own leave from another tab or device
    : reason === "expired" ? (host ? "Your lobby expired." : "The lobby expired.") + back
    : host ? "Lobby closed." + back
    : reason === "cancelled" ? "The host closed the lobby." + back
    : "The lobby was closed." + back, "gold");
  render(true); refreshMe();
}

function wire(c) {
  c.on("sync", (m) => { S.me = m.me; applyActive(m.me.active); render(true); });
  c.on("lobby.created", (m) => { if (!m.lobby) return; setLobby(m.lobby, "host"); if (S.view === "invite" || (S.view === "lobby" && S.tab === "lobby")) { S.view = "waiting"; S.busy = false; render(true); } else render(); });
  c.on("lobby.updated", (m) => onLobbyUpdated(m.lobby));
  c.on("lobby.closed", (m) => onLobbyClosed(m.lobby));
  c.on("match.found", (m) => enterMatch(m.match));
  c.on("match.opponent_ready", (m) => { if (seatEvent(m, (s) => { s.ready = true; }) && S.view === "found" && !matchUI.patchFound(ctx)) render(true); });
  c.on("match.start", (m) => onStart(m));
  c.on("match.opponent_progress", (m) => { if (seatEvent(m, (s) => { s.score = m.score; }) && S.view === "play") updatePlayBar(); });
  c.on("match.opponent_finished", (m) => { if (seatEvent(m, (s) => { s.finished = true; }) && S.view === "play") updatePlayBar(); });
  c.on("match.opponent_forfeited", (m) => { if (seatEvent(m, (s) => { s.forfeited = true; }) && S.view === "play") updatePlayBar(); });
  c.on("match.result", (m) => onEnded(m.match));
  c.on("match.void", (m) => onEnded(m.match));
  c.on("wallet.updated", () => { refreshMe(); if (S.wallet) refreshWallet().then(() => render()); });
  c.on("close", (ev) => { if (S.client === c && ev.code !== 1000) { toast("Connection lost. Reconnecting…", "bad"); reconnect(c); } });
}

async function reconnect(c, attempt = 0) {
  if (S.client !== c || attempt > 5) return;
  await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  try { await c.connect(); toast("Reconnected.", "good"); }
  catch { reconnect(c, attempt + 1); }
}

function onStart(m) {
  if (!S.match || S.match.id !== m.matchId) return;
  S.startInfo = m;
  if (m.seed == null) { S.view = "orphan"; render(true); return; } // the challenge went to another tab
  S.view = "play";
  document.getElementById("main").innerHTML = ""; // fresh frame for this match
  render(true);
  const tick = () => {
    const left = m.startAt - S.client.serverNow();
    const cd = $("#countdown");
    if (cd) cd.innerHTML = matchUI.countdown(ctx, left);
    if (left > 0) setTimeout(tick, 100); else startGame(m.seed);
  };
  tick();
}

function startGame(seed) {
  if (S.view !== "play" || S.forfeited) return; // forfeited or finished while counting down
  const m = S.match, g = DG.getGame(m.game.id);
  if (!g) { toast("This game could not be loaded. Forfeiting.", "bad"); return act("forfeit-yes"); }
  S.myScore = 0;
  /* the game gets every other player of the match (most games only show the first one) */
  const others = matchUI.playersOf(m, S.me).filter((p) => !p.you);
  S.handle = DG.start(g, {
    root: $("#stage"), seed, mode: "full", format: "1v1", speed: 1,
    me: { name: S.me.displayName, rating: m.you.ratingBefore },
    opponents: others.map((p) => ({ name: p.name, rating: p.ratingBefore, skill: DG.util.skillFromRating(p.ratingBefore) })),
    onStatus: (t) => { const el = $("#status"); if (el) el.textContent = t; },
    onProgress: (s) => { S.myScore = s; updatePlayBar(); S.client.progress(m.id, s); },
    onEnd: (r) => finishGame(r),
    onError: (e) => { console.error("[game error]", e); toast("The game hit a problem. Forfeiting.", "bad"); act("forfeit-yes"); },
  });
}

async function finishGame(r) {
  const m = S.match;
  const score = Number(r && r.score);
  S.submitted = true;
  updatePlayBar();
  if (!Number.isFinite(score)) { toast("The game did not produce a score.", "bad"); return; }
  S.myScore = score; updatePlayBar();
  try { await S.client.submit(m.id, score); }
  catch (e) { if (e.code !== "MATCH_NOT_PLAYING") toast(e.message, "bad"); }
}

/* The server's answer to a forfeit. With 3+ players the match goes on for the others (state "playing") and I stay in it until it ends:
   stop my game, show "You forfeited" and wait for match.result. A duel (or a declined match) ends at once and the result follows. */
function afterForfeit(r) {
  if (!r || r.state !== "playing" || !S.match) return;
  S.forfeited = true; S.confirmForfeit = false;
  if (S.handle) { try { S.handle.abort(); } catch { /* already over */ } S.handle = null; }
  const st = $("#status"); if (st) st.textContent = ""; // the stopped game's "Round 1/5"
  if (S.view === "play") updatePlayBar(); else if (S.view === "orphan") render(true);
}

function onEnded(match) {
  if (S.handle) { try { S.handle.abort(); } catch { /* already over */ } S.handle = null; }
  S.result = match; S.match = null; S.view = "result"; S.confirmForfeit = false; S.forfeited = false;
  render(true);
  refreshMe();
  if (S.wallet) refreshWallet().then(() => { if (S.view === "lobby") render(); });
}

/* ------------------------------------------------------------------ deposits */

/* Deposit test ETH: the dev faucet sends it on-chain to the player's own deposit address, the server credits it after
   its confirmations, and we wait for that credit so the player sees the deposit land (not just "sent").
   Amount from data-eth on the button (max 1 per request, the faucet's cap). */
async function deposit(el) {
  if (!S.wallet) return toast("The wallet is still loading. Try again in a moment.", "gold");
  if (S.depositing) return toast(`Your deposit of ${S.depositing} test ${h.sym()} is still on its way in.`, "gold");
  const amount = Math.min(1, Number(el && el.dataset.eth) || 1), label = `${amount} test ${h.sym()}`;
  const before = BigInt(S.me.balances.available);
  S.depositing = amount;
  render(true);
  try {
    await http("/v1/dev/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: S.wallet.depositAddress, eth: amount }) });
    toast(`Depositing ${label}… waiting for the network to confirm it.`, "gold");
    /* the server pushes wallet.updated when it credits the deposit; poll as a fallback */
    const end = Date.now() + 30000;
    while (BigInt(S.me.balances.available) <= before && Date.now() < end) {
      await refreshMe();
      if (BigInt(S.me.balances.available) <= before) await new Promise((r) => setTimeout(r, 700));
    }
    if (BigInt(S.me.balances.available) > before) {
      await refreshWallet();
      toast(`Deposit credited: +${label}. Balance ${h.eth(S.me.balances.available)} ${h.sym()}.`, "good");
    } else toast(`Your deposit of ${label} is still confirming. It will show up in your balance shortly.`, "gold");
  } catch (e) { toast(e.message, "bad"); }
  finally {
    S.depositing = null;
    render();
  }
}

/* ------------------------------------------------------------------ actions */

async function act(name, el) {
  const c = S.client;
  try {
    if (ACTIONS[name]) return await ACTIONS[name](el, app);
    switch (name) {
      case "go": go(el.dataset.go, el.dataset.arg); break;
      case "injected":
        el.disabled = true; try { await signIn(name); } catch (e) { S.error = e.message; render(true); } break;
      case "logout": signOut(); break;
      case "email-mode": {
        S.ui.emailMode = el.dataset.v; S.error = ""; render(true);
        const f = $(S.ui.emailMode === "reset" ? "#emPw" : "#emEmail"); if (f && matchMedia("(pointer:fine)").matches) f.focus();
        break;
      }
      case "link-wallet": return linkWallet(el);
      case "stake": S.pick.stake = el.dataset.v; render(true); break;
      case "copy":
        try { await navigator.clipboard.writeText(S.wallet.depositAddress); toast("Address copied.", "good"); }
        catch { toast("Select the address and copy it.", ""); } break;
      case "faucet": return deposit(el);
      case "create-lobby": return createLobby();
      case "close-lobby": return closeLobby();
      case "start-lobby": return startLobby();
      case "leave-lobby": return leaveLobby();
      case "reset-pick": S.pick = { ...S.pick, game: defaultGame(), stake: "0", custom: "" }; S.error = ""; render(true); break;
      case "copy-invite": return copyInvite();
      case "share-invite": return shareInvite();
      case "join-lobby": return joinLobby();
      case "dismiss-invite": clearInvite(); S.error = ""; if (S.view === "invite") S.view = "lobby"; render(true); break;
      case "ready": S.youReady = true; render(true); await c.ready(S.match.id); break;
      case "decline": await c.forfeit(S.match.id); break;
      case "forfeit": S.confirmForfeit = true; updatePlayBar(); break;
      case "forfeit-no": S.confirmForfeit = false; updatePlayBar(); break;
      case "forfeit-yes": case "forfeit-now": if (S.match) afterForfeit(await c.forfeit(S.match.id)); break;
      case "back": S.result = null; S.view = "lobby"; await refreshMe(); render(true); break;
      case "rematch": {
        const r = S.result;
        if (r) {
          if (r.game && S.games.some((g) => g.id === r.game.id)) S.pick.game = r.game.id;
          const st = String(r.stake || "0");
          const tiers = ((S.cfg && S.cfg.stake && S.cfg.stake.tiers) || []).map(String);
          if (st === "0" || tiers.includes(st)) S.pick.stake = st;
          else { S.pick.stake = "custom"; try { S.pick.custom = ethers.formatEther(BigInt(st)); } catch { S.pick.custom = ""; } }
        }
        S.error = "";
        go("lobby");
        break;
      }
      case "limit-off": { const r = await c.api("PUT", "/v1/me/loss-limit", { amount: null }); toast(r.applied ? "Loss limit removed." : "Loss limit will be removed in 24 hours.", "gold"); await refreshMe(); break; }
    }
  } catch (e) {
    if (e.code === "AGE_NOT_CONFIRMED") { S.busy = false; return askAge(null); }
    S.error = e.message;
    if (["found", "lobby", "waiting", "invite"].includes(S.view)) render(true);
    if (!["create-lobby", "join-lobby"].includes(name)) toast(e.message, "bad");
  }
}

/* ---- 18+ confirmation (views/age.js) ---- */

/* show the confirmation; `then` (create / join / start again) runs once the player has confirmed */
function askAge(then) { age.ask(app, then); }
const isAgeError = (e) => !!e && e.code === "AGE_NOT_CONFIRMED";

async function createLobby() {
  if (S.busy) return;
  S.error = "";
  const g = S.pick.game;
  if (!g) { S.error = "Choose a game first."; return render(true); }
  const stake = pickedStake();
  if (stake == null) { S.error = "Enter a stake like 0.002."; return render(true); }
  if (age.needed(S, stake)) return askAge(createLobby); // the first staked lobby asks for the 18+ confirmation, then carries on
  S.busy = true;
  try {
    const r = await S.client.api("POST", "/v1/lobbies", { game: g, stake: stake.toString() });
    setLobby(r.lobby, "host"); S.view = "waiting"; S.busy = false; S.error = ""; S.ui.copiedUntil = 0;
    render(true); window.scrollTo(0, 0);
    refreshMe();
  } catch (e) {
    S.busy = false;
    if (isAgeError(e)) { render(true); return askAge(createLobby); }
    S.error = e.status === 404 ? "Lobbies are not available on this server yet." : e.message;
    render(true);
  }
}

/* the game the lobby picker starts on (and returns to when the picks are cancelled) */
function defaultGame() {
  if (!S.games.length) return "";
  return S.games.some((g) => g.id === "reaction") ? "reaction" : S.games[0].id;
}

/* error codes the lobby endpoints add, in plain words (anything else shows the server's own message) */
const LOBBY_ERRORS = {
  LOBBY_FULL: "This lobby is full.",
  LOBBY_NOT_IN: "You are not in this lobby.",
  LOBBY_ALREADY_IN: "You are already in this lobby.",
  LOBBY_HOST_LEAVE: "The host cannot leave. Cancel the lobby instead.",
  LOBBY_NOT_ENOUGH_PLAYERS: "Wait for at least one more player before starting.",
  LOBBY_NOT_HOST: "Only the host can start the match.",
  LOBBY_OWN: "This is your own lobby. Send the link to a friend.",
};
/* a few errors carry numbers (minPlayers, playerCount, maxPlayers in e.extra): use them when present */
function lobbyError(e) {
  const x = e.extra || {};
  if (e.code === "LOBBY_NOT_ENOUGH_PLAYERS" && x.minPlayers) return `At least ${x.minPlayers} players are needed to start${x.playerCount ? ` (${x.playerCount} in the lobby)` : ""}. Wait for one more.`;
  if (e.code === "LOBBY_FULL" && x.maxPlayers) return `This lobby is full (${x.maxPlayers} players).`;
  return LOBBY_ERRORS[e.code] || e.message;
}

/* host: cancel the lobby. The server returns every player's stake and tells the guests. */
async function closeLobby() {
  const l = S.host;
  if (!l) { S.view = "lobby"; return render(true); }
  const free = String(l.stake) === "0", others = matchUI.countOf(l) > 1;
  exiting = l.code;
  try {
    await S.client.api("DELETE", `/v1/lobbies/${encodeURIComponent(l.code)}`);
    toast(free ? "Lobby closed." : others ? "Lobby closed. Every player’s stake was returned." : "Lobby closed. Stake returned.", "gold");
  } catch (e) {
    if (e.code === "LOBBY_CLOSED") toast("That lobby was already closed.", "gold"); else throw e;
  } finally { exiting = null; }
  dropLobby(); if (S.view === "waiting") S.view = "lobby"; S.error = "";
  render(true); refreshMe();
}

/* host: start the match with the players who are in. The server answers with the match; every player also gets match.found. */
async function startLobby() {
  const l = S.host;
  if (!l || S.busy) return;
  S.error = ""; S.busy = true;
  refreshLobbyView();
  try {
    const r = await S.client.api("POST", `/v1/lobbies/${encodeURIComponent(l.code)}/start`, {});
    S.busy = false;
    if (r && r.match) enterMatch(r.match);
  } catch (e) {
    S.busy = false;
    if (isAgeError(e)) { if (S.view === "waiting") render(true); return askAge(startLobby); }
    S.error = lobbyError(e);
    if (S.view === "waiting") render(true);
  }
}

/* guest: leave before the start and get the stake back. The page itself (Back to lobby, a reload) never drops you from the lobby. */
async function leaveLobby() {
  const l = S.lobby;
  if (!l || l.role === "host" || S.busy) return;
  S.busy = true; S.error = ""; exiting = l.code;
  try {
    await S.client.api("POST", `/v1/lobbies/${encodeURIComponent(l.code)}/leave`, {});
    toast(String(l.stake) === "0" ? "You left the lobby." : "You left the lobby. Stake returned.", "gold");
  } catch (e) {
    if (e.code === "LOBBY_CLOSED" || e.code === "LOBBY_NOT_FOUND") toast("That lobby was already closed.", "gold");
    else if (e.code === "LOBBY_NOT_IN") toast("You were not in that lobby any more.", "gold"); // e.g. already left from another tab
    else { S.error = lobbyError(e); if (S.view === "waiting") render(true); return; }
  } finally { S.busy = false; exiting = null; }
  dropLobby(); if (S.view === "waiting") S.view = "lobby"; S.error = "";
  render(true); refreshMe();
}

async function copyInvite() {
  if (!S.host) return;
  const url = inviteUrl(S.host.code), input = $("#inviteLink");
  try { await navigator.clipboard.writeText(url); }
  catch { if (input) { input.focus(); input.select(); } toast("Press Ctrl/Cmd+C to copy the link.", ""); return; }
  S.ui.copiedUntil = Date.now() + 2200;
  const btn = $("#copyInvite");
  if (btn) { btn.dataset.copied = "1"; const t = btn.querySelector("span"); if (t) t.textContent = "Copied"; }
  setTimeout(() => { const b = $("#copyInvite"); if (b && Date.now() >= S.ui.copiedUntil) { delete b.dataset.copied; const t = b.querySelector("span"); if (t) t.textContent = "Copy link"; } }, 2300);
}

async function shareInvite() {
  if (!S.host || !navigator.share) return;
  const l = S.host;
  const stake = String(l.stake) === "0" ? "free" : `${h.eth(l.stake)} ${h.sym()}`;
  try { await navigator.share({ title: "Duel.gold challenge", text: `${S.me.displayName} invites you to play ${l.game.name} (${stake}) on Duel.gold.`, url: inviteUrl(l.code) }); }
  catch (e) { if (e && e.name !== "AbortError") toast("Could not open the share sheet. Copy the link instead.", "bad"); }
}

async function joinLobby() {
  const inv = S.invite;
  if (!inv || S.busy) return;
  S.error = "";
  if (inv.lobby && age.needed(S, inv.lobby.stake)) return askAge(joinLobby); // a staked invite asks for the 18+ confirmation first
  S.busy = true; render(true);
  try {
    gone.delete(inv.code);
    const r = await S.client.api("POST", `/v1/lobbies/${encodeURIComponent(inv.code)}/join`, {});
    S.busy = false;
    if (r && r.match) enterMatch(r.match); // this join filled the lobby, which started the match at once (match.found normally arrives first; enterMatch ignores the duplicate)
    else if (r && r.lobby) {
      /* joining puts me in the lobby; the host starts the match. lobby.updated may already have moved me into the room. */
      const fromInvite = S.view === "invite";
      clearInvite(); setLobby(r.lobby, "guest");
      if (fromInvite) { S.view = "waiting"; S.error = ""; render(true); window.scrollTo(0, 0); }
      else refreshLobbyView();
      refreshMe();
    } else render(true);
  } catch (e) {
    S.busy = false;
    if (isAgeError(e)) { render(true); return askAge(joinLobby); }
    if (e.code === "LOBBY_CLOSED" || e.code === "LOBBY_NOT_FOUND" || e.code === "LOBBY_FULL") { await loadInvite(true); S.error = e.code === "LOBBY_FULL" ? lobbyError(e) : ""; }
    else if (e.code === "LOBBY_ALREADY_IN") { /* e.g. joined in another tab: the server knows where I am */
      await refreshMe(); clearInvite(); S.view = "lobby"; applyActive(S.me && S.me.active); S.error = "";
    }
    else S.error = lobbyError(e);
    render(true);
  }
}

/* ------------------------------------------------------------------ DOM events */

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (el && !el.disabled) { if (el.tagName === "A") e.preventDefault(); act(el.dataset.act, el); return; }
  const nav = e.target.closest("[data-go]");
  if (nav) { e.preventDefault(); go(nav.dataset.go, nav.dataset.arg); }
});
/* Back / Forward between hash pages (e.g. a game page ↔ the library). Before sign-in only the tab is remembered. */
function onHash() {
  const p = parseHash() || { tab: "lobby" };
  if (p.tab === S.tab && (p.tab !== "game" || p.id === S.ui.gameId)) return;
  if (!S.me) { S.tab = p.tab; if (p.id) S.ui.gameId = p.id; return; }
  go(p.tab, p.id);
}
window.addEventListener("hashchange", onHash);
window.addEventListener("popstate", onHash);
document.addEventListener("change", (e) => {
  for (const m of MODULES) if (m.onChange && m.onChange(e, app)) return;
  if (e.target.id === "gameSel") { S.pick.game = e.target.value; render(true); }
});
document.addEventListener("input", (e) => {
  for (const m of MODULES) if (m.onInput && m.onInput(e, app)) return;
  if (e.target.id === "customStake") S.pick.custom = e.target.value;
  if (e.target.id === "code") S.pick.code = e.target.value.replace(/[^A-Za-z0-9]/g, "");
});
/* remember whether the email sign-in is open, so a re-render (an error, a refresh) does not fold it away */
document.addEventListener("toggle", (e) => {
  if (e.target instanceof HTMLDetailsElement && e.target.classList.contains("em-more")) S.ui.emailOpen = e.target.open;
}, true);

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  if (form.dataset.busy) return; // one request at a time: a double click must not queue two withdrawals
  const kind = form.dataset.form;
  if (kind.startsWith("email-")) return emailSubmit(form, kind, e);
  const err = $(kind === "withdraw" ? "#wdErr" : "#limErr");
  const btn = e.submitter || form.querySelector("button[type=submit]");
  err.textContent = "";
  form.dataset.busy = "1";
  if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
  try {
    if (kind === "withdraw") {
      const amount = ethers.parseEther(($("#wdAmt").value || "0").trim());
      /* maxFee = the network fee the player was shown: the server refuses with FEE_CHANGED if it went up since */
      const body = { amount: amount.toString(), ...(S.ui.wdFee != null ? { maxFee: S.ui.wdFee } : {}) };
      const r = await S.client.api("POST", "/v1/wallet/withdraw", body, { "idempotency-key": crypto.randomUUID() });
      toast(`Withdrawal of ${h.eth(r.amount)} ${h.sym()} queued.`, "good");
      $("#wdAmt").value = "";
      account.closeWdConfirm(app);
    } else {
      const amount = ethers.parseEther(($("#limitAmt").value || "0").trim());
      const r = await S.client.api("PUT", "/v1/me/loss-limit", { amount: amount.toString() });
      toast(r.applied ? "Loss limit set." : "Raising a limit takes 24 hours to apply.", "gold");
    }
    await refreshMe();
    if (S.wallet) { await refreshWallet(); render(true); }
  } catch (ex) {
    err.textContent = ex.message;
    if (kind === "withdraw") {
      const typed = ($("#wdAmt") && $("#wdAmt").value || "").trim();
      account.closeWdConfirm(app);
      if (ex.code === "FEE_CHANGED" && ex.extra && ex.extra.fee != null && S.wallet && typed) { // show the new fee and ask again
        S.wallet.withdrawalFee = { ...(S.wallet.withdrawalFee || {}), fee: String(ex.extra.fee) };
        err.textContent = `The network fee changed to ${h.eth(ex.extra.fee, 9)} ${h.sym()}. Review it and confirm again.`;
        account.showWdConfirm(app, typed);
      }
    }
  }
  finally { delete form.dataset.busy; if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); } }
});

/* countdown labels */
setInterval(() => {
  for (const el of document.querySelectorAll("[data-until]")) {
    el.textContent = h.left(el.dataset.until);
  }
}, 250);

/* ------------------------------------------------------------------ boot */

async function loadPacks(games) {
  for (const pack of [...new Set(games.map((g) => g.pack).filter(Boolean))]) {
    await new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = `/game/games/${encodeURIComponent(pack)}.js`;
      s.onload = resolve;
      s.onerror = () => { console.error("game pack failed to load:", pack); resolve(); };
      document.head.appendChild(s);
    });
  }
}

(async function boot() {
  try {
    const [cfg, list] = await Promise.all([http("/v1/config"), http("/v1/games")]);
    S.cfg = cfg;
    document.title = cfg.chain && cfg.chain.realMoney ? `Duel.gold · invite-only duels with real ${cfg.chain.symbol || "ETH"}`
      : cfg.chain ? "Duel.gold · invite-only duels (test network)" : "Duel.gold · invite-only skill duels";
    S.games = list.games.filter((g) => g.pvp);
    await loadPacks(S.games);
    S.games = S.games.filter((g) => DG.getGame(g.id)); // only games whose code actually loaded
    S.pick.game = defaultGame();
  } catch (e) {
    $("#main").innerHTML = `<section class="dg-box"><h2 class="dg-h">Cannot reach the server</h2><p class="lede">${esc(e.message)}</p></section>`;
    return;
  }
  const link = readEmailLink();
  if (link && link.kind === "verify") {
    try { await emailSession(await postJSON("/v1/auth/email/verify", { token: link.token })); return; }
    catch (e) { S.error = e.message; }
  } else if (link) { S.ui.emailMode = "reset"; S.ui.resetToken = link.token; }
  const token = !link || link.kind !== "reset" ? store.get("dg.token", "sessionStorage") : null; // a reset link always shows the form
  if (token) { try { await resume(token); return; } catch { store.del("dg.token", "sessionStorage"); } }
  render(true);
  if (S.invite) loadInvite();
})();
