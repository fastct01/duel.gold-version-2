/* Duel.gold PvP reference client. Vanilla JS, no build step.
   Signs in with a wallet, shows the on-chain balance, queues for a real opponent and plays the server-chosen seeded
   challenge with the same game packs the single-player prototype uses. Add ?test=1 to expose window.__duel for tests. */
import { DuelClient } from "/play/sdk/duel-client.js";

const { ethers, DG } = window;
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TEST = new URLSearchParams(location.search).has("test");
const store = {
  get(k, area = "localStorage") { try { return window[area].getItem(k); } catch { return null; } },
  set(k, v, area = "localStorage") { try { window[area].setItem(k, v); } catch { /* storage blocked: fine, just not remembered */ } },
  del(k, area = "localStorage") { try { window[area].removeItem(k); } catch { /* ignore */ } },
};

const S = {
  cfg: null, games: [], client: null, me: null, wallet: null, activity: null,
  view: "signin", busy: false, error: "",
  pick: { game: "", stake: "0", custom: "", code: "", adult: false },
  queue: null, match: null, result: null, startInfo: null,
  handle: null, myScore: 0, oppScore: 0, submitted: false, confirmForfeit: false, oppFinished: false, oppReady: false, youReady: false,
};

/* ------------------------------------------------------------------ helpers */

const eth = (wei, max = 6) => {
  const s = ethers.formatEther(BigInt(wei || 0));
  const [i, f = ""] = s.split(".");
  const cut = f.slice(0, max).replace(/0+$/, "");
  return cut ? `${i}.${cut}` : i;
};
const sym = () => (S.cfg && S.cfg.chain ? S.cfg.chain.symbol : "ETH");
const left = (t) => { const s = Math.max(0, Math.ceil((Number(t) - (S.client ? S.client.serverNow() : Date.now())) / 1000)); return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`; };
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const game = (id) => S.games.find((g) => g.id === id);

function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = text;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function http(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((data.error && data.error.message) || res.statusText), { code: data.error && data.error.code });
  return data;
}

/* render unless the player is typing: a re-render would steal focus from the field */
let renderQueued = false;
function render(force = false) {
  const a = document.activeElement;
  if (!force && a && a !== document.body && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.closest("#main")) {
    if (!renderQueued) { renderQueued = true; a.addEventListener("blur", () => { renderQueued = false; render(); }, { once: true }); }
    return;
  }
  renderTop();
  if (S.view === "play") return renderPlay(); // keeps the running game's DOM intact
  $("#main").innerHTML = (VIEWS[S.view] || VIEWS.lobby)();
  if (S.view === "lobby") syncLobbyInputs();
}

function renderTop() {
  const t = $("#topRight");
  if (!S.me) { t.innerHTML = ""; return; }
  const b = S.me.balances;
  t.innerHTML = `<span class="pill" title="${esc(S.me.address)}"><span class="nm">${esc(S.me.displayName)}</span> <b class="dg-mono">${esc(short(S.me.address))}</b></span>` +
    `<span class="pill"><span class="lbl">Balance</span> <b class="dg-mono" id="topBal">${esc(eth(b.available))} ${esc(sym())}</b></span>` +
    `<button class="dg-btn out" data-act="logout">Sign out</button>`;
  if (S.cfg && S.cfg.chain) $("#netTag").textContent = `${S.cfg.chain.name} · test network, no real money`;
}

/* ------------------------------------------------------------------ views */

const VIEWS = {
  signin() {
    const hasInjected = !!window.ethereum;
    return `<section class="dg-box dg-stack">
      <h2 class="dg-h">Play real people. Winner takes the pot.</h2>
      <p class="lede">Stake a little test money on a skill game, get matched with another player, play the same challenge, and the higher score wins the pot minus a 10% fee. Test network only, nothing here has real-world value.</p>
      <div class="dg-row">
        <button class="dg-btn primary" data-act="burner" id="signBurner">Continue with a burner wallet</button>
        ${hasInjected ? `<button class="dg-btn" data-act="injected" id="signInjected">Connect browser wallet</button>` : ""}
      </div>
      <p class="dg-note">A burner wallet is a key created and kept in this browser, only used to sign in. Never send real funds to it. Signing in costs no gas and moves no money.</p>
      <div class="err" id="err">${esc(S.error)}</div>
    </section>`;
  },

  lobby() {
    const me = S.me, w = S.wallet, cfg = S.cfg;
    const adult = me.responsible.adultConfirmed;
    const g = game(S.pick.game);
    const tiers = cfg.stake.tiers;
    const stakeChips = [`<button class="dg-chip" data-act="stake" data-v="0" aria-pressed="${S.pick.stake === "0"}">Free</button>`]
      .concat(tiers.map((t) => `<button class="dg-chip dg-mono" data-act="stake" data-v="${t}" aria-pressed="${S.pick.stake === t}">${eth(t)}</button>`))
      .concat([`<button class="dg-chip" data-act="stake" data-v="custom" aria-pressed="${S.pick.stake === "custom"}">Custom</button>`]).join("");
    const cats = {};
    for (const x of S.games) (cats[x.category] = cats[x.category] || []).push(x);
    const opts = Object.keys(cats).sort().map((c) => `<optgroup label="${esc(c[0].toUpperCase() + c.slice(1))}">${cats[c].map((x) => `<option value="${esc(x.id)}" ${x.id === S.pick.game ? "selected" : ""}>${esc(x.name)} · ${esc(x.duration)}</option>`).join("")}</optgroup>`).join("");
    const stakeWei = pickedStake();
    const pot = stakeWei == null ? null : stakeWei * 2n;
    const payout = pot == null ? null : (pot * BigInt(10000 - cfg.feeBps)) / 10000n;
    const cool = me.responsible.coolOffUntil;
    const banned = me.queueBanUntil;
    const wd = w ? w.withdrawals : [];
    return `
    <div class="grid2">
      <section class="dg-box dg-stack" aria-labelledby="hPlay">
        <h2 class="dg-h" id="hPlay">Find an opponent</h2>
        <div class="field"><label for="gameSel">Game</label>
          <select id="gameSel"><option value="">Choose a game…</option>${opts}</select></div>
        ${g ? `<div class="sub">${esc(g.blurb)} · Skill ${g.skill}/10 · Luck ${g.luck}/10</div>
          <details><summary class="dg-note">How to play</summary><ul class="rules">${g.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>` : ""}
        <div class="field"><span class="label">Stake (${esc(sym())})</span><div class="chips" role="group" aria-label="Stake">${stakeChips}</div></div>
        ${S.pick.stake === "custom" ? `<div class="field"><label for="customStake">Custom stake in ${esc(sym())} (${eth(cfg.stake.min)} to ${eth(cfg.stake.max)})</label><input id="customStake" type="text" inputmode="decimal" value="${esc(S.pick.custom)}" placeholder="0.002"></div>` : ""}
        <div class="field"><label for="code">Private match code (optional): play a friend who enters the same code</label><input id="code" type="text" maxlength="16" value="${esc(S.pick.code)}" placeholder="e.g. FRIDAY7" autocomplete="off"></div>
        ${pot != null && pot > 0n ? `<div class="dg-note dg-mono">Pot ${eth(pot)} · winner receives ${eth(payout)} after the ${cfg.feeBps / 100}% fee</div>` : `<div class="dg-note">Free play: no money moves, but your rating does.</div>`}
        ${pot != null && pot > 0n && !adult ? `<label class="dg-row"><input type="checkbox" id="adult" ${S.pick.adult ? "checked" : ""}> <span>I am 18 or older</span></label>` : ""}
        ${cool ? `<div class="dg-note dg-bad">Cool-off is on until ${new Date(cool).toLocaleString()}. Free play only.</div>` : ""}
        ${banned ? `<div class="dg-note dg-bad">You skipped several matches. You can queue again at ${new Date(banned).toLocaleTimeString()}.</div>` : ""}
        <div class="err" id="err">${esc(S.error)}</div>
        <button class="dg-btn primary" data-act="find" id="findBtn" ${S.busy ? "disabled" : ""}>Find opponent</button>
      </section>

      <section class="dg-box dg-stack" aria-labelledby="hWallet">
        <h2 class="dg-h" id="hWallet">Wallet</h2>
        <div class="bal">
          <div class="dg-stat">Available<b class="dg-mono" id="balAvail">${eth(me.balances.available)}</b></div>
          <div class="dg-stat">In play<b class="dg-mono">${eth(me.balances.inPlay)}</b></div>
          <div class="dg-stat">Withdrawing<b class="dg-mono">${eth(me.balances.pendingWithdrawal)}</b></div>
        </div>
        ${w ? `<div class="field"><span class="label">Your deposit address on ${esc(w.chain.name)}: send test ${esc(w.chain.symbol)} here (from a normal wallet, not a smart-contract wallet)</span>
          <div class="mono-box" id="depositAddr" data-test="deposit-address">${esc(w.depositAddress)}</div>
          <div class="dg-row"><button class="dg-btn" data-act="copy">Copy address</button>
          ${cfg.devFaucet ? `<button class="dg-btn" data-act="faucet" id="faucetBtn">Add 1 test ${esc(sym())}</button>` : ""}</div>
          <div class="dg-note">Credited after ${w.chain.confirmations} confirmation${w.chain.confirmations > 1 ? "s" : ""}. Payouts go only to your sign-in wallet ${esc(short(w.withdrawTo))}.</div></div>
        <form data-form="withdraw" class="dg-stack" autocomplete="off">
          <div class="field"><label for="wdAmt">Withdraw (${esc(sym())}, min ${eth(w.limits.min)})</label>
          <div class="dg-row"><input id="wdAmt" type="text" inputmode="decimal" placeholder="0.01" style="flex:1;min-width:120px"><button class="dg-btn" type="submit" id="wdBtn">Withdraw</button></div></div>
          <div class="err" id="wdErr"></div>
        </form>` : `<div class="dg-note">The wallet is not enabled on this server.</div>`}
        ${wd.length ? `<div class="list" aria-label="Recent withdrawals">${wd.slice(0, 4).map((x) => `<div class="row"><span class="dg-mono">${eth(x.amount)} ${esc(sym())}</span><span class="sub">${esc(x.status)}${x.explorerUrl ? ` · <a href="${esc(x.explorerUrl)}" target="_blank" rel="noopener">tx</a>` : ""}</span></div>`).join("")}</div>` : ""}
      </section>
    </div>

    <div class="grid2">
      <section class="dg-box dg-stack" aria-labelledby="hHist">
        <h3 class="dg-h" id="hHist">Recent matches</h3>
        ${S.activity && S.activity.matches.length ? `<div class="list">${S.activity.matches.map((m) => `<div class="row"><span>${esc(m.game.name)} vs <b>${esc(m.opponent.name)}</b></span><span class="dg-mono ${m.result === "win" ? "dg-good" : m.result === "loss" ? "dg-bad" : ""}">${esc(m.result)}${m.stake !== "0" ? ` · ${m.result === "win" ? "+" + eth(BigInt(m.you.payout) - BigInt(m.stake)) : m.result === "loss" ? "−" + eth(m.stake) : "±0"}` : ""}</span></div>`).join("")}</div>` : `<div class="dg-note">No matches yet.</div>`}
      </section>
      <details class="dg-box" id="respPlay">
        <summary>Responsible play</summary>
        <div class="dg-stack">
          <div class="dg-note">Daily loss limit: <b>${me.responsible.lossLimit ? eth(me.responsible.lossLimit) + " " + esc(sym()) : "off"}</b>${me.responsible.lossLimit ? ` · lost today ${eth(me.responsible.lossToday)}` : ""}${me.responsible.pending ? `<br>Change pending: ${me.responsible.pending.lossLimit ? eth(me.responsible.pending.lossLimit) : "off"} from ${new Date(me.responsible.pending.effectiveAt).toLocaleString()}` : ""}</div>
          <form data-form="limit" class="dg-row" autocomplete="off"><input id="limitAmt" type="text" inputmode="decimal" placeholder="0.02" style="flex:1;min-width:110px"><button class="dg-btn" type="submit">Set limit</button><button class="dg-btn" type="button" data-act="limit-off">Turn off</button></form>
          <div class="dg-note">Lowering a limit applies at once. Raising or removing it takes 24 hours.</div>
          <div class="dg-row"><span class="dg-note">Cool-off (no staked play):</span><button class="dg-btn" data-act="cool" data-h="24">24 hours</button><button class="dg-btn" data-act="cool" data-h="168">7 days</button></div>
          <div class="err" id="limErr"></div>
        </div>
      </details>
    </div>`;
  },

  queue() {
    const q = S.queue, g = game(q.game);
    return `<section class="dg-box dg-stack dg-center" aria-labelledby="hq">
      <h2 class="dg-h" id="hq">Finding an opponent</h2>
      <div class="spin" aria-hidden="true"></div>
      <div class="dg-mono">${esc(g ? g.name : q.game)} · ${q.stake === "0" ? "free play" : eth(q.stake) + " " + esc(sym())}${q.code ? ` · code ${esc(q.code)}` : ""}</div>
      <div class="dg-note">Searching within ±60 rating, widening as you wait. Timeout in <span class="dg-mono" data-until="${q.expiresAt}">${left(q.expiresAt)}</span></div>
      <div><button class="dg-btn" data-act="cancel-queue" id="cancelQueue">Cancel and get my stake back</button></div>
    </section>`;
  },

  found() {
    const m = S.match, g = game(m.game.id);
    return `<section class="dg-box dg-stack" aria-labelledby="hf">
      <h2 class="dg-h dg-center" id="hf">Opponent found</h2>
      <div class="vs">
        <div class="who you"><b>${esc(S.me.displayName)}</b><span class="dg-mono dg-muted">${m.you.ratingBefore}</span></div>
        <div class="x">vs</div>
        <div class="who rival"><b>${esc(m.opponent.name)}</b><span class="dg-mono dg-muted">${m.opponent.ratingBefore}</span></div>
      </div>
      <div class="dg-center dg-mono">${esc(m.game.name)} · ${m.stake === "0" ? "free play" : `pot ${eth(m.pot)} ${esc(sym())} · winner gets ${eth(m.winnerPayout)}`}</div>
      ${g ? `<ul class="rules">${g.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      <div class="dg-center dg-note">${S.youReady ? (S.oppReady ? "Both ready. Starting…" : `Waiting for ${esc(m.opponent.name)}…`) : `Press Ready within <span class="dg-mono" data-until="${m.readyDeadline}">${left(m.readyDeadline)}</span>. The game starts a few seconds after both of you are ready.`}</div>
      <div class="err dg-center" id="err">${esc(S.error)}</div>
      <div class="dg-row" style="justify-content:center">
        <button class="dg-btn primary" data-act="ready" id="readyBtn" ${S.youReady ? "disabled" : ""}>${S.youReady ? "Waiting…" : "Ready"}</button>
        <button class="dg-btn" data-act="decline" id="declineBtn">Decline</button>
      </div>
    </section>`;
  },

  orphan() {
    const m = S.match;
    return `<section class="dg-box dg-stack dg-center">
      <h2 class="dg-h">Match in progress</h2>
      <p class="lede" style="margin-inline:auto">Your match against ${esc(m.opponent.name)} is running, but the challenge is only delivered once, to the page that pressed Ready, so it cannot be resumed here. If you play it in another tab you can ignore this. Otherwise forfeit, or the match ends by itself at the deadline.</p>
      <div class="dg-note">Deadline in <span class="dg-mono" data-until="${m.submitDeadline}">${left(m.submitDeadline)}</span></div>
      <div><button class="dg-btn danger" data-act="forfeit-now" id="forfeitNow">Forfeit this match</button></div>
    </section>`;
  },

  result() {
    const m = S.result;
    const you = m.you, opp = m.opponent;
    const label = { win: "Victory", loss: "Defeat", draw: "Draw", void: "Match cancelled" }[m.result] || m.result;
    const why = { scores: "Highest score wins.", forfeit: m.result === "win" ? "Your opponent forfeited." : "You forfeited.", timeout: m.result === "win" ? "Your opponent did not finish in time." : "You did not finish in time.",
      no_result: "Nobody submitted a result. Stakes are refunded.", no_show: "Someone did not press Ready. Stakes are refunded.", declined: "The match was declined. Stakes are refunded.", server_restart: "The server restarted. Stakes are refunded." }[m.reason] || "";
    const lab = m.game.scoreLabel;
    const delta = you.ratingAfter != null ? you.ratingAfter - you.ratingBefore : 0;
    const stake = BigInt(m.stake), got = BigInt(you.payout || 0);
    const net = m.result === "void" || m.result === "draw" ? 0n : got - stake;
    return `<section class="dg-box dg-stack" aria-labelledby="hr">
      <div class="result-head ${esc(m.result)}"><div class="big" id="hr" data-test="result">${esc(label)}</div><div class="dg-note">${esc(why)}</div></div>
      ${m.result !== "void" && (you.score != null || opp.score != null) ? `<div class="scoreline"><div class="dg-gold">You<b>${you.score == null ? "–" : esc(you.score)}</b><span class="dg-note">${esc(lab)}</span></div><div class="x dg-muted">vs</div><div class="dg-rival">${esc(opp.name)}<b>${opp.score == null ? "–" : esc(opp.score)}</b><span class="dg-note">${esc(lab)}</span></div></div>` : ""}
      <div class="bal" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
        ${stake > 0n ? `<div class="dg-stat">${net > 0n ? "You won" : net < 0n ? "You lost" : "Money"}<b class="dg-mono ${net > 0n ? "dg-good" : net < 0n ? "dg-bad" : ""}">${net > 0n ? "+" : net < 0n ? "−" : "±"}${eth(net < 0n ? -net : net)}</b></div>` : ""}
        ${m.result !== "void" ? `<div class="dg-stat">Rating<b class="dg-mono">${you.ratingAfter}${delta ? ` <span class="${delta > 0 ? "dg-good" : "dg-bad"}">(${delta > 0 ? "+" : ""}${delta})</span>` : ""}</b></div>` : ""}
      </div>
      ${m.seed != null ? `<div class="dg-note dg-mono">Seed #${esc(m.seed)}: the same challenge both players got. Match #${m.id}.</div>` : ""}
      <div class="dg-row">
        <button class="dg-btn primary" data-act="rematch" id="rematchBtn">Find another opponent</button>
        <button class="dg-btn" data-act="back" id="backBtn">Back to lobby</button>
      </div>
    </section>`;
  },
};

function pickedStake() {
  if (S.pick.stake === "0") return 0n;
  if (S.pick.stake === "custom") {
    try { return S.pick.custom.trim() ? ethers.parseEther(S.pick.custom.trim()) : null; } catch { return null; }
  }
  return BigInt(S.pick.stake);
}

/* keep the select and text inputs in sync with state after a re-render */
function syncLobbyInputs() {
  const g = $("#gameSel"); if (g) g.value = S.pick.game;
}

/* the play view builds its frame once; afterwards only small pieces are updated so the game's DOM is never rebuilt */
function renderPlay() {
  if (!$("#stage")) {
    const m = S.match;
    $("#main").innerHTML = `<section class="dg-box dg-stack">
      <div class="bar"><div><b>${esc(m.game.name)}</b> <span class="dg-note">vs ${esc(m.opponent.name)}</span></div>
        <div class="dg-mono" id="status" aria-live="off"></div>
        <div id="forfeitArea"></div></div>
      <div class="race" id="race" aria-label="Live scores">
        <div class="lane you"><span>You</span><div class="track"><div class="fill" id="fillYou"></div></div><b class="dg-mono" id="numYou">0</b></div>
        <div class="lane rival"><span>${esc(m.opponent.name)}</span><div class="track"><div class="fill" id="fillOpp"></div></div><b class="dg-mono" id="numOpp">0</b></div>
      </div>
      <div class="dg-center" id="countdown" role="timer"></div>
      <div id="stage"></div>
      <div class="dg-note" id="playNote"></div>
    </section>`;
  }
  updatePlayBar();
}

function updatePlayBar() {
  const fa = $("#forfeitArea");
  if (fa) fa.innerHTML = S.confirmForfeit
    ? `<span class="confirm"><span class="dg-note">Forfeit and lose your stake?</span><button class="dg-btn danger" data-act="forfeit-yes" id="forfeitYes">Yes, forfeit</button><button class="dg-btn" data-act="forfeit-no">Keep playing</button></span>`
    : `<button class="dg-btn danger" data-act="forfeit" id="forfeitBtn">Forfeit</button>`;
  const top = Math.max(1, S.myScore, S.oppScore);
  const set = (id, v, max) => { const el = $(id); if (el) el.style.width = Math.min(100, (v / max) * 100) + "%"; };
  set("#fillYou", S.myScore, top); set("#fillOpp", S.oppScore, top);
  const ny = $("#numYou"), no = $("#numOpp");
  if (ny) ny.textContent = S.myScore; if (no) no.textContent = S.oppScore;
  const note = $("#playNote");
  if (note) note.textContent = S.submitted ? `Result sent. Waiting for ${S.match.opponent.name} to finish…` : S.oppFinished ? `${S.match.opponent.name} has finished.` : "";
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
    const [w, wd, acts] = await Promise.all([S.client.api("GET", "/v1/wallet"), S.client.api("GET", "/v1/wallet/withdrawals"), S.client.api("GET", "/v1/matches?limit=6")]);
    S.wallet = { ...w, withdrawals: wd.withdrawals };
    S.activity = { matches: acts.matches };
  } catch (e) { S.error = e.message; }
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
  applyActive(S.me.active);
  if (TEST) window.__duel = { client, S, get ctx() { return S.handle && S.handle.ctx; } };
  render(true);
}

function signOut() {
  if (S.client) {
    S.client.api("POST", "/v1/auth/logout").catch(() => {}); // best effort: the token also expires by itself
    S.client.close();
  }
  store.del("dg.token", "sessionStorage");
  Object.assign(S, { client: null, me: null, wallet: null, activity: null, view: "signin", queue: null, match: null, result: null });
  render(true);
}

/* ------------------------------------------------------------------ live events */

function applyActive(active) {
  if (!active) {
    if (["queue", "found", "orphan"].includes(S.view)) S.view = "lobby";
    return;
  }
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
  c.on("match.found", (m) => { S.match = m.match; S.youReady = false; S.oppReady = false; S.oppScore = 0; S.myScore = 0; S.submitted = false; S.oppFinished = false; S.confirmForfeit = false; S.result = null; S.error = ""; S.view = "found"; render(true); refreshMe(); });
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
    if (left > 0) { if (cd) cd.innerHTML = `<div class="big">${Math.ceil(left / 1000)}</div><div class="dg-note">Get ready…</div>`; setTimeout(tick, 100); }
    else { if (cd) cd.innerHTML = ""; startGame(m.seed); }
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

/* ------------------------------------------------------------------ actions */

async function act(name, el) {
  const c = S.client;
  try {
    switch (name) {
      case "burner": case "injected":
        el.disabled = true; try { await signIn(name); } catch (e) { S.error = e.message; render(true); } break;
      case "logout": signOut(); break;
      case "stake": S.pick.stake = el.dataset.v; render(true); break;
      case "copy":
        try { await navigator.clipboard.writeText(S.wallet.depositAddress); toast("Address copied.", "good"); }
        catch { toast("Select the address and copy it.", ""); } break;
      case "faucet": {
        el.disabled = true;
        try {
          await http("/v1/dev/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: S.wallet.depositAddress, eth: 1 }) });
          toast("Sent 1 test ETH to your deposit address. It shows up after it confirms.", "good");
        } catch (e) { toast(e.message, "bad"); }
        el.disabled = false; break;
      }
      case "find": return find();
      case "cancel-queue": await c.leaveQueue(); break;
      case "ready": S.youReady = true; render(true); await c.ready(S.match.id); break;
      case "decline": await c.forfeit(S.match.id); break;
      case "forfeit": S.confirmForfeit = true; updatePlayBar(); break;
      case "forfeit-no": S.confirmForfeit = false; updatePlayBar(); break;
      case "forfeit-yes": case "forfeit-now": if (S.match) await c.forfeit(S.match.id); break;
      case "back": S.result = null; S.view = "lobby"; await refreshMe(); render(true); break;
      case "rematch": S.result = null; S.view = "lobby"; render(true); if (S.pick.game) return find(); break;
      case "limit-off": { const r = await c.api("PUT", "/v1/me/loss-limit", { amount: null }); toast(r.applied ? "Loss limit removed." : "Loss limit will be removed in 24 hours.", "gold"); await refreshMe(); break; }
      case "cool": await c.api("POST", "/v1/me/cool-off", { hours: Number(el.dataset.h) }); toast("Cool-off started. Staked play is off until it ends.", "gold"); await refreshMe(); break;
    }
  } catch (e) {
    S.error = e.message;
    if (["found", "lobby", "queue"].includes(S.view)) render(true);
    if (!["find"].includes(name)) toast(e.message, "bad");
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
    if (stake > 0n && !S.me.responsible.adultConfirmed) {
      if (!S.pick.adult) { S.error = "Confirm you are 18 or older to play for stakes."; return render(true); }
      await c.api("POST", "/v1/me/age", { adult: true });
      await refreshMe();
    }
    S.busy = true;
    await c.joinQueue({ game: g, stake: stake.toString(), code: S.pick.code.trim() || undefined });
  } catch (e) {
    S.busy = false;
    S.error = e.message;
    render(true);
  }
}

/* ------------------------------------------------------------------ DOM events */

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (el && !el.disabled) act(el.dataset.act, el);
});
document.addEventListener("change", (e) => {
  if (e.target.id === "gameSel") { S.pick.game = e.target.value; render(true); }
  if (e.target.id === "adult") S.pick.adult = e.target.checked;
});
document.addEventListener("input", (e) => {
  if (e.target.id === "customStake") S.pick.custom = e.target.value;
  if (e.target.id === "code") S.pick.code = e.target.value.replace(/[^A-Za-z0-9]/g, "");
});
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  const err = $(kind === "withdraw" ? "#wdErr" : "#limErr");
  err.textContent = "";
  try {
    if (kind === "withdraw") {
      const amount = ethers.parseEther(($("#wdAmt").value || "0").trim());
      const r = await S.client.api("POST", "/v1/wallet/withdraw", { amount: amount.toString() }, { "idempotency-key": crypto.randomUUID() });
      toast(`Withdrawal of ${eth(r.amount)} ${sym()} queued.`, "good");
      $("#wdAmt").value = "";
    } else {
      const amount = ethers.parseEther(($("#limitAmt").value || "0").trim());
      const r = await S.client.api("PUT", "/v1/me/loss-limit", { amount: amount.toString() });
      toast(r.applied ? "Loss limit set." : "Raising a limit takes 24 hours to apply.", "gold");
    }
    await refreshMe();
    if (S.wallet) { await refreshWallet(); render(true); }
  } catch (ex) { err.textContent = ex.message; }
});

/* countdown labels */
setInterval(() => {
  for (const el of document.querySelectorAll("[data-until]")) {
    el.textContent = left(el.dataset.until);
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
    if (S.games.length) S.pick.game = S.games.find((g) => g.id === "reaction") ? "reaction" : S.games[0].id;
  } catch (e) {
    $("#main").innerHTML = `<section class="dg-box"><h2 class="dg-h">Cannot reach the server</h2><p class="lede">${esc(e.message)}</p></section>`;
    return;
  }
  const token = store.get("dg.token", "sessionStorage");
  if (token) { try { await resume(token); return; } catch { store.del("dg.token", "sessionStorage"); } }
  render(true);
})();
