/* Lobby, Game library and the (upcoming) Tournaments page. Styles live in /play/lobby.css under the .lb- prefix.
   Invite-only: the lobby page is a compact "Create a lobby" card (game, stake, terms, button). The core `create-lobby`
   action does the creating; the host then waits in the waiting room. Everything shown is real: the player's own data,
   S.cfg, S.host, and the public /v1/lobby aggregate (S.live: online, playing, recent results). */
import { icon, avatar } from "../ui.js";
import { practiceHTML } from "./practice.js";
import { art, artBg } from "../gameart.js";

export const FAV_KEY = "dg.favs";

/* ------------------------------------------------------------------ small helpers */

export function readFavs() {
  try {
    const a = JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
    return Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}
export const catLabel = (c) => (c ? c[0].toUpperCase() + c.slice(1) : "");
/* "90 s", "250 ms", "3 min" never split across lines */
export const nbUnits = (t) => String(t || "").replace(/(\d) (?=(?:s|ms|min)\b)/g, "$1\u00a0");

export function ratingFor(S, id) {
  const r = S.me && Array.isArray(S.me.ratings) ? S.me.ratings.find((x) => x.game === id) : null;
  return r || null;
}

/* the stake the player currently has picked */
export function stakeInfo(ctx) {
  const { S } = ctx, cfg = S.cfg;
  const wei = ctx.pickedStake();
  const pot = wei == null ? null : wei * 2n;
  const fee = pot == null ? null : (pot * BigInt(cfg.feeBps || 0)) / 10000n;
  const payout = pot == null ? null : pot - fee;
  const outOfRange = wei != null && wei > 0n && (wei < BigInt(cfg.stake.min) || wei > BigInt(cfg.stake.max));
  return { wei, pot, fee, payout, outOfRange };
}

/* the games shown in the picker: filtered by category, favourites first */
function pickerGames(S) {
  const favs = readFavs(), cat = S.ui.lbPickCat || "all";
  const list = S.games.filter((g) => cat === "all" || g.category === cat);
  return list.map((g, i) => ({ g, i })).sort((a, b) => (favs.includes(b.g.id) - favs.includes(a.g.id)) || (a.i - b.i)).map((x) => x.g);
}

/* ------------------------------------------------------------------ create card (each piece returns an html string) */

/* the game's art as a faded thumbnail inside a picker tile. A <span> (not artBg's <div>) because a <button> only holds
   phrasing content; same .gart base styles. No art for the id: no layer, the tile just looks as before. */
function tileArt(id) {
  const a = art(id);
  return a ? `<span class="gart lb-tile-art" style="--ga:${a.accent}" aria-hidden="true">${a.svg}</span>` : "";
}

function tile(ctx, g) {
  const { S, h } = ctx;
  return `<button type="button" class="lb-tile" data-act="lb-pick" data-game="${h.esc(g.id)}" aria-pressed="${S.pick.game === g.id}">
    ${tileArt(g.id)}
    <b class="lb-tile-name">${h.esc(g.name)}</b>
    <span class="lb-tile-cat">${h.esc(catLabel(g.category))}${g.duration ? ` · ${h.esc(g.duration.replace(/\s*\(.*\)/, ""))}` : ""}</span>
  </button>`;
}

function pickerHTML(ctx) {
  const { S, h } = ctx;
  const cats = [...new Set(S.games.map((g) => g.category))].sort();
  const cur = S.ui.lbPickCat || "all";
  const chip = (v, label) => `<button type="button" class="lb-cat" data-act="lb-pickcat" data-cat="${h.esc(v)}" aria-pressed="${cur === v}">${h.esc(label)}</button>`;
  return `<div class="lb-pickhead">
      <div class="lb-cats" role="group" aria-label="Game category">${chip("all", "All")}${cats.map((c) => chip(c, catLabel(c))).join("")}</div>
    </div>
    <div class="lb-tiles-wrap at-start">
      <div class="lb-tiles" role="group" aria-label="Game">${pickerGames(S).map((g) => tile(ctx, g)).join("")}</div>
      <button type="button" class="lb-tnav prev" data-act="lb-tscroll" data-dir="-1" aria-label="Show previous games" tabindex="-1">${icon("arrow")}</button>
      <button type="button" class="lb-tnav next" data-act="lb-tscroll" data-dir="1" aria-label="Show more games" tabindex="-1">${icon("arrow")}</button>
    </div>`;
}

function selectedHTML(ctx) {
  const { S, h } = ctx; const { esc } = h;
  const g = h.game(S.pick.game);
  if (!g) return `<div class="lb-sel lb-sel-empty">Choose a game above to see how it plays.</div>`;
  const r = ratingFor(S, g.id), open = !!S.ui.lbHow;
  const line = `<p class="lb-sel-line"><b class="lb-sel-name">${esc(g.name)}</b><span class="lb-sel-meta">${r ? `Your rating <b class="dg-mono">${r.rating}</b>` : "Unrated"}</span></p>`;
  const toggle = `<button type="button" class="lb-how" id="lbHowBtn" data-act="lb-how" aria-expanded="${open}" aria-controls="lbHowPanel">${open ? "Show less" : "How to play"}</button>`;
  if (!open) return `<div class="lb-sel">
    <div class="lb-sel-l">${line}<p class="lb-sel-blurb">${esc(nbUnits(g.blurb))}</p></div>
    <div class="lb-sel-r">
      <div class="lb-meters">${h.meter("Skill", g.skill, "skill")}${h.meter("Luck", g.luck, "luck")}</div>
      ${toggle}
    </div>
  </div>`;
  const fact = (k, v) => (v ? `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>` : "");
  return `<div class="lb-sel lb-sel-open">
    <div class="lb-sel-top">${line}${toggle}</div>
    <div class="lb-howp" id="lbHowPanel">
      <p class="lb-howp-blurb">${esc(nbUnits(g.blurb))}</p>
      <dl class="lb-facts">${fact("Category", catLabel(g.category))}${fact("Length", g.duration && g.duration.replace(/\s*\(.*\)/, ""))}${fact("Scored by", g.scoreLabel && catLabel(g.scoreLabel))}</dl>
      <div class="lb-meters">${h.meter("Skill", g.skill, "skill")}${h.meter("Luck", g.luck, "luck")}</div>
      <h4 class="lb-howp-h">How to play</h4>
      <ol class="lb-howp-rules">${(g.rules || []).map((x) => `<li>${esc(nbUnits(x))}</li>`).join("")}</ol>
      <p class="lb-hint">Both players get the exact same seeded challenge, so the better play wins.</p>
      <div class="lb-howp-act">
        <button type="button" class="lb-btn gold" data-act="try-game" data-game="${esc(g.id)}" id="tryBtn">${icon("bolt")}Try out</button>
        <span class="lb-hint">Practice against a bot in the Games tab. Free, no stake, no rating.</span>
      </div>
    </div>
  </div>`;
}

export function stakeChips(ctx) {
  const { S, h } = ctx;
  const cur = S.pick.stake;
  const c = (v, label) => `<button type="button" class="lb-chip" data-act="stake" data-v="${v}" aria-pressed="${cur === v}">${label}</button>`;
  return c("0", "Free") + S.cfg.stake.tiers.map((t) => c(t, `<span class="dg-mono">${h.eth(t)}</span>`)).join("") + c("custom", "Custom");
}

/* the terms, one tight line */
export function calcHTML(ctx) {
  const { S, h } = ctx; const { eth, sym } = h;
  const si = stakeInfo(ctx), cfg = S.cfg;
  if (S.pick.stake === "0") return `<p class="lb-terms">Free play · no money moves · still rated</p>`;
  if (si.wei == null) return `<p class="lb-terms">Enter a stake between ${eth(cfg.stake.min)} and ${eth(cfg.stake.max)} ${h.esc(sym())}</p>`;
  return `<p class="lb-terms">Pot <b class="dg-mono">${eth(si.pot)}</b> · winner gets <b class="dg-mono win">${eth(si.payout)} ${h.esc(sym())}</b> · ${cfg.feeBps / 100}% fee · test network, no real money${si.outOfRange ? ` <span class="lb-warn">Stakes run from ${eth(cfg.stake.min)} to ${eth(cfg.stake.max)}.</span>` : ""}</p>`;
}

export function noticesHTML(ctx) {
  const { S, h } = ctx; const me = S.me;
  const banned = me.queueBanUntil, now = h.now();
  let out = "";
  if (banned && Number(banned) > now) out += `<div class="lb-note bad" role="status">You skipped several matches. You can start again at ${h.esc(new Date(banned).toLocaleTimeString())}.</div>`;
  return out;
}

function hero(ctx) {
  const { S, h } = ctx; const { esc } = h;
  const me = S.me, now = h.now();
  const banned = me.queueBanUntil && Number(me.queueBanUntil) > now;
  const hasOpen = !!S.host;
  const blocked = banned;
  return `<section class="lb-card lb-hero" id="lbCreate" tabindex="-1" aria-labelledby="lbHero">
    <header class="lb-hero-head">
      <div><h2 class="lb-title" id="lbHero">Create a lobby</h2>
        <ol class="lb-steps" aria-label="How it works"><li><b>1</b>Create</li><li><b>2</b>Send the link</li><li><b>3</b>Play</li></ol></div>
      <button type="button" class="lb-surprise" data-act="lb-surprise">${icon("dice")}<span>Surprise me</span></button>
    </header>
    <div id="lbPicker">${pickerHTML(ctx)}</div>
    <div id="lbSelected">${selectedHTML(ctx)}</div>
    <div class="lb-stakerow"><span class="lb-stakel" id="lbStakeL">Stake <small>${esc(h.sym())} · test network</small></span>
      <div class="lb-chips" role="group" aria-labelledby="lbStakeL">${stakeChips(ctx)}</div></div>
    ${S.pick.stake === "custom" ? `<div class="lb-custom"><label for="customStake">Custom stake in ${esc(h.sym())} (${h.eth(S.cfg.stake.min)} to ${h.eth(S.cfg.stake.max)})</label><input id="customStake" type="text" inputmode="decimal" value="${esc(S.pick.custom)}" placeholder="0.002" autocomplete="off"></div>` : ""}
    <div id="lbCalc" aria-live="polite">${calcHTML(ctx)}</div>
    ${noticesHTML(ctx)}
    <div class="lb-err err" id="err" role="alert">${esc(S.error)}</div>
    <div class="lb-go">
      <button class="lb-find" data-act="create-lobby" id="createBtn" ${S.busy || blocked || hasOpen ? "disabled" : ""}>
        <span class="lb-find-t"><b>Create lobby</b></span>${icon("arrow")}</button>
      ${hasOpen ? `<p class="lb-go-note" role="status">You already have an open lobby. Cancel it below to make a new one.</p>` : ""}
      ${hasOpen ? `<button type="button" class="lb-cancel" id="cancelBtn" data-act="close-lobby" ${S.busy ? "disabled" : ""}>Cancel open lobby and refund my stake</button>` : ""}
    </div>
  </section>`;
}

/* the host's open lobby (S.host) */
export function openLobbyCard(ctx) {
  const { S, h } = ctx; const { esc } = h;
  const L = S.host;
  if (!L) return "";
  const stake = L.stake === "0" ? "Free play" : `${h.eth(L.stake)} ${esc(h.sym())} stake`;
  return `<section class="lb-card lb-open" aria-labelledby="lbOpen">
    <div class="lb-open-in">
      <span class="lb-pulse" aria-hidden="true"></span>
      <div class="lb-open-t"><p class="lb-eyebrow">Your open lobby</p>
        <h3 id="lbOpen">${esc((L.game && L.game.name) || "Game")} <span>· ${stake}</span></h3>
        <p class="lb-open-sub">Waiting for a friend to join. Expires in <b class="dg-mono" data-until="${Number(L.expiresAt) || 0}">${h.left(Number(L.expiresAt) || 0)}</b></p></div>
      <button type="button" class="lb-btn gold" data-act="go-waiting">Show invite link${icon("arrow")}</button>
    </div>
  </section>`;
}

/* The Join page (top bar → Join): enter a friend's 8-character code, or paste their whole invite link. */
const JOIN_STEPS = [
  ["1", "Get the code", "It is on your friend's waiting screen, under the invite link. They can read it out or send it."],
  ["2", "Check the terms", "You see the game, the stake and who invited you before anything is charged."],
  ["3", "Play the same challenge", "You both get the exact same seeded game at the same time. Higher score takes the pot."],
];
function joinPage(ctx) {
  const { S, h } = ctx; const { esc } = h;
  const inv = S.invite && S.invite.lobby && S.invite.lobby.state === "open" ? S.invite : null;
  const pending = inv ? `<section class="lb-card jn-note" aria-labelledby="jnPend">
      <div class="jn-note-in"><span class="lb-pulse" aria-hidden="true"></span>
        <div><b id="jnPend">${esc(inv.lobby.host.name)} invited you to ${esc(inv.lobby.game.name)}</b><span class="lb-hint">That invite is still open.</span></div>
        <button type="button" class="lb-btn gold" data-act="open-invite">Open invite${icon("arrow")}</button></div></section>` : "";
  const hosting = S.host ? `<section class="lb-card jn-note warn" role="status">
      <div class="jn-note-in"><div><b>You have an open lobby</b><span class="lb-hint">Close it before you join someone else's game.</span></div>
        <button type="button" class="lb-btn" data-act="go-waiting">Show my lobby${icon("arrow")}</button></div></section>` : "";
  return `<div class="jn-page">
    ${pending}${hosting}
    <section class="lb-card jn-card" aria-labelledby="jnTitle">
      <p class="lb-eyebrow">Join a game</p>
      <h2 class="lb-title" id="jnTitle">Enter an invite code</h2>
      <p class="lb-muted">Type the code your friend gave you, or paste their whole invite link.</p>
      <div class="jn-row">
        <label class="sr-only" for="joinCode">Invite code or link</label>
        <input id="joinCode" type="text" maxlength="200" placeholder="ABCD2345" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" aria-describedby="jnHint jnErr">
        <button type="button" class="lb-btn gold jn-go" data-act="lb-join-code" id="joinGo">Join${icon("arrow")}</button>
      </div>
      <p class="jn-err" id="jnErr" role="alert" aria-live="polite"></p>
      <p class="lb-hint" id="jnHint">8 letters and numbers. Joining moves no money until you confirm the stake.</p>
    </section>
    <section class="lb-card jn-how" aria-labelledby="jnHow">
      <h3 class="jn-h" id="jnHow">How joining works</h3>
      <ol class="jn-steps">${JOIN_STEPS.map(([n, t, d]) => `<li><span class="jn-n">${n}</span><div><b>${esc(t)}</b><p class="lb-hint">${esc(d)}</p></div></li>`).join("")}</ol>
    </section>
  </div>`;
}

/* ---- rail */

function walletCard(ctx) {
  const { S, h } = ctx; const { eth, sym, esc } = h;
  const b = S.me.balances;
  return `<section class="lb-card lb-wallet" aria-labelledby="lbWallet">
    <header class="lb-card-head"><h3 id="lbWallet">${icon("wallet")}Wallet</h3><span class="lb-chip-s">Test ${esc(sym())}</span></header>
    <div class="lb-bal"><span class="lb-bal-l">Available</span><b class="dg-mono" id="balAvail">${eth(b.available)}</b></div>
    <div class="lb-bal-sub"><span>In play <b class="dg-mono">${eth(b.inPlay)}</b></span>${BigInt(b.pendingWithdrawal || 0) > 0n ? `<span>Withdrawing <b class="dg-mono">${eth(b.pendingWithdrawal)}</b></span>` : ""}</div>
    <div class="lb-row">${S.cfg.devFaucet ? `<button type="button" class="lb-btn gold" data-act="faucet" data-eth="1" id="faucetBtn"${S.depositing ? " disabled" : ""}>${icon("plus")}${S.depositing ? "Depositing…" : `Deposit 1 test ${esc(sym())}`}</button>` : ""}<button type="button" class="lb-btn" data-go="wallet">Deposit and withdraw</button></div>
  </section>`;
}

function formCard(ctx) {
  const { S, h } = ctx; const { esc, eth } = h;
  const ms = S.activity && Array.isArray(S.activity.matches) ? S.activity.matches : [];
  let streak = "";
  if (ms.length) {
    const first = ms[0].result;
    let n = 0; for (const m of ms) { if (m.result === first) n++; else break; }
    if ((first === "win" || first === "loss") && n >= 2) streak = `<span class="lb-streak ${first}">${n} ${first === "win" ? "wins" : "losses"} in a row</span>`;
  }
  const letter = (r) => (r === "win" ? "W" : r === "loss" ? "L" : r === "draw" ? "D" : "–");
  const pills = ms.map((m) => `<span class="lb-pill ${esc(m.result)}" title="${esc(m.game.name)} vs ${esc(m.opponent.name)}: ${esc(m.result)}">${letter(m.result)}</span>`).join("");
  const rows = ms.slice(0, 4).map((m) => {
    const staked = m.stake !== "0";
    const delta = !staked ? "free" : m.result === "win" ? "+" + eth(BigInt(m.you.payout) - BigInt(m.stake)) : m.result === "loss" ? "−" + eth(m.stake) : "±0";
    return `<li><span class="lb-form-vs">${esc(m.game.name)} <em>vs ${esc(m.opponent.name)}</em></span><span class="dg-mono lb-d ${esc(m.result)}">${esc(delta)}</span></li>`;
  }).join("");
  return `<section class="lb-card lb-form" aria-labelledby="lbForm">
    <header class="lb-card-head"><h3 id="lbForm">Your form</h3><button type="button" class="lb-link-btn" data-go="history">History ${icon("arrow")}</button></header>
    ${ms.length ? `<div class="lb-pills" aria-label="Last ${ms.length} results, newest first">${pills}${streak}</div><ul class="lb-form-list">${rows}</ul>` : `<p class="lb-empty sm">No matches yet. Your results will show up here.</p>`}
  </section>`;
}

/* leaderboard card: hidden for now (not placed in the rail, and its rows are not fetched in mount) */
function boardCard(ctx) {
  const { S, h } = ctx; const { esc } = h;
  const g = h.game(S.pick.game);
  if (!g) return "";
  const rows = S.boards[g.id];
  const body = rows === undefined ? `<p class="lb-empty sm">Loading…</p>`
    : !rows.length ? `<p class="lb-empty sm">Nobody is ranked in ${esc(g.name)} yet. Play a match to be the first.</p>`
    : `<ol class="lb-top">${rows.slice(0, 3).map((r) => {
      const nm = (r.player && (r.player.name || r.player.displayName)) || "Player";
      const you = nm === S.me.displayName;
      return `<li class="${you ? "you" : ""}"><span class="lb-rank r${r.rank}">${r.rank}</span>${avatar(nm, 28)}<span class="lb-top-name">${esc(nm)}${you ? " <em>you</em>" : ""}</span><b class="dg-mono">${r.rating}</b></li>`;
    }).join("")}</ol>`;
  return `<section class="lb-card lb-board" aria-labelledby="lbBoard">
    <header class="lb-card-head"><h3 id="lbBoard">${icon("trophy")}Top in ${esc(g.name)}</h3><button type="button" class="lb-link-btn" data-go="leaderboard">All ${icon("arrow")}</button></header>
    ${body}
  </section>`;
}

function playCard(ctx) {
  const { S, h } = ctx; const { eth, sym, esc } = h;
  const r = S.me.responsible;
  const limit = r.lossLimit ? `Daily loss limit ${eth(r.lossLimit)} ${esc(sym())}, lost today ${eth(r.lossToday)}` : "No daily loss limit set";
  return `<section class="lb-card lb-play" aria-label="Account limits">
    <div class="lb-play-in">${icon("shield")}<p><b>Play within your limits.</b> ${limit}.</p></div>
    <button type="button" class="lb-link-btn" data-go="settings">Manage limits ${icon("arrow")}</button>
  </section>`;
}

/* ------------------------------------------------------------------ game library */

function cardHTML(ctx, g, favs) {
  const { S, h } = ctx; const { esc } = h;
  const fav = favs.includes(g.id), r = ratingFor(S, g.id); 
  /* the whole card opens the game page: the "Check out" link stretches over it (lobby.css), the star sits above */
  return `<article class="lb-card lb-gcard" data-game="${esc(g.id)}">
    ${artBg(g.id, "lb-gart")}
    <div class="lb-gcard-top"><span class="lb-eyebrow">${esc(catLabel(g.category))}${g.duration ? ` · ${esc(g.duration.replace(/\s*\(.*\)/, ""))}` : ""}</span>
      <button type="button" class="lb-fav" data-act="lb-fav" data-game="${esc(g.id)}" aria-pressed="${fav}" aria-label="${fav ? "Remove " : "Add "}${esc(g.name)} ${fav ? "from" : "to"} favourites">${icon("star")}</button></div>
    <h3 class="lb-gname">${esc(g.name)}</h3>
    <p class="lb-gblurb">${esc(nbUnits(g.blurb))}</p>
    <div class="lb-meters">${h.meter("Skill", g.skill, "skill")}${h.meter("Luck", g.luck, "luck")}</div>
    <div class="lb-gmeta">${r ? `<span>Your rating <b class="dg-mono">${r.rating}</b></span>` : `<span>Unrated</span>`}</div>
    <a class="lb-duel lb-gcard-link" href="#game/${esc(g.id)}" data-go="game" data-arg="${esc(g.id)}">Check out<span class="sr-only"> ${esc(g.name)}</span> ${icon("arrow")}</a>
  </article>`;
}
function filteredGames(S) {
  const q = (S.ui.lbq || "").trim().toLowerCase(), cat = S.ui.lbcat || "all", favs = readFavs();
  return S.games.filter((g) => {
    if (cat === "favs" && !favs.includes(g.id)) return false;
    if (cat !== "all" && cat !== "favs" && g.category !== cat) return false;
    return !q || `${g.name} ${g.blurb} ${g.category}`.toLowerCase().includes(q);
  });
}
function gridHTML(ctx) {
  const favs = readFavs(), list = filteredGames(ctx.S);
  if (!list.length) return `<p class="lb-empty">${(ctx.S.ui.lbcat === "favs" && !favs.length) ? "No favourites yet. Tap the star on a game to keep it here." : "No games match your search."}</p>`;
  return list.map((g) => cardHTML(ctx, g, favs)).join("");
}

/* ------------------------------------------------------------------ views */

export const views = {
  lobby(ctx) {
    return `<div class="lb-page">
      <div class="lb-main">${openLobbyCard(ctx)}${hero(ctx)}</div>
      <aside class="lb-rail" aria-label="Your account">${walletCard(ctx)}${formCard(ctx)}${playCard(ctx)}</aside>
    </div>`;
  },

  join(ctx) { return joinPage(ctx); },

  /* Tournaments are not built yet: an honest "upcoming" page, no invented dates, entrants or prizes */
  tournaments() {
    const fmt = (ico, name, meta, text) => `<article class="lb-card lb-tour-card">
      <header class="lb-tour-top"><span class="lb-tour-ico">${icon(ico)}</span><span class="lb-soon">Coming soon</span></header>
      <h3>${name}</h3><p class="lb-tour-meta">${meta}</p><p class="lb-muted">${text}</p>
    </article>`;
    return `<div class="lb-tour">
      <section class="lb-card lb-tour-hero" aria-labelledby="lbTour">
        <p class="lb-eyebrow">Upcoming</p>
        <h2 class="lb-title" id="lbTour">Tournaments</h2>
        <p class="lb-muted">Tournaments for groups of friends are on the way. One person sets it up, shares a single invite link, and everyone who joins plays the same seeded rounds until one winner is left.</p>
      </section>
      <div class="lb-tour-grid">
        ${fmt("trophy", "Friends bracket", "4 or 8 players · single elimination", "Everyone joins through one link. Each round is a duel on the same challenge, and the winner moves on to the next round.")}
        ${fmt("dice", "Duel Mix", "1 opponent · 3 different games", "Three short games from different categories against the same friend. A round win is worth 3 points, a draw 1.")}
        ${fmt("users", "Free-for-all", "Up to 8 players · one game", "The whole group plays the same challenge at the same time. Highest score takes first place.")}
      </div>
      <section class="lb-card lb-tour-cta">
        <p class="lb-muted">Until then, challenge one friend at a time.</p>
        <button type="button" class="lb-btn gold" data-go="lobby">Create a lobby${icon("arrow")}</button>
      </section>
    </div>`;
  },

  games(ctx) {
    const { S, h } = ctx; const { esc } = h;
    if (S.practice) return `<div class="lb-lib">${practiceHTML(ctx)}</div>`;
    const cats = [...new Set(S.games.map((g) => g.category))].sort();
    const cur = S.ui.lbcat || "all", favs = readFavs();
    const chip = (v, label) => `<button type="button" class="lb-cat" data-act="lb-gcat" data-cat="${esc(v)}" aria-pressed="${cur === v}">${label}</button>`;
    return `<div class="lb-lib">
      <header class="lb-lib-head">
        <div><p class="lb-eyebrow">${S.games.length} games · pick one, then invite a friend</p><h2 class="lb-title">Game library</h2></div>
        <div class="lb-search">${icon("search")}<label class="lb-sr" for="lbSearch">Search games</label><input id="lbSearch" type="search" placeholder="Search games" value="${esc(S.ui.lbq || "")}" autocomplete="off"></div>
      </header>
      <div class="lb-cats" role="group" aria-label="Category">${chip("all", "All")}${chip("favs", `${icon("star")}Favourites${favs.length ? ` <span class="dg-mono">${favs.length}</span>` : ""}`)}${cats.map((c) => chip(c, esc(catLabel(c)))).join("")}</div>
      <div class="lb-grid" id="lbGrid">${gridHTML(ctx)}</div>
    </div>`;
  },
};

/* ------------------------------------------------------------------ actions */

/* remember the picker's horizontal scroll across the re-render a pick causes */
function keepScroll(el, S) { const t = el.closest(".lb-tiles"); if (t) S.ui.lbScroll = t.scrollLeft; }

export const actions = {
  "lb-how"(el, app) {
    const { S, ctx } = app;
    S.ui.lbHow = !S.ui.lbHow;
    const box = document.querySelector("#lbSelected");
    if (!box) return app.render(true);
    box.innerHTML = selectedHTML(ctx);
    const b = document.querySelector("#lbHowBtn"); if (b) b.focus();
  },
  /* page the game tiles sideways (the native scrollbar is hidden; swipe and trackpad still scroll) */
  "lb-tscroll"(el) {
    const t = el.closest(".lb-tiles-wrap") && el.closest(".lb-tiles-wrap").querySelector(".lb-tiles");
    if (t) t.scrollBy({ left: Number(el.dataset.dir) * Math.max(160, t.clientWidth * 0.8), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  },
  "lb-pick"(el, app) { keepScroll(el, app.S); app.S.pick.game = el.dataset.game; app.render(true); },
  "lb-pickcat"(el, app) { app.S.ui.lbPickCat = el.dataset.cat; app.S.ui.lbScroll = 0; app.render(true); },
  "lb-surprise"(el, app) {
    const S = app.S;
    const pool = pickerGames(S).filter((g) => g.id !== S.pick.game);
    const list = pool.length ? pool : S.games;
    if (!list.length) return;
    S.pick.game = list[Math.floor(Math.random() * list.length)].id;
    S.ui.lbScroll = undefined; // re-centre on the new pick
    app.render(true);
  },
  "go-waiting"(el, app) { app.S.view = "waiting"; app.render(true); },
  /* a friend read the code out: go to the invite screen (it signs in first if needed) */
  "lb-join-code"(el, app) { joinByCode(app); },
  "lb-gcat"(el, app) { app.S.ui.lbcat = el.dataset.cat; app.render(true); },
  "lb-fav"(el, app) {
    const id = el.dataset.game, f = readFavs();
    const next = f.includes(id) ? f.filter((x) => x !== id) : [...f, id];
    app.store.set(FAV_KEY, JSON.stringify(next));
    app.render(true);
  },
};

/* the code, from a typed code or a pasted invite link (…/play/?join=CODE) */
export function codeFrom(text) {
  const t = String(text || "").trim();
  const m = t.match(/[?&]join=([A-Za-z0-9]+)/);
  return (m ? m[1] : t).replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}
function joinByCode(app) {
  const inp = document.querySelector("#joinCode"), err = document.querySelector("#jnErr");
  const code = codeFrom(inp && inp.value);
  if (code.length !== 8) {
    const msg = code ? `Invite codes are 8 characters. That one has ${code.length}.` : "Enter the 8-character code from your friend.";
    if (err) err.textContent = msg; else app.toast(msg, "bad");
    if (inp) { inp.setAttribute("aria-invalid", "true"); inp.focus(); }
    return;
  }
  location.assign(`/play/?join=${encodeURIComponent(code)}`);
}

/* module-level listener: Enter in the code field joins */
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target && e.target.id === "joinCode") { e.preventDefault(); e.target.nextElementSibling && e.target.nextElementSibling.click(); }
});

/* ------------------------------------------------------------------ hooks */

export function mount(name, app) {
  const { S } = app;
  if (name !== "lobby") return;
  const sc = document.querySelector(".lb-tiles");
  if (sc) {
    const sel = sc.querySelector("[aria-pressed=true]");
    if (S.ui.lbScroll != null) sc.scrollLeft = S.ui.lbScroll;
    /* the pick lands fully in view, clear of the arrows (44px = the tiles' scroll-padding in lobby.css), on a snap point */
    else if (sel) sc.scrollLeft = sel.offsetLeft + sel.offsetWidth <= sc.clientWidth - 44 ? 0 : sel.offsetLeft - 44;
    /* fade and arrows only on the side where more games are hidden */
    const wrap = sc.parentElement, edges = () => {
      const max = sc.scrollWidth - sc.clientWidth;
      wrap.classList.toggle("at-start", sc.scrollLeft <= 2);
      wrap.classList.toggle("at-end", sc.scrollLeft >= max - 2);
      S.ui.lbScroll = sc.scrollLeft;
    };
    sc.addEventListener("scroll", edges, { passive: true });
    edges();
  }
  if (S.ui.lbFocus) {
    S.ui.lbFocus = false;
    const card = document.querySelector("#lbCreate");
    if (card) { card.focus({ preventScroll: true }); card.scrollIntoView({ block: "start" }); }
  }
}

export function onInput(e, app) {
  const { S, ctx } = app, id = e.target.id;
  if (id === "customStake") {
    S.pick.custom = e.target.value;
    const c = document.querySelector("#lbCalc");
    if (c) c.innerHTML = calcHTML(ctx);
  } else if (id === "joinCode") {
    /* keep only the code: a pasted invite link becomes its 8-character code straight away */
    const v = codeFrom(e.target.value).slice(0, 8);
    if (v !== e.target.value) e.target.value = v;
    e.target.removeAttribute("aria-invalid");
    const err = document.querySelector("#jnErr"); if (err) err.textContent = "";
    return true;
  } else if (id === "lbSearch") {
    S.ui.lbq = e.target.value;
    const g = document.querySelector("#lbGrid");
    if (g) g.innerHTML = gridHTML(ctx);
    return true;
  }
  return false; // core also stores these values
}
