/* App shell: top bar, navigation, sign-in screen. Styles live in app.css. */
import { icon, avatar } from "../ui.js";

const NAV = [
  ["lobby", "Lobby", "bolt", "Lobby"],
  ["games", "Games", "games", "Games"],
  ["tournaments", "Tournaments", "trophy", "Tourneys"],
  ["history", "History", "history", "History"],
  ["wallet", "Wallet", "wallet", "Wallet"],
  ["settings", "Account", "shield", "Account"],
];

/* the avatar menu is open/closed outside the render cycle (renders replace #topRight), so its state lives in S.ui */
let appRef = null;
function setMenu(open) {
  if (!appRef) return;
  appRef.S.ui.menuOpen = open;
  const btn = document.getElementById("acctBtn"), menu = document.getElementById("acctMenu");
  if (btn) btn.setAttribute("aria-expanded", String(open));
  if (menu) menu.hidden = !open;
}
document.addEventListener("click", (e) => {
  if (!appRef || !appRef.S.ui.menuOpen) return;
  if (e.target.closest("#acctBtn")) return; // the toggle action handles itself
  const inMenu = e.target.closest("#acctMenu");
  if (!inMenu || e.target.closest("[data-go],[data-act=logout]")) setMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && appRef && appRef.S.ui.menuOpen) { setMenu(false); const b = document.getElementById("acctBtn"); if (b) b.focus(); }
});


export function topBar(ctx) {
  const { S, h } = ctx; const { esc, eth, sym, short } = h;
  if (!S.me) return "";
  const b = S.me.balances, open = !!S.ui.menuOpen;
  const inv = S.invite && S.invite.lobby && S.invite.lobby.state === "open" ? S.invite : null;
  const pending = S.view !== "lobby" ? "" : S.lobby
    ? `<button class="top-add top-open" data-act="open-lobby" id="openLobby" title="${S.lobby.role === "guest" ? "Go to the lobby you joined" : "Go to your open lobby"}" aria-label="Open your waiting room">${icon("clock")}<span>Open lobby</span></button>`
    : inv ? `<button class="top-add top-open" data-act="open-invite" id="openInvite" title="You have a pending invite" aria-label="Open the pending invite from ${esc(inv.lobby.host.name)}">${icon("users")}<span>Invite</span></button>` : "";
  /* Join: opens the "enter an invite code" page. Disabled while a queue / match prompt holds the screen, like the nav.
     During a game the bar only shows the balance (read-only) and the account menu: nothing else is reachable then. */
  const locked = ["queue", "found", "orphan"].includes(S.view), playing = S.view === "play";
  const onJoin = S.view === "lobby" && S.tab === "join";
  const join = playing ? "" : locked
    ? `<button class="top-join" disabled title="Finish or leave the match first" aria-label="Join a game with an invite code (finish or leave the match first)">${icon("link")}<span>Join</span></button>`
    : `<a class="top-join" href="#join" data-go="join" id="topJoin" ${onJoin ? 'aria-current="page"' : ""} title="Join a friend's game with an invite code" aria-label="Join a game with an invite code">${icon("link")}<span>Join</span></a>`;
  const faucet = !playing && S.cfg && S.cfg.devFaucet && S.wallet
    ? `<button class="top-add" data-act="top-faucet" data-eth="1" id="topFaucet" title="Deposit 1 test ${esc(sym())} into your wallet" aria-label="Deposit 1 test ${esc(sym())}"${S.depositing ? " disabled" : ""}>${icon("plus")}<span>${S.depositing ? "Depositing…" : "Deposit"}</span></button>` : "";
  const balIn = `<span class="lbl">Balance</span><b class="dg-mono" id="topBal">${esc(eth(b.available))}</b><em>${esc(sym())}</em>`;
  return join + (playing
    ? `<span class="pill bal-pill" title="Available balance"><span class="sr-only">Available balance</span>${balIn}</span>`
    : `<a class="pill bal-pill" href="#wallet" data-go="wallet" title="Available balance. Open wallet" aria-label="Available balance ${esc(eth(b.available))} ${esc(sym())}. Open wallet">${balIn}</a>`) +
    pending + faucet +
    `<div class="acct">
      <button class="top-avatar" id="acctBtn" data-act="top-menu" aria-haspopup="true" aria-expanded="${open}" aria-controls="acctMenu" aria-label="Account menu for ${esc(S.me.displayName)}">${avatar(S.me.address, 38)}</button>
      <div class="acct-menu" id="acctMenu" ${open ? "" : "hidden"}>
        <div class="acct-id">
          <span class="acct-ava">${avatar(S.me.address, 44)}</span>
          <div><b>${esc(S.me.displayName)}</b><span class="dg-mono" title="${esc(S.me.address)}">${esc(short(S.me.address))}</span></div>
        </div>
        <button class="acct-item" data-act="top-copy">${icon("copy")}<span>Copy address</span></button>
        <a class="acct-item" href="#settings" data-go="settings">${icon("shield")}<span>Account</span></a>
        <button class="acct-item out" data-act="logout">${icon("out")}<span>Sign out</span></button>
      </div>
    </div>`;
}

export function nav(ctx) {
  const { S, h } = ctx;
  if (!S.me) return "";
  /* while a queue / match prompt is on screen the pages behind the nav are not reachable, so show the items but disable them */
  const locked = ["queue", "found", "orphan"].includes(S.view);
  const here = S.view === "lobby" ? (S.tab === "game" ? "games" : S.tab) : ""; // a game's own page lives under Games
  const lab = (l, s) => `<span class="l-full">${h.esc(l)}</span><span class="l-short" aria-hidden="true">${h.esc(s)}</span>`;
  /* Account is the one destination the phone bottom bar leaves out (five fit with readable labels): the avatar menu has it */
  return NAV.map(([id, label, ico, short]) => { const more = id === "settings" ? " nav-more" : ""; return locked
    ? `<button class="nav-b${more}" disabled title="Finish or leave the match first">${icon(ico)}${lab(label, short)}</button>`
    : `<a class="nav-b${more}" href="#${id}" data-go="${id}" ${here === id ? 'aria-current="page"' : ""} title="${h.esc(label)}" aria-label="${h.esc(label)}">${icon(ico)}${lab(label, short)}</a>`; }).join("");
}

const STEPS = [
  ["01", "Pick a game and a stake", "Free play, or a small test-ETH stake from your in-app balance. Every player puts in the same amount."],
  ["02", "Send the invite link to friends", "No bots, no strangers. Up to 10 players can join one lobby. When you start the match, everyone plays the exact same seeded challenge at the same time."],
  ["03", "Highest score takes the pot", "The top score wins the pot minus the fee, and tied top scores split it. The seed is revealed afterwards so anyone can replay and check it."],
];

/* wallet and ethers errors can be long and technical: show a short, honest line instead */
const friendly = (m) => {
  const t = String(m || "");
  if (/reject|denied|cancel/i.test(t)) return "The wallet request was cancelled. Nothing was signed and no money moved.";
  if (t.length > 160 || /payload=|code=|version=/.test(t)) return "Could not connect that wallet. You can try again, or continue with a burner wallet.";
  return t;
};

export const views = {
  signin(ctx) {
    const { S, h } = ctx; const { esc } = h;
    const hasInjected = !!window.ethereum;
    const fee = S.cfg && S.cfg.feeBps != null ? `${S.cfg.feeBps / 100}%` : "a small fee";
    const net = S.cfg && S.cfg.chain ? S.cfg.chain.name : "a test network";
    const inv = S.invite, l = inv && inv.lobby;
    const open = l && l.state === "open";
    const stakeTxt = l ? (String(l.stake) === "0" ? "Free" : `${h.eth(l.stake)} ${h.sym()}`) : "";
    let banner = "";
    if (inv && inv.loading) banner = `<div class="si-invite" role="status"><span class="si-ico" aria-hidden="true">${icon("link")}</span><div><b>Checking your invite…</b></div></div>`;
    else if (open) banner = `<div class="si-invite" id="inviteBanner" role="status"><span class="si-ava">${avatar(l.host.name, 44)}</span><div><b>${esc(l.host.name)} invited you to ${esc(l.game.name)} · ${esc(stakeTxt)}</b><span>Sign in below to see the terms and join. Signing in moves no money.</span></div></div>`;
    else if (inv) banner = `<div class="si-invite bad" id="inviteBanner" role="status"><span class="si-ico" aria-hidden="true">${icon("link")}</span><div><b>${l ? "This invite is no longer open" : "This invite link did not work"}</b><span>${l ? "The lobby was closed, expired or already taken." : "It may be mistyped or expired."} You can still sign in and play.</span></div></div>`;
    /* one key word in solid gold; the second line is the quieter half of the headline */
    const head = open
      ? `<span class="l1">${esc(l.host.name)} challenged&nbsp;you.</span><span class="l2">Sign in to <span class="gold-t">accept</span>.</span>`
      : `<span class="l1"><span class="nb">Out-play</span> a&nbsp;friend.</span><span class="l2">Winner takes the <span class="gold-t">pot</span>.</span>`;
    return `<div class="landing">
      <section class="landing-hero" aria-labelledby="hSign">
        <p class="eyebrow">${open ? "You have been invited" : "Real players. Same challenge. One winner."}</p>
        <h1 class="landing-h${open ? " is-invite" : ""}" id="hSign">${head}</h1>
        ${banner}
        <p class="lede">Duel.gold lets you challenge friends to a short skill game with a private invite link, with up to 10 players in one lobby. Everyone gets the same seeded challenge, the highest score wins the pot minus ${esc(fee)}, and every result can be replayed and verified.</p>
        <div class="landing-cta">
          <button class="dg-btn primary xl" data-act="burner" id="signBurner"><span>Continue with a burner wallet</span></button>
          ${hasInjected ? `<button class="dg-btn xl" data-act="injected" id="signInjected"><span>Connect browser wallet</span></button>` : ""}
        </div>
        <div class="err" id="err" role="alert">${esc(friendly(S.error))}</div>
        <p class="dg-note">A burner wallet is a key created and kept in this browser, only used to sign you in. Signing in costs no gas and moves no money. Never send real funds to it, and clearing your browser data removes it.</p>
      </section>

      <aside class="landing-side">
        <section aria-labelledby="hHow">
          <h2 id="hHow">How it works</h2>
          <ol class="steps">${STEPS.map(([n, t, d]) => `<li><span class="step-n">${n}</span><div><b>${esc(t)}</b><p>${esc(d)}</p></div></li>`).join("")}</ol>
        </section>
        <section class="testnote" aria-labelledby="hTest">
          <h2 id="hTest">Test network only</h2>
          <p>Everything runs on ${esc(net)}. Test ETH has no real-world value, and nobody can buy or cash it out. You can set a daily loss limit at any time.</p>
        </section>
      </aside>
    </div>`;
  },
};

export const actions = {
  "open-lobby": async (el, app) => { if (app.S.lobby) { app.S.view = "waiting"; app.render(true); window.scrollTo(0, 0); } },
  "open-invite": async (el, app) => { if (app.S.invite) { app.S.view = "invite"; app.S.error = ""; app.render(true); window.scrollTo(0, 0); } },
  "top-menu": async (el, app) => { appRef = app; setMenu(!app.S.ui.menuOpen); },
  "top-copy": async (el, app) => {
    try { await navigator.clipboard.writeText(app.S.me.address); app.toast("Address copied.", "good"); }
    catch { app.toast("Could not copy. Select the address in Settings instead.", ""); }
  },
  /* the top-bar Deposit button runs the same deposit as the wallet page (core "faucet" action, 1 test ETH) */
  "top-faucet": (el, app) => app.act("faucet", el),
};

/* grab the app handle early so Escape / outside-click handling works even before the first menu click */
export function mount(view, app) { appRef = app; }
