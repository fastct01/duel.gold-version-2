/* Lobby, Game library and the (upcoming) Tournaments page. Styles live in /play/lobby.css under the .lb- prefix.
   Invite-only: the lobby page is a compact "Create a lobby" card (game, stake, terms, button). The core `create-lobby`
   action does the creating; the host then waits in the waiting room. Everything shown is real: the player's own data,
   S.cfg and S.lobby (the lobby the player is in, as host or guest; S.host is the same lobby while they host it). Nothing about other
   players is public: no online counts, no queue, no search. A lobby holds 2 to 10 players. */
import { icon } from "../ui.js";
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

/* ------------------------------------------------------------------ game picker: a 3D "coverflow" carousel
   The cards are the games of the chosen category (favourites first); the centre card is S.pick.game. Choosing a game moves the
   cards in place: each card's position is three custom properties (--o offset, --a its size, --sg its side) that carousel.css turns
   into a transform, so nothing is re-rendered and the move animates. All cards stay in the DOM; only those within CV_SHOWN places
   of the centre are visible. Styles: /play/carousel.css (.cv- prefix). */

const CV_MAX = 3;   // offsets are clamped to ±3, so cards further away wait just off stage
const CV_SHOWN = 2; // cards this many places or fewer from the centre are visible
const pad2 = (n) => String(n).padStart(2, "0");
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const shortDur = (g) => (g && g.duration ? nbUnits(g.duration.replace(/\s*\(.*\)/, "")) : "");

/* the games in the carousel: filtered by category, favourites first. The order is kept for the visit (S.ui.lbOrder), so starring
   a game while browsing never shuffles the cards under the player's hands; it is rebuilt when the category changes or the page is left. */
function pickerGames(S) {
  const cat = S.ui.lbPickCat || "all", byId = new Map(S.games.map((g) => [g.id, g]));
  const ids = S.games.filter((g) => cat === "all" || g.category === cat).map((g) => g.id);
  const o = S.ui.lbOrder;
  if (o && o.cat === cat && o.ids.length === ids.length && o.ids.every((id) => byId.has(id) && ids.includes(id))) return o.ids.map((id) => byId.get(id));
  const favs = readFavs();
  const sorted = ids.map((id, i) => ({ id, i })).sort((a, b) => (favs.includes(b.id) - favs.includes(a.id)) || (a.i - b.i)).map((x) => x.id);
  S.ui.lbOrder = { cat, ids: sorted };
  return sorted.map((id) => byId.get(id));
}

/* the picked game must be one of the cards: a game chosen elsewhere (its own page, practice, a rematch) resets the category to All */
function normPick(S) {
  let list = pickerGames(S);
  if (list.length && !list.some((g) => g.id === S.pick.game)) {
    if ((S.ui.lbPickCat || "all") !== "all" && S.games.some((g) => g.id === S.pick.game)) { S.ui.lbPickCat = "all"; S.ui.lbOrder = null; list = pickerGames(S); }
    else S.pick.game = list[0].id;
  }
  return list;
}

/* place of card i relative to the centre card `sel`, going the short way round the ring (a tie goes to the right) */
const offsetOf = (i, sel, n) => { const d = (i - sel + n) % n; return d <= n / 2 ? d : d - n; };
const posStyle = (o) => { const c = Math.max(-CV_MAX, Math.min(CV_MAX, o)); return `--o:${c};--a:${Math.abs(c)};--sg:${Math.sign(c)}`; };

/* "Reaction Duel" → ["Reaction", "Duel"]: two lines of about the same length (one word stays one line) */
function titleLines(name) {
  const w = String(name || "").trim().split(/\s+/);
  if (w.length < 2) return [w[0] || ""];
  let best = 1, bd = Infinity;
  for (let i = 1; i < w.length; i++) { const d = Math.abs(w.slice(0, i).join(" ").length - w.slice(i).join(" ").length); if (d < bd) { bd = d; best = i; } }
  return [w.slice(0, best).join(" "), w.slice(best).join(" ")];
}

const CHEV2 = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6l-6 6 6 6M19 6l-6 6 6 6"/></svg>`;
const QMARK = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.2 9.3a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.3-2.8 4.2"/><path d="M12 18.2v.1"/></svg>`;

/* the backdrop: engraved orbit lines and the floor ring. Decorative only; no glow, no sparkles (gold-style rules). */
const CV_DECOR = `<div class="cv-bg" aria-hidden="true">
    <svg class="cv-orbits" viewBox="0 0 1200 700" preserveAspectRatio="xMidYMid slice" focusable="false"><g fill="none">
      <ellipse class="o1" cx="600" cy="440" rx="585" ry="150" transform="rotate(-4 600 440)"/>
      <ellipse class="o2" cx="600" cy="350" rx="500" ry="300" transform="rotate(-17 600 350)"/>
      <ellipse class="o3" cx="600" cy="330" rx="690" ry="235" transform="rotate(11 600 330)"/>
      <ellipse class="o4" cx="600" cy="300" rx="330" ry="285" transform="rotate(24 600 300)"/>
    </g></svg>
    <span class="cv-floor"></span>
  </div>`;

/* one card: a full-card button (choose this game) with the picture, names and controls laid over it. The controls (the circled +,
   Play this game, favourite, How to play) belong to the centre card only; carousel.css hides them on the others. */
function cardTpl(ctx, g, i, n, sel, favs) {
  const { S, h } = ctx; const { esc } = h;
  const o = offsetOf(i, sel, n), a = art(g.id), fav = favs.includes(g.id), name = esc(g.name), how = !!S.ui.lbHow;
  const sub = a ? a.tagline : [catLabel(g.category), shortDur(g)].filter(Boolean).join(" · ");
  const lines = titleLines(g.name).map((l) => `<span>${esc(l)}</span>`).join("");
  return `<div class="cv-card" data-game="${esc(g.id)}"${o === 0 ? " data-c" : ""}${Math.abs(o) > CV_SHOWN ? " data-far" : ""} style="${posStyle(o)}">
    <button type="button" class="cv-hit" data-act="lb-pick" data-game="${esc(g.id)}" aria-pressed="${o === 0}" aria-label="${name}, game ${i + 1} of ${n}" tabindex="${o === 0 ? 0 : -1}"></button>
    <div class="cv-top">
      <span class="cv-idx" aria-hidden="true">[ ${pad2(i + 1)} ]</span>
      <span class="cv-name" aria-hidden="true">${name}</span>
      <button type="button" class="cv-plus cv-ctl" data-act="lb-how" aria-expanded="${how}" aria-controls="lbHowPanel" aria-label="How to play ${name}">${icon("plus")}</button>
    </div>
    <div class="cv-art" aria-hidden="true">${a ? artBg(g.id, "gart-card") : ""}</div>
    <div class="cv-foot">
      <div class="cv-acts cv-ctl">
        <button type="button" class="cv-play" data-act="lb-play"><span>Play<span class="cv-play-x">&nbsp;this&nbsp;game</span></span><i aria-hidden="true">${icon("arrow")}</i></button>
        <button type="button" class="cv-rb cv-fav" data-act="lb-fav" data-game="${esc(g.id)}" aria-pressed="${fav}" aria-label="${fav ? "Remove " : "Add "}${name} ${fav ? "from" : "to"} favourites">${icon("star")}</button>
        <button type="button" class="cv-rb cv-info" data-act="lb-how" aria-expanded="${how}" aria-controls="lbHowPanel" aria-label="How to play ${name}">${QMARK}</button>
      </div>
      <div class="cv-tb">
        <h3 class="cv-title" aria-hidden="true">${lines}</h3>
        <p class="cv-tag" aria-hidden="true">${esc(sub)}</p>
      </div>
    </div>
  </div>`;
}

function pickerHTML(ctx) {
  const { S, h } = ctx; const { esc } = h;
  const list = pickerGames(S), n = list.length;
  const cats = [...new Set(S.games.map((g) => g.category))].sort();
  const cur = S.ui.lbPickCat || "all";
  const cat = (v, label) => `<button type="button" class="cv-cat" data-act="lb-pickcat" data-cat="${esc(v)}" aria-pressed="${cur === v}">${esc(label)}</button>`;
  const nav = `<div class="cv-cats" role="group" aria-label="Game category">${cat("all", "All")}${cats.map((c) => cat(c, catLabel(c))).join("")}</div>`;
  if (!n) return `${nav}<p class="lb-empty">No games are available right now.</p>`;
  const sel = Math.max(0, list.findIndex((g) => g.id === S.pick.game)), favs = readFavs();
  const off = n < 2 ? " disabled" : "";
  const t = n > 1 ? sel / (n - 1) : 0.5;
  return `${nav}
    <div class="cv-frame">
      <div class="cv" role="group" aria-roledescription="carousel" aria-label="Games">
        ${CV_DECOR}
        <div class="cv-track">${list.map((g, i) => cardTpl(ctx, g, i, n, sel, favs)).join("")}</div>
        <button type="button" class="cv-skip prev" data-act="lb-step" data-dir="-1" aria-label="Previous game"${off}>${CHEV2}</button>
        <button type="button" class="cv-skip next" data-act="lb-step" data-dir="1" aria-label="Next game"${off}>${CHEV2}</button>
        <button type="button" class="cv-scroll" data-act="lb-play"><span>Scroll to discover</span></button>
        <div class="cv-dock">
          <div class="cv-meter" aria-hidden="true">
            <span class="cv-count"><b id="cvCur">${pad2(sel + 1)}</b> / ${pad2(n)}</span>
            <span class="cv-arc" id="cvArc" style="--t:${t}"><svg viewBox="0 0 100 16" preserveAspectRatio="none" focusable="false"><path d="M0 0Q50 32 100 0"/></svg><i class="cv-dot"></i></span>
            <span class="cv-count end">${pad2(n)} / ${pad2(n)}</span>
          </div>
          <div class="cv-arrows">
            <button type="button" class="cv-step prev" data-act="lb-step" data-dir="-1" aria-label="Previous game" tabindex="-1"${off}>${icon("arrow")}</button>
            <button type="button" class="cv-step next" data-act="lb-step" data-dir="1" aria-label="Next game" tabindex="-1"${off}>${icon("arrow")}</button>
          </div>
        </div>
        <p class="lb-sr" id="cvLive" role="status" aria-live="polite" aria-atomic="true"></p>
      </div>
    </div>`;
}

function selectedHTML(ctx) {
  const { S, h } = ctx; const { esc } = h;
  const g = h.game(S.pick.game);
  if (!g) return `<div class="lb-sel lb-sel-empty">Choose a game above to see how it plays.</div>`;
  const r = ratingFor(S, g.id), open = !!S.ui.lbHow;
  const kind = [catLabel(g.category), shortDur(g)].filter(Boolean).join(" · ");
  const line = `<div class="lb-sel-line"><p class="lb-eyebrow lb-sel-kind">${esc(kind)}</p><h2 class="lb-sel-name">${esc(g.name)}</h2><span class="lb-sel-meta">${r ? `Your rating <b class="dg-mono">${r.rating}</b>` : "Unrated"}</span></div>`;
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
      <dl class="lb-facts">${fact("Category", catLabel(g.category))}${fact("Length", g.duration && nbUnits(g.duration.replace(/\s*\(.*\)/, "")))}${fact("Scored by", g.scoreLabel && catLabel(g.scoreLabel))}</dl>
      <div class="lb-meters">${h.meter("Skill", g.skill, "skill")}${h.meter("Luck", g.luck, "luck")}</div>
      <h2 class="lb-howp-h">How to play</h2>
      <ol class="lb-howp-rules">${(g.rules || []).map((x) => `<li>${esc(nbUnits(x))}</li>`).join("")}</ol>
      <p class="lb-hint">Everyone in the match gets the exact same seeded challenge, so the better play wins.</p>
      <div class="lb-howp-act">
        <button type="button" class="lb-btn gold" data-act="try-game" data-game="${esc(g.id)}" id="tryBtn">Try out</button>
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
  const max = (cfg.match && Number(cfg.match.lobbyMaxPlayers)) || 10;
  return `<p class="lb-terms">Every player stakes this. With 2 players: pot <b class="dg-mono">${eth(si.pot)}</b> · winner gets <b class="dg-mono win">${eth(si.payout)} ${h.esc(sym())}</b> · the pot grows with each player, up to ${max} · ${cfg.feeBps / 100}% fee · ${h.real() ? `real ${h.esc(sym())} on ${h.esc(h.chainName())}, held in escrow until the match is decided` : "test network, no real money"}${si.outOfRange ? ` <span class="lb-warn">Stakes run from ${eth(cfg.stake.min)} to ${eth(cfg.stake.max)}.</span>` : ""}</p>`;
}

export function noticesHTML(ctx) {
  const { S, h } = ctx; const me = S.me;
  const banned = me.queueBanUntil, now = h.now();
  let out = "";
  if (banned && Number(banned) > now) out += `<div class="lb-note bad" role="status">You skipped several matches. You can start again at ${h.esc(new Date(Number(banned)).toLocaleTimeString())}.</div>`;
  return out;
}

/* the stage: heading, category row and the game carousel. No card around it, it gets the full width of the page. */
function hero(ctx) {
  const { S } = ctx;
  return `<section class="lb-hero" id="lbCreate" tabindex="-1" aria-labelledby="lbHero">
    <header class="lb-hero-head">
      <div class="lb-hero-t">
        <p class="lb-eyebrow">${S.games.length} games · pick one</p>
        <h1 class="lb-title" id="lbHero">Create a lobby</h1>
      </div>
      <button type="button" class="lb-surprise" data-act="lb-surprise">Surprise me</button>
    </header>
    <div id="lbPicker">${pickerHTML(ctx)}</div>
  </section>`;
}

/* below the stage: the picked game's details, the stake and the one primary action */
function setup(ctx) {
  const { S, h } = ctx; const { esc } = h;
  const me = S.me, now = h.now();
  const banned = me.queueBanUntil && Number(me.queueBanUntil) > now;
  const hasOpen = !!S.lobby, guest = hasOpen && S.lobby.role === "guest"; // hosting a lobby, or waiting in someone else's
  const blocked = banned;
  return `<section class="lb-card lb-setup" id="lbSetup" tabindex="-1" aria-label="Game details and stake">
    <div id="lbSelected">${selectedHTML(ctx)}</div>
    <div class="lb-stakerow"><span class="lb-stakel lb-label" id="lbStakeL">Stake <small>${esc(h.sym())} · ${h.real() ? esc(h.chainName()) : "test network"}</small></span>
      <div class="lb-chips" role="group" aria-labelledby="lbStakeL">${stakeChips(ctx)}</div></div>
    ${S.pick.stake === "custom" ? `<div class="lb-custom"><label for="customStake">Custom stake in ${esc(h.sym())} (${h.eth(S.cfg.stake.min)} to ${h.eth(S.cfg.stake.max)})</label><input id="customStake" type="text" inputmode="decimal" value="${esc(S.pick.custom)}" placeholder="0.002" autocomplete="off"></div>` : ""}
    <div id="lbCalc" aria-live="polite">${calcHTML(ctx)}</div>
    ${noticesHTML(ctx)}
    <div class="lb-err err" id="err" role="alert">${esc(S.error)}</div>
    <div class="lb-go">
      <button class="lb-find" data-act="create-lobby" id="createBtn" ${S.busy || blocked || hasOpen ? "disabled" : ""}>
        <span class="lb-find-t"><b>Create lobby</b></span>${icon("arrow")}</button>
      ${hasOpen ? `<p class="lb-go-note" role="status">${guest ? "You are in a lobby. Leave it below to make a new one." : "You already have an open lobby. Cancel it below to make a new one."}</p>` : ""}
      ${hasOpen && !guest ? `<button type="button" class="lb-cancel" id="cancelBtn" data-act="close-lobby" ${S.busy ? "disabled" : ""}>Cancel open lobby and refund my stake</button>` : ""}
      ${guest ? `<button type="button" class="lb-cancel" id="leaveBtn" data-act="leave-lobby" ${S.busy ? "disabled" : ""}>${String(S.lobby.stake) === "0" ? "Leave lobby" : "Leave lobby and refund my stake"}</button>` : ""}
    </div>
  </section>`;
}

/* the lobby the player is in (S.lobby): hosting it, or waiting in it as a guest. Either way the button goes back to its waiting room. */
export function openLobbyCard(ctx) {
  const { S, h } = ctx; const { esc } = h;
  const L = S.lobby;
  if (!L) return "";
  const guest = L.role === "guest";
  const stake = String(L.stake) === "0" ? "Free play" : `${h.eth(L.stake)} ${esc(h.sym())} stake`;
  const n = Array.isArray(L.players) && L.players.length ? L.players.length : Number(L.playerCount) || 1, max = Number(L.maxPlayers) || 10;
  const who = guest ? `Waiting for ${esc(L.host && L.host.name)} to start` : n > 1 ? "Waiting for you to start, or for more players" : "Waiting for friends to join";
  return `<section class="lb-card lb-open" aria-labelledby="lbOpen">
    <div class="lb-open-in">
      <span class="lb-pulse" aria-hidden="true"></span>
      <div class="lb-open-t"><p class="lb-eyebrow">${guest ? "You are in a lobby" : "Your open lobby"}</p>
        <h2 id="lbOpen">${esc((L.game && L.game.name) || "Game")} <span>· ${stake}</span></h2>
        <p class="lb-open-sub">${who} · <b class="dg-mono">${n} / ${max}</b> players · expires in <b class="dg-mono" data-until="${Number(L.expiresAt) || 0}">${h.left(Number(L.expiresAt) || 0)}</b></p></div>
      <button type="button" class="lb-btn gold" data-act="go-waiting">${guest ? "Show my lobby" : "Show invite link"}${icon("arrow")}</button>
    </div>
  </section>`;
}

/* The Join page (top bar → Join): enter a friend's 8-character code, or paste their whole invite link. */
const JOIN_STEPS = [
  ["1", "Get the code", "It is on your friend’s waiting screen, under the invite link. They can read it out or send it."],
  ["2", "Check the terms", "You see the game, the stake and who invited you before anything is charged."],
  ["3", "Play the same challenge", "Joining puts you in the lobby. When the host starts the match, everyone gets the exact same seeded game at the same time. The highest score takes the pot, and tied top scores split it."],
];
function joinPage(ctx) {
  const { S, h } = ctx; const { esc } = h;
  const inv = S.invite && S.invite.lobby && S.invite.lobby.state === "open" ? S.invite : null;
  const pending = inv ? `<section class="lb-card jn-note" aria-labelledby="jnPend">
      <div class="jn-note-in"><span class="lb-pulse" aria-hidden="true"></span>
        <div><b id="jnPend">${esc(inv.lobby.host.name)} invited you to ${esc(inv.lobby.game.name)}</b><span class="lb-hint">That invite is still open.</span></div>
        <button type="button" class="lb-btn gold" data-act="open-invite">Open invite${icon("arrow")}</button></div></section>` : "";
  const guestIn = !!S.lobby && S.lobby.role === "guest";
  const hosting = S.lobby ? `<section class="lb-card jn-note warn" role="status">
      <div class="jn-note-in"><div><b>${guestIn ? "You are in a lobby" : "You have an open lobby"}</b><span class="lb-hint">${guestIn ? "Leave it before you join someone else’s game." : "Close it before you join someone else’s game."}</span></div>
        <button type="button" class="lb-btn" data-act="go-waiting">Show my lobby${icon("arrow")}</button></div></section>` : "";
  return `<div class="jn-page">
    ${pending}${hosting}
    <section class="lb-card jn-card" aria-labelledby="jnTitle">
      <p class="lb-eyebrow">Join a game</p>
      <h1 class="lb-title lb-title-xl" id="jnTitle">Enter an invite code</h1>
      <p class="lb-muted">Type the code your friend gave you, or paste their whole invite link.</p>
      <div class="jn-row">
        <label class="sr-only" for="joinCode">Invite code or link</label>
        <input id="joinCode" type="text" maxlength="200" placeholder="ABCD2345" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" aria-describedby="jnHint jnErr">
        <button type="button" class="lb-btn primary jn-go" data-act="lb-join-code" id="joinGo">Join${icon("arrow")}</button>
      </div>
      <p class="jn-err" id="jnErr" role="alert" aria-live="polite"></p>
      <p class="lb-hint" id="jnHint">8 letters and numbers. Joining moves no money until you confirm the stake.</p>
    </section>
    <section class="jn-how" aria-labelledby="jnHow">
      <h2 class="jn-h" id="jnHow">How joining works</h2>
      <ol class="jn-steps">${JOIN_STEPS.map(([n, t, d]) => `<li><span class="lb-sn">${n}</span><div><b>${esc(t)}</b><p class="lb-hint">${esc(d)}</p></div></li>`).join("")}</ol>
    </section>
  </div>`;
}

/* ---- rail */

function walletCard(ctx) {
  const { S, h } = ctx; const { eth, sym, esc } = h;
  const b = S.me.balances;
  return `<section class="lb-card lb-wallet" aria-labelledby="lbWallet">
    <header class="lb-card-head"><h2 id="lbWallet">Wallet</h2><span class="lb-chip-s">${h.real() ? esc(sym()) : `Test ${esc(sym())}`}</span></header>
    <div class="lb-bal"><span class="lb-bal-l">Available</span><span class="lb-bal-n"><b class="dg-mono" id="balAvail">${eth(b.available)}</b><span class="lb-bal-u" aria-hidden="true">${esc(sym())}</span></span></div>
    <div class="lb-bal-sub"><span>In play <b class="dg-mono">${eth(b.inPlay)}</b></span>${BigInt(b.pendingWithdrawal || 0) > 0n ? `<span>Withdrawing <b class="dg-mono">${eth(b.pendingWithdrawal)}</b></span>` : ""}</div>
    <div class="lb-row">${S.cfg.devFaucet ? `<button type="button" class="lb-btn gold" data-act="faucet" data-eth="1" id="faucetBtn"${S.depositing ? " disabled" : ""}>${S.depositing ? "Depositing…" : `Deposit 1 test ${esc(sym())}`}</button>` : ""}<button type="button" class="lb-link-btn" data-go="wallet">Deposit and withdraw ${icon("arrow")}</button></div>
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
    <header class="lb-card-head"><h2 id="lbForm">Your form</h2><button type="button" class="lb-link-btn" data-go="history">History ${icon("arrow")}</button></header>
    ${ms.length ? `<div class="lb-pills" aria-label="Last ${ms.length} results, newest first">${pills}${streak}</div><ul class="lb-form-list">${rows}</ul>` : `<p class="lb-empty sm">No matches yet. Your results will show up here.</p>`}
  </section>`;
}

function playCard(ctx) {
  const { S, h } = ctx; const { eth, sym, esc } = h;
  const r = S.me.responsible;
  const limit = r.lossLimit ? `Daily loss limit ${eth(r.lossLimit)} ${esc(sym())}, lost today ${eth(r.lossToday)}` : h.real() ? "No daily loss limit set. Setting one is recommended" : "No daily loss limit set";
  const lead = h.real() ? `<a class="lb-play-link" href="#settings" data-go="settings"><b>Play within your limits.</b></a>` : `<b>Play within your limits.</b>`;
  return `<section class="lb-card lb-play" aria-label="Account limits">
    <div class="lb-play-in">${icon("shield")}<p>${lead} ${limit}.</p></div>
    <button type="button" class="lb-link-btn" data-go="settings">Manage limits ${icon("arrow")}</button>
  </section>`;
}

/* ------------------------------------------------------------------ game library */

function cardHTML(ctx, g, favs) {
  const { S, h } = ctx; const { esc } = h;
  const fav = favs.includes(g.id), r = ratingFor(S, g.id); 
  /* the whole card opens the game page: the "Check out" link stretches over it (lobby.css), the star sits above */
  return `<article class="lb-card lb-gcard" data-game="${esc(g.id)}"${art(g.id) ? ` style="--ga:${art(g.id).accent}"` : ""}>
    ${artBg(g.id, "lb-gart")}
    <div class="lb-gcard-top"><span class="lb-eyebrow">${esc(catLabel(g.category))}${g.duration ? ` · ${esc(nbUnits(g.duration.replace(/\s*\(.*\)/, "")))}` : ""}</span>
      <button type="button" class="lb-fav" data-act="lb-fav" data-game="${esc(g.id)}" aria-pressed="${fav}" aria-label="${fav ? "Remove " : "Add "}${esc(g.name)} ${fav ? "from" : "to"} favourites">${icon("star")}</button></div>
    <h2 class="lb-gname">${esc(g.name)}</h2>
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
    normPick(ctx.S); // the carousel's centre card is always the picked game
    return `<div class="lb-page">
      ${openLobbyCard(ctx)}
      ${hero(ctx)}
      <div class="lb-below">
        ${setup(ctx)}
        <aside class="lb-rail" aria-label="Your account">${walletCard(ctx)}${formCard(ctx)}${playCard(ctx)}</aside>
      </div>
    </div>`;
  },

  join(ctx) { return joinPage(ctx); },

  /* Tournaments are not built yet: an honest "upcoming" page, no invented dates, entrants or prizes */
  tournaments() {
    const fmt = (n, name, meta, text) => `<li class="lb-tour-item">
      <span class="lb-tour-n" aria-hidden="true">${n}</span>
      <div class="lb-tour-b"><h2 class="lb-tour-h">${name}</h2><p class="lb-tour-meta">${meta}</p><p class="lb-tour-p">${text}</p></div>
      <span class="lb-soon">Coming soon</span>
    </li>`;
    return `<div class="lb-tour">
      <header class="lb-tour-head" aria-labelledby="lbTour">
        <p class="lb-eyebrow">Upcoming</p>
        <h1 class="lb-title lb-title-xl" id="lbTour">Tournaments</h1>
        <p class="lb-lede">Tournaments for groups of friends are on the way. One person sets it up, shares a single invite link, and everyone who joins plays the same seeded rounds until one winner is left.</p>
      </header>
      <ol class="lb-tour-list" aria-label="Planned formats">
        ${fmt("01", "Friends bracket", "4 or 8 players · single elimination", "Everyone joins through one link. Each round is a duel on the same challenge, and the winner moves on to the next round.")}
        ${fmt("02", "Duel Mix", "1 opponent · 3 different games", "Three short games from different categories against the same friend. A round win is worth 3 points, a draw 1.")}
        ${fmt("03", "Free-for-all", "Up to 8 players · one game", "The whole group plays the same challenge at the same time. Highest score takes first place.")}
      </ol>
      <div class="lb-tour-cta">
        <p class="lb-muted">Until then, invite up to 9 friends to one lobby. Everyone plays the same challenge and the highest score takes the pot.</p>
        <button type="button" class="lb-btn primary" data-go="lobby">Create a lobby${icon("arrow")}</button>
      </div>
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
        <div class="lb-lib-t"><p class="lb-eyebrow">${S.games.length} games · pick one, then invite a friend</p><h1 class="lb-title lb-title-xl">Game library</h1></div>
        <div class="lb-search">${icon("search")}<label class="lb-sr" for="lbSearch">Search games</label><input id="lbSearch" type="search" placeholder="Search games" value="${esc(S.ui.lbq || "")}" autocomplete="off"></div>
      </header>
      <div class="lb-cats" role="group" aria-label="Category">${chip("all", "All")}${chip("favs", `${icon("star")}Favourites${favs.length ? ` <span class="dg-mono">${favs.length}</span>` : ""}`)}${cats.map((c) => chip(c, esc(catLabel(c)))).join("")}</div>
      <div class="lb-grid" id="lbGrid">${gridHTML(ctx)}</div>
    </div>`;
  },
};

/* ------------------------------------------------------------------ actions */

/* ---- the carousel, moved in place (no re-render, so the cards animate) */

/* put every card where the picked game says: --o / --a / --sg for the transform, which controls show, the counter and the dot.
   quiet = a step of the Surprise me roulette: skip the details and the announcement until it lands. false if there is no carousel on screen. */
function paint(app, { quiet = false } = {}) {
  const { S, ctx } = app;
  const cv = document.querySelector(".cv");
  if (!cv) return false;
  const cards = [...cv.querySelectorAll(".cv-card")], n = cards.length;
  const sel = cards.findIndex((c) => c.dataset.game === S.pick.game);
  if (sel < 0) return false;
  cards.forEach((c, i) => {
    const o = offsetOf(i, sel, n), hit = c.querySelector(".cv-hit");
    c.setAttribute("style", posStyle(o));
    c.toggleAttribute("data-c", o === 0);
    c.toggleAttribute("data-far", Math.abs(o) > CV_SHOWN);
    hit.setAttribute("aria-pressed", String(o === 0));
    hit.tabIndex = o === 0 ? 0 : -1;
  });
  const cur = cv.querySelector("#cvCur"), arc = cv.querySelector("#cvArc");
  if (cur) cur.textContent = pad2(sel + 1);
  if (arc) arc.style.setProperty("--t", String(n > 1 ? sel / (n - 1) : 0.5));
  if (quiet) return true;
  /* the focus was on a card that is no longer the centre (its controls are about to hide): it follows to the new centre card.
     A card coming in from off stage turns visible one frame into its transition, so try again then. */
  const at = document.activeElement, from = at && at.closest && at.closest(".cv-card");
  if (from && from.dataset.game !== S.pick.game) {
    const hit = cards[sel].querySelector(".cv-hit"), go = () => hit.focus({ preventScroll: true });
    go(); requestAnimationFrame(go);
  }
  const box = document.querySelector("#lbSelected");
  if (box) box.innerHTML = selectedHTML(ctx);
  const live = cv.querySelector("#cvLive"), g = app.h.game(S.pick.game);
  if (live && g) live.textContent = `Game ${sel + 1} of ${n}: ${g.name}`;
  return true;
}

/* make `id` the centre card; falls back to a full render if the carousel is not on screen */
function select(app, id, { quiet = false, force = false } = {}) {
  if (!id || (!force && app.S.pick.game === id)) return;
  app.S.pick.game = id;
  if (!paint(app, { quiet })) app.render(true);
}

/* previous / next game, round the ring */
function step(app, dir) {
  const cards = [...document.querySelectorAll(".cv-card")], n = cards.length;
  if (n < 2) return;
  const cur = Math.max(0, cards.findIndex((c) => c.dataset.game === app.S.pick.game));
  select(app, cards[(cur + dir + n) % n].dataset.game);
}

/* keep the circled + and the (i) button in step with the How to play panel */
function syncHow(open) {
  for (const b of document.querySelectorAll(".cv-plus, .cv-info")) b.setAttribute("aria-expanded", String(open));
}

export const actions = {
  "lb-how"(el, app) {
    const { S, ctx } = app;
    S.ui.lbHow = !S.ui.lbHow;
    const box = document.querySelector("#lbSelected");
    if (!box) return app.render(true);
    box.innerHTML = selectedHTML(ctx);
    syncHow(S.ui.lbHow);
    const b = document.querySelector("#lbHowBtn");
    if (!el.closest(".cv")) { if (b) b.focus(); return; }
    /* asked from a card: the panel lives below the stage, so bring it into view when it opens (closing leaves focus on the button) */
    if (S.ui.lbHow && b) { b.focus({ preventScroll: true }); (document.querySelector("#lbSetup") || box).scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" }); }
  },
  "lb-pick"(el, app) { select(app, el.dataset.game); },
  "lb-step"(el, app) { step(app, Number(el.dataset.dir) || 1); },
  /* Play this game (on the centre card) / Scroll to discover: on to the stake. Focus lands on the chosen stake so the keyboard goes
     straight to Create lobby, which stays the one primary action. */
  "lb-play"(el, app) {
    const box = document.querySelector("#lbSetup");
    if (!box) return;
    const chip = box.querySelector("[data-act=stake][aria-pressed=true]") || box.querySelector("[data-act=stake]");
    if (chip) chip.focus({ preventScroll: true });
    box.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
  },
  /* a new category: the cards are rebuilt. The picked game stays centre if it is in it, else the first card takes over. */
  "lb-pickcat"(el, app) {
    const { S } = app;
    S.ui.lbPickCat = el.dataset.cat; S.ui.lbOrder = null; S.ui.lbSwap = true;
    const list = pickerGames(S);
    if (list.length && !list.some((g) => g.id === S.pick.game)) S.pick.game = list[0].id;
    app.render(true);
    const b = document.querySelector("[data-act=lb-pickcat][aria-pressed=true]"); // the row was rebuilt: keep the keyboard where it was
    if (b) b.focus({ preventScroll: true });
  },
  /* a short roulette round the carousel, slowing down, then it lands on the pick (instant with reduced motion) */
  "lb-surprise"(el, app) {
    const S = app.S;
    const list = pickerGames(S), pool = list.filter((g) => g.id !== S.pick.game);
    if (!pool.length || el.dataset.busy) return;
    const target = pool[Math.floor(Math.random() * pool.length)].id;
    const land = () => {
      delete el.dataset.busy;
      const cv = document.querySelector(".cv");
      if (cv) cv.style.removeProperty("--cv-dur");
      select(app, target, { force: true });
      const c = document.querySelector(".cv-card[data-c]");
      if (c) { c.classList.add("is-landed"); setTimeout(() => c.classList.remove("is-landed"), 900); }
    };
    if (reducedMotion() || list.length < 3 || !document.querySelector(".cv")) return land();
    el.dataset.busy = "1";
    let i = 0, last = S.pick.game;
    const tick = () => {
      const cv = document.querySelector(".cv");
      if (!cv) { delete el.dataset.busy; return; }
      if (i >= 8) return land();
      let g; do { g = list[Math.floor(Math.random() * list.length)]; } while ((g.id === last || g.id === target) && list.length > 3);
      last = g.id;
      cv.style.setProperty("--cv-dur", `${0.14 + i * 0.045}s`); // quick at first, easing off
      select(app, g.id, { quiet: true });
      i++;
      setTimeout(tick, 60 + i * i * 6);
    };
    tick();
  },
  "go-waiting"(el, app) { app.S.view = "waiting"; app.render(true); },
  /* a friend read the code out: go to the invite screen (it signs in first if needed) */
  "lb-join-code"(el, app) { joinByCode(app); },
  "lb-gcat"(el, app) { app.S.ui.lbcat = el.dataset.cat; app.render(true); },
  "lb-fav"(el, app) {
    const id = el.dataset.game, f = readFavs();
    const next = f.includes(id) ? f.filter((x) => x !== id) : [...f, id];
    app.store.set(FAV_KEY, JSON.stringify(next));
    if (el.closest(".cv")) { // on a carousel card: flip the star in place, the cards keep their order until the next visit
      const on = next.includes(id), g = app.h.game(id);
      el.setAttribute("aria-pressed", String(on));
      if (g) el.setAttribute("aria-label", `${on ? "Remove " : "Add "}${g.name} ${on ? "from" : "to"} favourites`);
      return;
    }
    app.S.ui.lbOrder = null; // the library changed the favourites: the carousel sorts again
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

/* ---- carousel input: ← → Home End while the focus is in it, a swipe (touch or mouse drag) and a sideways trackpad scroll */
let appRef = null; // set by mount()
document.addEventListener("keydown", (e) => {
  if (!appRef || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !e.target.closest) return;
  const cv = e.target.closest(".cv");
  if (!cv || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  if (e.key === "ArrowLeft") step(appRef, -1);
  else if (e.key === "ArrowRight") step(appRef, 1);
  else { const cards = cv.querySelectorAll(".cv-card"); if (cards.length) select(appRef, cards[e.key === "Home" ? 0 : cards.length - 1].dataset.game); }
});

let drag = null, swallow = false, wheelAt = 0;
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest || !e.target.closest(".cv-track") || (e.pointerType === "mouse" && e.button !== 0)) return;
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sideways: false };
});
document.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.sideways && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) drag.sideways = true;
});
document.addEventListener("pointerup", (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag, dx = e.clientX - d.x;
  drag = null;
  if (d.sideways && Math.abs(dx) > 36 && appRef) {
    step(appRef, dx < 0 ? 1 : -1);
    swallow = true; setTimeout(() => { swallow = false; }, 80); // the click that follows a swipe must not also pick the card under the finger
  }
});
document.addEventListener("pointercancel", () => { drag = null; });
document.addEventListener("click", (e) => { if (swallow) { swallow = false; e.stopPropagation(); e.preventDefault(); } }, true);
document.addEventListener("wheel", (e) => {
  if (!appRef || !e.target.closest || !e.target.closest(".cv-track")) return;
  if (Math.abs(e.deltaX) < 20 || Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.3) return; // a mostly vertical scroll is the page's
  e.preventDefault();
  const now = performance.now();
  if (now - wheelAt > 380) { wheelAt = now; step(appRef, Math.sign(e.deltaX)); }
}, { passive: false });

/* ------------------------------------------------------------------ hooks */

export function mount(name, app) {
  const { S } = app;
  if (name !== "lobby") { S.ui.lbOrder = null; return; } // leaving the page: the carousel sorts again (favourites first) next time
  appRef = app;
  /* a new category: its cards fade in (opacity only, the transforms stay the carousel's) */
  if (S.ui.lbSwap) {
    S.ui.lbSwap = false;
    const track = document.querySelector(".cv-track");
    if (track && !reducedMotion()) { track.classList.add("cv-in"); setTimeout(() => track.classList.remove("cv-in"), 700); }
    const b = document.querySelector(".cv-cat[aria-pressed=true]");
    if (b) b.scrollIntoView({ block: "nearest", inline: "center" });
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
