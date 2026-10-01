import { DuelClient } from "/play/sdk/duel-client.js";
import { makeHelpers, esc } from "/play/ui.js";
import * as shell from "/play/views/shell.js";
import * as lobby from "/play/views/lobby.js";
import * as matchUI from "/play/views/match.js";
import * as account from "/play/views/account.js";
import * as practice from "/play/views/practice.js";
import * as gamelobby from "/play/views/gamelobby.js";

const { ethers, DG } = window;
const $ = (s, r = document) => r.querySelector(s);
const TEST = new URLSearchParams(location.search).has("test");
const store = {
  get(k, area = "localStorage") { try { return window[area].getItem(k); } catch { return null; } },
  set(k, v, area = "localStorage") { try { window[area].setItem(k, v); } catch { /* storage blocked: fine, just not remembered */ } },
  del(k, area = "localStorage") { try { window[area].removeItem(k); } catch { /* ignore */ } },
};

/* Pages reachable from the navigation while no match is running (S.view === "lobby").
   The leaderboard page (account.js) is hidden for now: add "leaderboard" back here and to NAV in shell.js to restore it.
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
  host: null,      // the host's open lobby (public view object) while waiting for a friend, else null
  invite: null,    // { code, lobby|null, error, loading } while the page was opened with ?join=CODE and not yet consumed
  queue: null, match: null, result: null, startInfo: null,
  handle: null, myScore: 0, oppScore: 0, submitted: false, confirmForfeit: false, oppFinished: false, oppReady: false, youReady: false,
  live: undefined, // GET /v1/lobby, refreshed every few seconds (undefined until the first answer, null if the server has no such endpoint)
  boards: {},      // game id → leaderboard rows (GET /v1/leaderboard)
  history: null,   // GET /v1/matches?limit=30
  ui: {},          // free-form view state owned by the view modules (filters, open panels, …)
  practice: null,  // local practice game vs a bot in the Games tab (views/practice.js)
  depositing: null, // amount (test ETH) of a deposit on its way in; Deposit buttons show "Depositing…" and stay disabled
};

if (S.tab === "game") S.ui.gameId = parseHash().id;

const MODULES = [shell, lobby, matchUI, account, practice, gamelobby];
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
const inviteUrl = (code) => `${location.origin}/play/?join=${encodeURIComponent(code)}`;
const ctx = { S, h, pickedStake, inviteUrl };
const app = {
  S, h, ctx, store, toast, http, render, find, go, act, createLobby, joinLobby, inviteUrl,
  api: (method, path, body, headers) => S.client.api(method, path, body, headers),
  refreshMe, refreshWallet, loadBoard, loadHistory, loadLive,
};

/* render unless the player is typing: a re-render would steal focus from the field */
let renderQueued = false, pointerDown = false;
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
  for (const m of MODULES) if (m.mount) m.mount(name, app);
}

/* the bar and nav are rebuilt on every render; unchanged markup is left alone so focus, hover and the open menu survive polls */
function setHTML(el, html) { if (el && el._html !== html) { el._html = html; el.innerHTML = html; } }
function renderTop() {
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
  if (tab === "leaderboard" && S.pick.game) loadBoard(S.pick.game);
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

async function loadBoard(gameId) {
  try { const r = await http(`/v1/leaderboard?game=${encodeURIComponent(gameId)}&limit=20`); S.boards[gameId] = r.players; render(); }
  catch { S.boards[gameId] = S.boards[gameId] || []; }
}

async function loadHistory() {
  if (!S.client) return;
  try { const r = await S.client.api("GET", "/v1/matches?limit=30"); S.history = r.matches; render(); }
  catch (e) { toast(e.message, "bad"); }
}

/* live lobby numbers (who is waiting, matches running, recent results). Modules patch them in place via
   `live(app)` so a poll never re-renders the page under the player. A server without /v1/lobby sets S.live to null. */
let liveMissing = false;
async function loadLive() {
  if (liveMissing) return;
  try { S.live = await http("/v1/lobby"); }
  catch (e) { if (!/not found/i.test(e.message)) return; liveMissing = true; S.live = null; }
  for (const m of MODULES) if (m.live) m.live(app);
}
setInterval(() => { if (S.client && !document.hidden && ["lobby", "queue", "result"].includes(S.view)) loadLive(); }, 4000);
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

/* fetch the public lobby behind the invite; `quiet` re-renders only when something visible changed */
async function loadInvite(quiet = false) {
  const inv = S.invite;
  if (!inv) return;
  const before = inv.lobby ? inv.lobby.state : inv.error;
  try { const r = await http(`/v1/lobbies/${encodeURIComponent(inv.code)}`); inv.lobby = r.lobby; inv.error = ""; }
  catch (e) {
    if (S.invite !== inv) return;
    inv.lobby = null;
    inv.error = e.code === "LOBBY_NOT_FOUND" || /not found/i.test(e.message) ? "LOBBY_NOT_FOUND" : e.message;
  }
  inv.loading = false;
  if (S.invite !== inv) return;
  const after = inv.lobby ? inv.lobby.state : inv.error;
  if (!quiet || before !== after) { if (S.view === "signin" || S.view === "invite") render(true); }
}

function clearInvite() { S.invite = null; store.del("dg.invite", "sessionStorage"); }

/* after sign-in: send the player to the invite screen unless they are busy with something else */
function routeInvite() {
  const inv = S.invite;
  if (!inv) return;
  if (S.view !== "lobby") { clearInvite(); if (S.view === "waiting") toast("You already have an open lobby. Close it first to accept an invite.", "gold"); else toast("Finish your current match first, then open the invite link again.", "gold"); return; }
  if (S.host && S.host.code === inv.code) { clearInvite(); S.view = "waiting"; return; }
  if (S.host) { clearInvite(); toast("You already have an open lobby. Close it first to accept an invite.", "gold"); return; }
  S.error = ""; S.view = "invite";
}

/* ------------------------------------------------------------------ sign-in / session */

function burnerWallet() {
  let key = store.get("dg.burner");
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) { key = ethers.Wallet.createRandom().privateKey; store.set("dg.burner", key); }
  return new ethers.Wallet(key);
}

async function signIn(kind) {
  S.error = "";
  let address, sign;
  if (kind === "burner") {
    const w = burnerWallet();
    address = w.address; sign = (m) => w.signMessage(m);
  } else {
    if (!window.ethereum) throw new Error("No browser wallet found.");
    const signer = await new ethers.BrowserProvider(window.ethereum).getSigner();
    address = await signer.getAddress(); sign = (m) => signer.signMessage(m);
  }
  const client = new DuelClient({ baseUrl: location.origin, address, sign, bufferEvents: false });
  await client.login();
  store.set("dg.token", client.token, "sessionStorage");
  store.set("dg.address", address, "sessionStorage");
  await startSession(client);
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
  loadLive();
  if (S.tab !== "lobby") go(S.tab);
}

function signOut() {
  if (S.client) {
    S.client.api("POST", "/v1/auth/logout").catch(() => {}); // best effort: the token also expires by itself
    S.client.close();
  }
  store.del("dg.token", "sessionStorage");
  Object.assign(S, { client: null, me: null, wallet: null, activity: null, view: "signin", queue: null, match: null, result: null, host: null });
  render(true);
}

/* ------------------------------------------------------------------ live events */

function applyActive(active) {
  if (!active) {
    S.host = null;
    if (["queue", "found", "orphan", "waiting"].includes(S.view)) S.view = "lobby";
    return;
  }
  if (active.kind === "lobby") { S.host = active.lobby; if (S.view !== "invite") S.view = "waiting"; return; }
  S.host = null;
  if (active.kind === "queue") { S.queue = active.ticket; S.view = "queue"; return; }
  S.match = active.match;
  if (active.match.state === "found") { S.youReady = active.match.you.ready; S.oppReady = active.match.opponent.ready; S.view = "found"; }
  else if (S.view !== "play") S.view = "orphan";
}

function wire(c) {
  c.on("sync", (m) => { S.me = m.me; applyActive(m.me.active); render(true); });
  c.on("queue.joined", (m) => { S.queue = m.ticket; S.view = "queue"; S.busy = false; render(true); });
  c.on("queue.left", () => { S.queue = null; S.view = "lobby"; refreshMe(); });
  c.on("queue.expired", () => { S.queue = null; S.view = "lobby"; toast("Nobody was found in time. Your stake is back.", "gold"); refreshMe(); });
  c.on("lobby.created", (m) => { if (!m.lobby) return; S.host = m.lobby; if (S.view === "invite" || (S.view === "lobby" && S.tab === "lobby")) { S.view = "waiting"; S.busy = false; render(true); } else render(); });
  c.on("lobby.closed", (m) => {
    const l = m.lobby;
    if (!S.host || (l && l.code !== S.host.code)) return; // already handled locally, or not ours
    const reason = l && l.closedReason;
    S.host = null;
    if (reason === "matched") return; // match.found follows
    if (S.view === "waiting") S.view = "lobby";
    toast(reason === "expired" ? "Your lobby expired. Stake returned." : "Lobby closed. Stake returned.", "gold");
    render(true); refreshMe();
  });
  c.on("match.found", (m) => { if (S.match && S.match.id === m.match.id && ["found", "play"].includes(S.view)) return; clearInvite(); S.host = null; S.match = m.match; S.youReady = false; S.oppReady = false; S.oppScore = 0; S.myScore = 0; S.submitted = false; S.oppFinished = false; S.confirmForfeit = false; S.result = null; S.error = ""; S.view = "found"; render(true); refreshMe(); });
  c.on("match.opponent_ready", () => { S.oppReady = true; if (S.view === "found") render(true); });
  c.on("match.start", (m) => onStart(m));
  c.on("match.opponent_progress", (m) => { S.oppScore = m.score; if (S.view === "play") updatePlayBar(); });
  c.on("match.opponent_finished", () => { S.oppFinished = true; if (S.view === "play") updatePlayBar(); });
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
  if (S.view !== "play") return; // forfeited or finished while counting down
  const m = S.match, g = DG.getGame(m.game.id);
  if (!g) { toast("This game could not be loaded. Forfeiting.", "bad"); return act("forfeit-yes"); }
  S.myScore = 0;
  S.handle = DG.start(g, {
    root: $("#stage"), seed, mode: "full", format: "1v1", speed: 1,
    me: { name: S.me.displayName, rating: m.you.ratingBefore },
    opponents: [{ name: m.opponent.name, rating: m.opponent.ratingBefore, skill: DG.util.skillFromRating(m.opponent.ratingBefore) }],
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

function onEnded(match) {
  if (S.handle) { try { S.handle.abort(); } catch { /* already over */ } S.handle = null; }
  S.result = match; S.match = null; S.queue = null; S.view = "result"; S.confirmForfeit = false;
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
      case "burner": case "injected":
        el.disabled = true; try { await signIn(name); } catch (e) { S.error = e.message; render(true); } break;
      case "logout": signOut(); break;
      case "stake": S.pick.stake = el.dataset.v; render(true); break;
      case "copy":
        try { await navigator.clipboard.writeText(S.wallet.depositAddress); toast("Address copied.", "good"); }
        catch { toast("Select the address and copy it.", ""); } break;
      case "faucet": return deposit(el);
      case "find": return find(); // only for a server with publicQueue on (the game page's "Random opponent" mode)
      case "create-lobby": return createLobby();
      case "close-lobby": return closeLobby();
      case "reset-pick": S.pick = { ...S.pick, game: defaultGame(), stake: "0", custom: "" }; S.error = ""; render(true); break;
      case "copy-invite": return copyInvite();
      case "share-invite": return shareInvite();
      case "join-lobby": return joinLobby();
      case "dismiss-invite": clearInvite(); S.error = ""; if (S.view === "invite") S.view = "lobby"; render(true); break;
      case "cancel-queue": await c.leaveQueue(); break;
      case "ready": S.youReady = true; render(true); await c.ready(S.match.id); break;
      case "decline": await c.forfeit(S.match.id); break;
      case "forfeit": S.confirmForfeit = true; updatePlayBar(); break;
      case "forfeit-no": S.confirmForfeit = false; updatePlayBar(); break;
      case "forfeit-yes": case "forfeit-now": if (S.match) await c.forfeit(S.match.id); break;
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
    S.error = e.message;
    if (["found", "lobby", "queue", "waiting", "invite"].includes(S.view)) render(true);
    if (!["find", "create-lobby", "join-lobby"].includes(name)) toast(e.message, "bad");
  }
}

async function find() {
  const c = S.client;
  S.error = "";
  const g = S.pick.game;
  if (!g) { S.error = "Choose a game first."; return render(true); }
  const stake = pickedStake();
  if (stake == null) { S.error = "Enter a stake like 0.002."; return render(true); }
  try {
    S.busy = true;
    await c.joinQueue({ game: g, stake: stake.toString(), code: S.pick.code.trim() || undefined });
  } catch (e) {
    S.busy = false;
    S.error = e.message;
    render(true);
  }
}

async function createLobby() {
  if (S.busy) return;
  S.error = "";
  const g = S.pick.game;
  if (!g) { S.error = "Choose a game first."; return render(true); }
  const stake = pickedStake();
  if (stake == null) { S.error = "Enter a stake like 0.002."; return render(true); }
  S.busy = true;
  try {
    const r = await S.client.api("POST", "/v1/lobbies", { game: g, stake: stake.toString() });
    S.host = r.lobby; S.view = "waiting"; S.busy = false; S.error = ""; S.ui.copiedUntil = 0;
    render(true); window.scrollTo(0, 0);
    refreshMe();
  } catch (e) {
    S.busy = false;
    S.error = e.status === 404 ? "Lobbies are not available on this server yet." : e.message;
    render(true);
  }
}

/* the game the lobby picker starts on (and returns to when the picks are cancelled) */
function defaultGame() {
  if (!S.games.length) return "";
  return S.games.some((g) => g.id === "reaction") ? "reaction" : S.games[0].id;
}

async function closeLobby() {
  const l = S.host;
  if (!l) { S.view = "lobby"; return render(true); }
  try {
    await S.client.api("DELETE", `/v1/lobbies/${encodeURIComponent(l.code)}`);
    toast("Lobby closed. Stake returned.", "gold");
  } catch (e) {
    if (e.code === "LOBBY_CLOSED") toast("That lobby was already closed.", "gold"); else throw e;
  }
  S.host = null; S.view = "lobby"; S.error = "";
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
  try { await navigator.share({ title: "Duel.gold challenge", text: `${S.me.displayName} challenges you to ${l.game.name} (${stake}) on Duel.gold.`, url: inviteUrl(l.code) }); }
  catch (e) { if (e && e.name !== "AbortError") toast("Could not open the share sheet. Copy the link instead.", "bad"); }
}

async function joinLobby() {
  const inv = S.invite;
  if (!inv || S.busy) return;
  S.error = "";
  S.busy = true; render(true);
  try {
    const r = await S.client.api("POST", `/v1/lobbies/${encodeURIComponent(inv.code)}/join`, {});
    S.busy = false;
    if (S.view === "invite" && r && r.match) { /* match.found normally arrives first; apply it ourselves if not */
      const m = r.match;
      clearInvite(); S.host = null; S.match = m; S.youReady = false; S.oppReady = false; S.oppScore = 0; S.myScore = 0; S.submitted = false; S.oppFinished = false; S.confirmForfeit = false; S.result = null; S.error = ""; S.view = "found";
      render(true); refreshMe();
    }
  } catch (e) {
    S.busy = false;
    if (e.code === "LOBBY_CLOSED" || e.code === "LOBBY_NOT_FOUND") { await loadInvite(true); S.error = ""; }
    else if (e.code === "LOBBY_OWN") S.error = "This is your own lobby. Send the link to a friend.";
    else S.error = e.message;
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
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  if (form.dataset.busy) return; // one request at a time: a double click must not queue two withdrawals
  const kind = form.dataset.form;
  const err = $(kind === "withdraw" ? "#wdErr" : "#limErr");
  const btn = form.querySelector("button[type=submit]");
  err.textContent = "";
  form.dataset.busy = "1";
  if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
  try {
    if (kind === "withdraw") {
      const amount = ethers.parseEther(($("#wdAmt").value || "0").trim());
      const r = await S.client.api("POST", "/v1/wallet/withdraw", { amount: amount.toString() }, { "idempotency-key": crypto.randomUUID() });
      toast(`Withdrawal of ${h.eth(r.amount)} ${h.sym()} queued.`, "good");
      $("#wdAmt").value = "";
    } else {
      const amount = ethers.parseEther(($("#limitAmt").value || "0").trim());
      const r = await S.client.api("PUT", "/v1/me/loss-limit", { amount: amount.toString() });
      toast(r.applied ? "Loss limit set." : "Raising a limit takes 24 hours to apply.", "gold");
    }
    await refreshMe();
    if (S.wallet) { await refreshWallet(); render(true); }
  } catch (ex) { err.textContent = ex.message; }
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
    S.games = list.games.filter((g) => g.pvp);
    await loadPacks(S.games);
    S.games = S.games.filter((g) => DG.getGame(g.id)); // only games whose code actually loaded
    S.pick.game = defaultGame();
  } catch (e) {
    $("#main").innerHTML = `<section class="dg-box"><h2 class="dg-h">Cannot reach the server</h2><p class="lede">${esc(e.message)}</p></section>`;
    return;
  }
  const token = store.get("dg.token", "sessionStorage");
  if (token) { try { await resume(token); return; } catch { store.del("dg.token", "sessionStorage"); } }
  render(true);
  if (S.invite) loadInvite();
})();
