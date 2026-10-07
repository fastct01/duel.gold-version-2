/* Account pages: wallet, history, responsible play. Styles live in account.css.
   The wallet works on a test network (faucet, test ETH) and on Ethereum mainnet (real ETH: deposit address with explorer link,
   minimum deposit, network fee on withdrawals, a confirm step). cfg.chain.realMoney switches the copy; devFaucet gates the faucet. */
import { icon, avatar } from "../ui.js";

const RESULT_LABEL = { win: "Win", loss: "Loss", draw: "Draw", void: "Cancelled" };

const sign = (wei, eth) => (wei > 0n ? `+${eth(wei)}` : wei < 0n ? `−${eth(-wei)}` : "±0");
const cls = (wei) => (wei > 0n ? "dg-good" : wei < 0n ? "dg-bad" : "dg-muted");
const when = (t) => (t ? new Date(Number(t)).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

/* net change of one finished match for the viewer, in wei (BigInt) */
function netOf(m) {
  const stake = BigInt(m.stake || 0);
  if (m.result === "win") return BigInt(m.you.payout != null ? m.you.payout : m.winnerPayout || 0) - stake;
  if (m.result === "loss") return -stake;
  return 0n;
}

/* Mainnet fields (GET /v1/wallet and /v1/config), wei as decimal strings. Each is read from the places it is likely to be and used only
   when present: wallet.deposit { min, pending, remaining, confirmations }, wallet.withdrawalFee { mode, fee | null }, config.withdrawal.fee
   (fixed mode). The player pays amount + fee, and the wallet receives the amount. null = the server does not say. */
const first = (...v) => v.find((x) => x != null && x !== "");
const toWei = (x) => { try { return x == null || x === "" || typeof x === "object" ? null : BigInt(x); } catch { return null; } };
export function minDepositOf(S) {
  const w = S.wallet || {}, c = S.cfg || {}, l = w.limits || {};
  return toWei(first(w.deposit && w.deposit.min, w.minDepositWei, l.minDeposit, l.minDepositWei, c.deposit && (c.deposit.minWei ?? c.deposit.min), c.minDepositWei));
}
export function withdrawFeeOf(S) {
  const w = S.wallet || {}, c = S.cfg || {};
  const wf = w.withdrawalFee && typeof w.withdrawalFee === "object" ? w.withdrawalFee.fee : w.withdrawalFee;
  if (w.withdrawalFee && typeof w.withdrawalFee === "object" && w.withdrawalFee.fee === null) return null; // the server could not estimate it right now
  return toWei(first(wf, w.withdrawalFeeWei, c.withdrawal && (c.withdrawal.feeWei ?? c.withdrawal.fee), c.withdrawalFeeWei));
}
/* the confirm step (what arrives, the fee on top, the total) shows for real money, and whenever the server names a fee above zero */
const needsConfirm = (S) => !!(S.cfg && S.cfg.chain && S.cfg.chain.realMoney) || (withdrawFeeOf(S) || 0n) > 0n;
const explorerUrl = (S, kind, id) => {
  const base = S.cfg && S.cfg.chain && S.cfg.chain.explorer;
  return base && id ? `${String(base).replace(/\/+$/, "")}/${kind}/${id}` : "";
};

/* ---------------------------------------------------------------------- deposit amounts
   The picker is the same on every network: preset chips plus "Custom". Local chain (devFaucet): the faucet sends the amount, at most 1 per call.
   Anywhere else the amount is sent from the browser wallet (eth_sendTransaction) to the player's own deposit address. */
const MAIN_PRESETS = ["0.01", "0.025", "0.05", "0.1", "0.25"], FAUCET_PRESETS = ["0.1", "0.5", "1"];
const MAX_DEPOSIT = 10, FAUCET_MAX = 1, FAUCET_MIN = "0.000001"; // ETH. The faucet reads its amount as a JS number, so tiny ones would turn into "1e-7"
const NUM_RE = /^(\d+\.?\d*|\.\d+)$/;
const parse = (s) => window.ethers.parseEther(s);
const BLOCK_SECONDS = 12; // Ethereum mainnet (chain id 1); other chains get no time estimate

function depositModel(S, h) {
  const faucet = !!(S.cfg && S.cfg.devFaucet), presets = faucet ? FAUCET_PRESETS : MAIN_PRESETS, sym = h.sym();
  let min = minDepositOf(S); if (min != null && min <= 0n) min = null;
  const enabled = presets.filter((p) => min == null || parse(p) >= min);
  let sel = S.ui.depAmt;
  if (sel !== "custom" && !presets.includes(sel)) sel = faucet ? "1" : "0.05"; // the default (the local tests deposit with it)
  if (sel !== "custom" && !enabled.includes(sel)) sel = enabled[0] || "custom";  // the chosen preset fell below the minimum
  const maxEth = faucet ? FAUCET_MAX : MAX_DEPOSIT, max = parse(String(maxEth));
  const typed = String(S.ui.depCustom || "").trim();
  let amount = null, err = "";
  if (sel !== "custom") amount = parse(sel);
  else if (typed) {
    if (!NUM_RE.test(typed)) err = "Enter a number, like 0.05.";
    else if (/^[0.]+$/.test(typed)) err = "Enter an amount above 0.";
    else if ((typed.split(".")[1] || "").length > 18) err = "Use at most 18 decimal places.";
    else {
      let v = null;
      try { v = parse(typed); } catch { err = "Enter a number, like 0.05."; }
      if (v != null) {
        if (faucet && v < parse(FAUCET_MIN)) err = `The test faucet sends at least ${FAUCET_MIN} ${sym}.`;
        else if (min != null && v < min) err = `The minimum deposit is ${h.eth(min, 9)} ${sym}.`;
        else if (v > max) err = faucet ? `The test faucet sends at most ${maxEth} ${sym} at a time.` : `The most you can deposit here at once is ${maxEth} ${sym}.`;
        else amount = v;
      }
    }
  }
  return { faucet, presets, enabled, min, sel, amount, err, typed, maxEth };
}
const depLabel = (m, h) => (m.amount != null ? `Deposit ${h.esc(h.eth(m.amount, 9))}&nbsp;${h.esc(h.sym())}` : "Enter an amount");

/* the rough wait for N confirmations, in words (Ethereum mainnet only: 12 s per block) */
function etaText(S, conf) {
  if (!S.cfg || !S.cfg.chain || S.cfg.chain.id !== 1 || !(conf > 0)) return "";
  const s = conf * BLOCK_SECONDS;
  if (s < 90) return `about ${Math.round(s / 10) * 10 || 10} seconds`;
  const lo = Math.floor(s / 60), hi = Math.ceil(s / 60);
  return lo === hi ? `about ${lo} minutes` : `about ${lo}–${hi} minutes`;
}

/* a deposit as the server lists it: "credited", or "pending" (seen on-chain but below the minimum so far, credited together once the total reaches it) */
const depState = (d) => (d.credited === true || String(d.status || "credited").toLowerCase() === "credited" ? "credited" : "pending");
const sameHash = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

/* The deposit this browser just sent from the wallet. It is only known to the server once it is `confirmations` deep, so until then the page
   tracks it itself ({ hash, amount (wei string), at, conf }) and keeps it for the tab's life. */
const SENT_KEY = (S) => `dg.depSent.${String((S.me && S.me.address) || "").toLowerCase()}`;
function sentOf(S) {
  if (S.ui.depSent === undefined) {
    try { S.ui.depSent = JSON.parse(sessionStorage.getItem(SENT_KEY(S)) || "null"); } catch { S.ui.depSent = null; }
  }
  return S.ui.depSent;
}
function setSent(S, v) {
  S.ui.depSent = v;
  try { if (v) sessionStorage.setItem(SENT_KEY(S), JSON.stringify(v)); else sessionStorage.removeItem(SENT_KEY(S)); } catch { /* private mode */ }
}

/* ---------------------------------------------------------------------- transactions (deposits and withdrawals in one list) */
const FILTERS = [["all", "All"], ["deposit", "Deposits"], ["withdrawal", "Withdrawals"]];
const TX_PAGE = 15;
/* backend status → what the player sees. Deposits (server/src/wallet/deposits.js): credited | pending (below the minimum); "confirming" is this page's own
   view of a deposit sent from the wallet that the server has not recorded yet. Withdrawals (withdrawals.js): queued | signed | broadcast | confirmed | failed. */
const TX_STATUS = {
  confirming: ["draw", "Confirming"], below: ["draw", "Below minimum"], credited: ["win", "Successful"],
  queued: ["draw", "Queued"], signed: ["draw", "Processing"], broadcast: ["draw", "Sent"], confirmed: ["win", "Confirmed"], failed: ["loss", "Failed · refunded"],
};
const WD_ACTIVE = new Set(["queued", "signed", "broadcast"]);

function dayLabel(t, nowMs) {
  const d = new Date(t), n = new Date(nowMs), y = new Date(nowMs);
  y.setDate(y.getDate() - 1);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, n)) return "Today";
  if (same(d, y)) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", ...(d.getFullYear() !== n.getFullYear() ? { year: "numeric" } : {}) });
}
function relTime(t, nowMs) {
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  return s < 10 ? "just now" : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
}

/* every deposit and withdrawal as one list, newest first */
function collectTxs(S, h) {
  const w = S.wallet || {}, out = [];
  const deps = w.deposits || [], wds = w.withdrawals || [];
  for (const d of deps) {
    out.push({ kind: "deposit", state: depState(d) === "credited" ? "credited" : "below", t: Number(first(d.creditedAt, d.detectedAt, d.createdAt)) || 0,
      amount: toWei(d.amount) || 0n, fee: 0n, hash: d.txHash, url: d.explorerUrl || explorerUrl(S, "tx", d.txHash) });
  }
  for (const x of wds) {
    out.push({ kind: "withdrawal", state: x.status, t: Number(x.createdAt) || 0, amount: toWei(x.amount) || 0n, fee: toWei(first(x.feeWei, x.fee)) || 0n,
      hash: x.txHash, url: x.explorerUrl || explorerUrl(S, "tx", x.txHash), error: x.error, to: x.to });
  }
  const sent = sentOf(S);
  if (sent && !deps.some((d) => sameHash(d.txHash, sent.hash))) {
    out.push({ kind: "deposit", state: "confirming", t: Number(sent.at) || h.now(), amount: toWei(sent.amount) || 0n, fee: 0n, hash: sent.hash, url: explorerUrl(S, "tx", sent.hash), conf: Number(sent.conf) || 0 });
  }
  return out.sort((a, b) => b.t - a.t);
}

function txRow(S, h, tx) {
  const { esc, eth, sym, short } = h, N = (S.wallet && S.wallet.chain && S.wallet.chain.confirmations) || (S.cfg.deposit && S.cfg.deposit.confirmations) || 1;
  const [tone, base] = TX_STATUS[tx.state] || ["draw", String(tx.state || "Unknown").replace(/^./, (c) => c.toUpperCase())];
  const label = tx.state === "confirming" ? `${base} · ${Math.min(tx.conf, N)} / ${N}` : base;
  const dep = tx.kind === "deposit", nowMs = h.now();
  const credited = tx.state === "credited", failed = tx.state === "failed";
  const amtCls = dep ? (credited ? "dg-good" : "dg-muted") : failed ? "dg-muted tx-void" : "";
  const e9 = (x) => eth(x, 9), amtTxt = sign(dep ? tx.amount : -tx.amount, e9);
  const min = minDepositOf(S);
  let note = "";
  if (tx.state === "below") note = `Below the minimum deposit${min != null && min > 0n ? ` of ${eth(min, 9)} ${sym()}` : ""}, so it is not credited yet.`;
  else if (tx.state === "confirming") note = `Waiting for ${N} confirmation${N > 1 ? "s" : ""}${etaText(S, N) ? `, ${etaText(S, N)}` : ""}.`;
  else if (tx.state === "broadcast") note = `On its way. Waiting for ${N} confirmation${N > 1 ? "s" : ""}.`;
  else if (tx.state === "queued") note = tx.error === "treasury_underfunded" ? "Taking longer than usual. It goes out as soon as it can." : "Waiting to be sent to the network.";
  else if (failed) note = `Refunded to your balance${tx.fee > 0n ? ", network fee included" : ""}.${tx.error ? ` Reason: ${tx.error}.` : ""}`;
  const ref = tx.hash
    ? `<span class="tx-ref"><span class="tx-hash dg-mono" title="${esc(tx.hash)}">${esc(short(tx.hash))}</span>
        <button type="button" class="tx-btn" data-act="copy-tx" data-v="${esc(tx.hash)}" aria-label="Copy transaction hash" title="Copy transaction hash">${icon("copy")}</button>
        ${tx.url ? `<a class="tx-btn" href="${esc(tx.url)}" target="_blank" rel="noopener" aria-label="View transaction on the explorer" title="View on the explorer">${icon("link")}</a>` : ""}</span>`
    : `<span class="sub">Not on-chain yet</span>`;
  const feeLine = !dep && tx.fee > 0n ? `<span class="sub dg-mono">+ ${eth(tx.fee, 9)} fee</span>` : "";
  return `<li class="tx ${dep ? "tx-dep" : "tx-wd"}" data-kind="${tx.kind}" data-status="${esc(tx.state)}">
    <div class="tx-main"><b class="tx-kind"${!dep && tx.to ? ` title="To ${esc(tx.to)}"` : ""}>${dep ? "Deposit" : "Withdrawal"}</b><time class="sub" datetime="${tx.t ? new Date(tx.t).toISOString() : ""}" title="${esc(when(tx.t))}">${esc(relTime(tx.t, nowMs))}</time></div>
    <div class="tx-meta"><span class="rpill ${tone}">${esc(label)}</span>${ref}</div>
    <div class="tx-amt"><b class="dg-mono ${amtCls}">${amtTxt}&nbsp;${esc(sym())}</b>${feeLine}</div>
    ${note ? `<p class="tx-note">${note}</p>` : ""}
  </li>`;
}

function txSection(S, h) {
  const all = collectTxs(S, h), filter = FILTERS.some(([k]) => k === S.ui.txFilter) ? S.ui.txFilter : "all";
  const shown = filter === "all" ? all : all.filter((x) => x.kind === filter);
  const limit = S.ui.txLimit || TX_PAGE, page = shown.slice(0, limit);
  const nDep = all.filter((x) => x.kind === "deposit" && x.state === "confirming").length;
  const nBelow = all.filter((x) => x.kind === "deposit" && x.state === "below").length;
  const nWd = all.filter((x) => x.kind === "withdrawal" && WD_ACTIVE.has(x.state)).length;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const parts = [nDep && `${plural(nDep, "deposit")} confirming`, nBelow && `${plural(nBelow, "deposit")} below the minimum`, nWd && `${plural(nWd, "withdrawal")} processing`].filter(Boolean);
  const EMPTY = {
    all: "No transactions yet. Your deposits and withdrawals will be listed here, each with its status and a link to the transaction.",
    deposit: "No deposits yet. Once you deposit, each one shows up here as soon as it is confirmed and credited to your balance.",
    withdrawal: "No withdrawals yet. When you withdraw, each one shows up here with its status and a link to the transaction.",
  };
  const groups = [];
  for (const tx of page) {
    const label = dayLabel(tx.t, h.now());
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.rows.push(tx); else groups.push({ label, rows: [tx] });
  }
  const chip = ([k, name]) => `<button type="button" class="dg-chip" data-act="tx-filter" data-v="${k}" aria-pressed="${filter === k}">${name}</button>`;
  return `<section class="sec" aria-labelledby="hTx">
    <div class="sec-h"><h2 class="dg-h" id="hTx">Transactions</h2><p>Your deposits and withdrawals, newest first.</p></div>
    <div class="sec-b">
      ${parts.length ? `<div class="notice" role="status" id="txSummary">${icon("clock")}<span>${h.esc(parts.join(" · "))}</span></div>` : ""}
      <div class="chips tx-filter" role="group" aria-label="Filter transactions">${FILTERS.map(chip).join("")}</div>
      <div class="tx-wrap" id="txList" data-filter="${filter}">${groups.length ? groups.map((g, i) => `<section class="tx-day" aria-labelledby="txd${i}"><h3 class="tx-dayh" id="txd${i}">${h.esc(g.label)}</h3><ul class="tx-list">${g.rows.map((r) => txRow(S, h, r)).join("")}</ul></section>`).join("")
        : `<p class="dg-note tx-empty">${EMPTY[filter]}</p>`}</div>
      ${shown.length > limit ? `<div><button type="button" class="dg-btn ghost" data-act="tx-more" id="txMore"><span>Show more (${shown.length - limit})</span></button></div>` : ""}
    </div>
  </section>`;
}

function header(title, text) {
  return `<header class="page-h"><h1>${title}</h1><p>${text}</p></header>`;
}

/* an email account has no wallet yet: withdrawals need one, linked once by a signature (POST /v1/me/wallet/link, app.js linkWallet) */
const linkWalletHTML = () => `<div class="sec-b link-wallet">
  <p class="dg-note">Withdrawals can only go to a wallet you own. Link one to this account: your wallet signs a message, which costs no gas and moves no money. You can link one wallet, and it can then sign in to this account too.</p>
  ${window.ethereum ? `<button type="button" class="dg-btn" data-act="link-wallet" id="linkWallet"><span>Link a wallet</span></button>`
    : `<a class="dg-btn" href="https://metamask.io/download/" target="_blank" rel="noopener"><span>Install a wallet to link it</span></a>`}
</div>`;

/* one figure of a ledger band: small uppercase label, a large serif numeral, a quiet unit. Pass id for a number the tests read. */
const stat = (label, value, unit, { id = "", cls: c = "", live = false, extra = "" } = {}) =>
  `<div class="dg-stat"><span class="stat-l">${label}</span><div class="stat-v"><b class="dg-mono ${c}"${id ? ` id="${id}"` : ""}${live ? ' aria-live="polite"' : ""}>${value}</b>${unit ? `<span class="unit">${unit}</span>` : ""}</div>${extra}</div>`;

/* the step before a withdrawal is sent: what arrives, the network fee on top, and the total taken from the balance. `typed` is the validated amount. */
function wdConfirmHTML(ctx, typed) {
  const { S, h } = ctx; const { esc, eth, sym, short } = h;
  let amount = 0n;
  try { amount = window.ethers.parseEther(typed); } catch { return ""; }
  const fee = withdrawFeeOf(S), to = S.wallet ? S.wallet.withdrawTo : "";
  const row = (k, v, cls = "") => `<div class="wd-sumrow ${cls}"><dt>${k}</dt><dd class="dg-mono">${v}</dd></div>`;
  return `<div class="wd-confirm" id="wdConfirmBox" role="group" aria-labelledby="wdcH">
    <h3 class="wd-confirm-h" id="wdcH">Confirm withdrawal</h3>
    <dl class="wd-sum">
      ${row("You receive", `${esc(eth(amount, 9))}&nbsp;${esc(sym())}`, "total")}
      ${fee != null ? row("Network fee", `+${esc(eth(fee, 9))}&nbsp;${esc(sym())}`) : ""}
      ${fee != null ? row("Taken from your balance", `${esc(eth(amount + fee, 9))}&nbsp;${esc(sym())}`) : ""}
      ${row("To", `<span title="${esc(to)}">${esc(short(to))}</span>`)}
    </dl>
    <p class="dg-note">The ${esc(sym())} is sent on-chain to the wallet you signed in with, and the network fee is charged on top. A sent withdrawal cannot be reversed.</p>
    <div class="wd-acts">
      <button type="submit" class="dg-btn primary" id="wdConfirmBtn"><span>Confirm withdrawal</span></button>
      <button type="button" class="dg-btn" id="wdEdit" data-act="wd-edit"><span>Change amount</span></button>
    </div>
  </div>`;
}

export const views = {
  /* ------------------------------------------------------------------ wallet */
  wallet(ctx) {
    const { S, h } = ctx; const { esc, eth, sym, short } = h;
    const me = S.me, w = S.wallet, cfg = S.cfg, real = h.real();
    const lim = (w && w.limits) || (cfg && cfg.withdrawal) || null;
    const conf = w ? w.chain.confirmations : 1;
    const chain = w ? w.chain.name : h.chainName();
    let minDep = minDepositOf(S), fee = withdrawFeeOf(S);
    if (minDep != null && minDep <= 0n) minDep = null;      // "0" means no minimum: nothing to say
    if (fee != null && fee <= 0n && !real) fee = null;       // a zero fee on a test network is not worth a line
    const r = me.responsible || {};
    const limitLine = r.lossLimit ? `Daily loss limit ${eth(r.lossLimit)}&nbsp;${esc(sym())}, lost today ${eth(r.lossToday || 0)}&nbsp;${esc(sym())}.` : "No daily loss limit is set.";
    const head = real
      ? header("Wallet", `Your play balance on ${esc(chain)}. This is real ${esc(sym())}: deposits and withdrawals are on-chain transactions.`)
      : header("Wallet", `Your play balance on ${esc(w ? chain : "the test network")}. Test ${esc(sym())} only, with no real-world value.`);
    const limits = real ? `<p class="dg-note wl-limits" id="wlLimits"><a href="#settings" data-go="settings">Play within your limits</a>. ${limitLine}</p>` : "";
    const addr = w ? w.depositAddress : "";
    const addrUrl = explorerUrl(S, "address", addr);
    const dep = (w && w.deposit) || {};
    const waiting = toWei(first(dep.pending, me.balances.pendingDeposit)) || 0n, missing = toWei(dep.remaining);
    const pend = S.ui.wdPending;

    /* deposit: amount picker, the one primary action, what happens next, and the manual route (the address) */
    const m = w ? depositModel(S, h) : null;
    const busy = m && (S.depositing || S.ui.depBusy);
    const amtTitle = m && m.min != null ? `Below the minimum deposit of ${eth(m.min, 9)} ${sym()}` : "";
    const chip = (v) => { const off = !m.enabled.includes(v); return `<button type="button" class="dg-chip dg-mono" data-act="dep-amt" data-v="${v}" aria-pressed="${m.sel === v}"${off ? ` disabled title="${esc(amtTitle)}"` : ""}>${v}</button>`; };
    const customRow = m && m.sel === "custom" ? `<div class="dep-custom">
        <label class="sr-only" for="depCustom">Custom amount (${esc(sym())})</label>
        <div class="dep-custom-in"><input id="depCustom" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0.05" value="${esc(S.ui.depCustom || "")}" aria-describedby="depHint depErr" aria-invalid="${m.err ? "true" : "false"}"><span class="unit">${esc(sym())}</span></div>
        <p class="dg-note" id="depHint">${m.min != null ? `Minimum ${eth(m.min, 9)}&nbsp;${esc(sym())}, ` : "Up to "}${m.min != null ? "up to " : ""}${m.maxEth}&nbsp;${esc(sym())} at a time.</p>
        <div class="err" id="depErr" aria-live="polite">${esc(m.err)}</div>
      </div>` : "";
    const goBusy = S.depositing ? `Depositing ${esc(S.depositing)} test ${esc(sym())}…` : S.ui.depBusy ? esc(S.ui.depBusy) : "";
    const goBtn = !m ? "" : m.faucet
      ? `<button type="button" class="dg-btn primary dep-go" data-act="faucet" data-eth="${m.amount != null ? esc(window.ethers.formatEther(m.amount)) : ""}" id="faucetBtn"${busy || m.amount == null ? " disabled" : ""}><span>${busy ? goBusy : depLabel(m, h)}</span></button>`
      : `<button type="button" class="dg-btn primary dep-go" data-act="dep-send" id="depositBtn"${busy || m.amount == null ? " disabled" : ""}><span>${busy ? goBusy : depLabel(m, h)}</span></button>`;
    const sent = w ? sentOf(S) : null;
    const sentLive = sent && !(w.deposits || []).some((d) => sameHash(d.txHash, sent.hash));
    const sentUrl = sentLive ? explorerUrl(S, "tx", sent.hash) : "";
    const sentN = sentLive ? Math.min(Number(sent.conf) || 0, conf) : 0;
    const sentCard = sentLive ? `<div class="dep-sent" id="depSent" role="status">
        <div class="dep-sent-h">${icon("clock")}<span>Deposit sent</span></div>
        <p class="dep-sent-t"><b class="dg-mono">${eth(sent.amount, 9)}&nbsp;${esc(sym())}</b> is on its way to your deposit address.</p>
        <div class="meter-bar" role="img" aria-label="${sentN} of ${conf} confirmations"><i style="width:${Math.round((sentN / conf) * 100)}%"></i></div>
        <p class="dg-note" id="depSentConf">Waiting for ${conf} confirmation${conf > 1 ? "s" : ""}${etaText(S, conf) ? `, ${etaText(S, conf)}` : ""}.${sentN > 0 ? ` ${sentN} of ${conf} so far.` : ""} You can leave this page: your balance updates by itself once it is credited.</p>
        <span class="tx-ref"><span class="tx-hash dg-mono" title="${esc(sent.hash)}">${esc(short(sent.hash))}</span>
          <button type="button" class="tx-btn" data-act="copy-tx" data-v="${esc(sent.hash)}" aria-label="Copy transaction hash" title="Copy transaction hash">${icon("copy")}</button>
          ${sentUrl ? `<a class="tx-btn" id="depSentLink" href="${esc(sentUrl)}" target="_blank" rel="noopener" aria-label="View transaction on the explorer" title="View on the explorer">${icon("link")}</a>` : ""}</span>
      </div>` : "";
    const msg = S.ui.depMsg ? `<div class="notice${S.ui.depMsg.warn ? " warn" : ""}" id="depMsg" role="status">${icon("shield")}<span>${esc(S.ui.depMsg.text)}</span></div>` : "";
    const eta = etaText(S, conf);
    return `${head}${limits}
    <section class="ledger ledger-3" aria-label="Balances">
      ${stat("Available", eth(me.balances.available), esc(sym()), { id: "balAvail", live: true })}
      ${stat("In play", eth(me.balances.inPlay), "staked in matches")}
      ${stat("Withdrawing", eth(me.balances.pendingWithdrawal), "on its way out")}
    </section>
    ${w ? `<section class="sec" aria-labelledby="hDep">
      <div class="sec-h"><h2 class="dg-h" id="hDep">Deposit</h2><p>${real ? `Add ${esc(sym())} to your play balance, straight from your wallet or to your personal deposit address.` : `Add test ${esc(sym())} to your play balance.`}</p></div>
      <div class="sec-b">
        ${waiting > 0n ? `<div class="notice" role="status" id="depPending">${icon("clock")}<span><b class="dg-mono">${eth(waiting, 9)}&nbsp;${esc(sym())}</b> has arrived but is not credited yet, because it is below the minimum deposit.${missing != null && missing > 0n ? ` Send at least <b class="dg-mono">${eth(missing, 9)}&nbsp;${esc(sym())}</b> more to the same address and everything is credited together.` : ""}</span></div>` : ""}
        ${sentCard}
        <div class="field"><span class="label" id="depAmtL">Amount (${m.faucet ? "test " : ""}${esc(sym())})</span>
          <div class="chips dep-amts" role="group" aria-labelledby="depAmtL">${m.presets.map(chip).join("")}<button type="button" class="dg-chip" data-act="dep-amt" data-v="custom" aria-pressed="${m.sel === "custom"}">Custom</button></div>
          ${m.enabled.length < m.presets.length ? `<p class="dg-note" id="depMinNote">Amounts below the minimum deposit of ${eth(m.min, 9)}&nbsp;${esc(sym())} are not available.</p>` : ""}
          ${customRow}</div>
        <div class="dep-acts">${goBtn}</div>
        ${msg}
        <div class="dep-next" aria-labelledby="depNextH">
          <h3 class="dep-sub-h" id="depNextH">What happens next</h3>
          <ul class="notes" id="depNotes">
            ${minDep != null ? `<li>Minimum deposit: <b class="dg-mono">${eth(minDep, 9)}&nbsp;${esc(sym())}</b>. A smaller deposit waits until your deposits at this address add up to the minimum, and is credited then.</li>` : ""}
            <li>Your deposit is credited after ${conf} confirmation${conf > 1 ? "s" : ""}${eta ? `, ${eta} on ${esc(chain)}` : ""}. Until then it shows as confirming below.</li>
            ${m.faucet ? `<li>Deposit sends free test ${esc(sym())} from the test faucet to your deposit address. It counts once it is confirmed, like any deposit.</li>`
              : `<li>Deposit asks your wallet to send ${esc(sym())} on ${esc(chain)} from <span class="dg-mono" title="${esc(me.address)}">${esc(short(me.address))}</span>, the account you signed in with. You approve it in the wallet.</li>`}
            <li>Send ${real ? esc(sym()) : `test ${esc(sym())}`} from a normal wallet, not a smart-contract wallet.</li>
          </ul>
        </div>
        <div class="dep-manual" aria-labelledby="depManH">
          <h3 class="dep-sub-h" id="depManH">Or send it yourself</h3>
          <div class="field"><span class="label">Your deposit address on ${esc(chain)}</span>
            <div class="mono-box" id="depositAddr" data-test="deposit-address">${esc(addr)}</div></div>
          <div class="notice${real ? " warn" : ""}" role="note" id="depWarn">${icon("shield")}<span><b>Send only ${real ? "" : "test "}${esc(sym())} on ${esc(chain)}.</b> Other tokens or networks are lost.</span></div>
          <div class="dep-acts">
            <button type="button" class="dg-btn ghost sm" data-act="copy" id="copyAddr"><span>Copy address</span></button>
            ${addrUrl ? `<a class="dg-btn ghost sm" href="${esc(addrUrl)}" target="_blank" rel="noopener" id="addrExplorer"><span>View on explorer</span></a>` : ""}
          </div>
        </div>
      </div>
    </section>

    <section class="sec" aria-labelledby="hWd">
      <div class="sec-h"><h2 class="dg-h" id="hWd">Withdraw</h2><p>${real ? `Send ${esc(sym())} back to your own wallet on ${esc(chain)}. The network fee is charged on top of the amount.` : `Send test ${esc(sym())} back to your own wallet.`}</p></div>
      ${me.hasWallet === false ? linkWalletHTML() : `<form data-form="withdraw" class="sec-b form-stack" autocomplete="off">
        <div class="field"><label for="wdAmt">Amount (${esc(sym())})</label>
          <div class="inline-form"><input id="wdAmt" type="text" inputmode="decimal" placeholder="${lim ? esc(eth(lim.min)) : "0.01"}" value="${esc(pend || "")}"${pend ? " readonly" : ""} aria-describedby="wdHint wdErr"><button class="dg-btn" type="button" data-act="wd-max" id="wdMax"${pend ? " disabled" : ""}>Max</button><button class="dg-btn" type="submit" id="wdBtn"${pend ? " disabled" : ""}>Withdraw</button></div></div>
        <div class="err" id="wdErr" role="alert"></div>
        <div id="wdConfirmSlot">${pend ? wdConfirmHTML(ctx, pend) : ""}</div>
        <p class="dg-note" id="wdHint">${lim ? `Minimum ${eth(lim.min)}&nbsp;${esc(sym())}, up to ${eth(lim.max)} per withdrawal and ${eth(lim.dailyCap)} per day. ` : ""}${fee != null ? `Network fee: <b class="dg-mono">${eth(fee, 9)}&nbsp;${esc(sym())}</b>, charged on top of the amount. ` : real ? "A network fee is charged on top of every withdrawal. " : ""}Payouts go only to the wallet you signed in with: <span class="dg-mono" title="${esc(w.withdrawTo)}">${esc(short(w.withdrawTo))}</span>.</p>
      </form>`}
    </section>

    ${txSection(S, h)}` : `<section class="sec"><div class="sec-h"><h2 class="dg-h">Wallet</h2></div><div class="sec-b"><p class="dg-note">The wallet is not enabled on this server.</p></div></section>`}`;
  },

  /* ------------------------------------------------------------------ history */
  history(ctx) {
    const { S, h } = ctx; const { esc, eth, sym, ago } = h;
    const head = header("History", `Your last 30 matches. Every finished match reveals its seed so you can replay and check it.`);
    if (S.history == null) {
      return `${head}<div class="ledger ledger-2 ledger-hist" aria-hidden="true">${Array.from({ length: 2 }, () => `<div class="dg-stat"><span class="skel hs-skel"></span></div>`).join("")}</div>
        <section class="hist-wrap" aria-busy="true"><span class="sr-only">Loading history</span><ul class="hist" aria-hidden="true">${Array.from({ length: 4 }, () => `<li class="hrow-skel"><span class="skel"></span></li>`).join("")}</ul></section>`;
    }
    const done = S.history.filter((m) => m.result);
    // win/loss record and streaks are shown per opponent and game, not summed across everything here
    let v = 0, net = 0n;
    for (const m of done) { if (m.result === "void") v++; net += netOf(m); }
    const strip = `<section class="ledger ledger-2 ledger-hist" aria-label="Summary of your matches">
      ${stat("Played", done.length - v, v ? `${v} cancelled` : "finished matches")}
      ${stat("Net", sign(net, eth), `${esc(sym())} in this list`, { cls: cls(net) })}
    </section>`;
    if (!done.length) {
      return `${head}${strip}<p class="acc-empty">No matches yet. Your finished matches will be listed here with scores, rating changes and the seed for each one. <a href="#lobby" data-go="lobby">Create a lobby</a></p>`;
    }
    const rows = done.map((m) => {
      const you = m.you || {}, opp = m.opponent || {};
      const net = netOf(m), staked = BigInt(m.stake || 0) > 0n;
      const dr = you.ratingAfter != null && you.ratingBefore != null ? you.ratingAfter - you.ratingBefore : null;
      const label = (m.game && m.game.scoreLabel) || "score";
      return `<li class="hrow ${esc(m.result)}">
        <div class="h-who"><span class="h-ava">${avatar(opp.address || opp.name, 36)}</span><div><b title="${esc(m.game ? m.game.name : "Game")}">${esc(m.game ? m.game.name : "Game")}</b><span class="sub">vs <span class="h-opp" title="${esc(opp.name || "Opponent")}">${esc(opp.name || "Opponent")}</span>${m.private ? ` <span class="h-tag">private</span>` : ""}</span></div></div>
        <div class="h-res"><span class="rpill ${esc(m.result)}">${esc(RESULT_LABEL[m.result] || m.result)}</span></div>
        <div class="h-score dg-mono" title="Your ${esc(label)} against theirs"><b>${you.score != null ? esc(you.score) : "–"}</b><i>vs</i><span>${opp.score != null ? esc(opp.score) : "–"}</span></div>
        <div class="h-net"><b class="dg-mono ${staked ? cls(net) : "dg-muted"}">${staked ? sign(net, eth) + "&nbsp;" + esc(sym()) : "Free play"}</b>${dr != null && dr !== 0 ? `<span class="sub dg-mono ${dr > 0 ? "dg-good" : "dg-bad"}">${dr > 0 ? "+" : "−"}${Math.abs(dr)} rating</span>` : `<span class="sub">${dr === 0 ? "rating unchanged" : ""}</span>`}</div>
        <div class="h-when sub" title="${esc(when(m.settledAt))}">${m.settledAt ? esc(ago(m.settledAt)) : ""}</div>
        <div class="h-proof sub dg-mono">Match #${esc(m.id)}${m.seed != null ? ` · seed ${esc(m.seed)}` : ""}${m.result === "void" && m.reason ? ` · ${esc(m.reason)}` : ""}</div>
      </li>`;
    }).join("");
    return `${head}${strip}<section class="hist-wrap" aria-labelledby="hHl"><h2 class="dg-h sr-only" id="hHl">Finished matches</h2>
      <div class="t-label hist-head" aria-hidden="true"><span>Match</span><span>Result</span><span>Score</span><span>Net</span><span class="r">When</span></div>
      <ul class="hist" aria-label="Match history">${rows}</ul></section>`;
  },

  /* ------------------------------------------------------------------ responsible play */
  settings(ctx) {
    const { S, h } = ctx; const { esc, eth, sym } = h;
    const me = S.me, r = me.responsible;
    const limit = r.lossLimit ? BigInt(r.lossLimit) : null;
    const lost = BigInt(r.lossToday || 0);
    const pct = limit && limit > 0n ? Math.min(100, Number((lost * 100n) / limit)) : 0;
    const real = h.real(), ac = r.adultConfirmed;
    const intro = real
      ? `Tools to keep play fun and in check. They are real controls and they apply to every staked match. Stakes are real ${esc(sym())} on ${esc(h.chainName())}, so set a limit you are comfortable losing.`
      : `Tools to keep play fun and in check. They are real controls, and they work the same way when you play for stakes. Everything here is test ${esc(sym())}, with no real money.`;
    return `${header("Account", intro)}
    <section class="sec" aria-labelledby="hAcct">
      <div class="sec-h"><h2 class="dg-h" id="hAcct">Your account</h2></div>
      <div class="sec-b">
        <div class="acct-card"><span class="acct-ava">${avatar(me.address || me.email, 56)}</span><div><b>${esc(me.displayName)}</b><span class="dg-mono sub" title="${esc(me.address || me.email || "")}">${esc(me.address ? h.short(me.address) : me.email || "")}</span></div></div>
        <form class="form-stack" data-name-form autocomplete="off">
          <div class="field"><label for="nameIn">Display name</label>
            <div class="inline-form"><input id="nameIn" type="text" maxlength="20" value="${esc(me.displayName)}" aria-describedby="nameHint nameErr"><button class="dg-btn" type="submit" id="nameBtn">Save</button></div></div>
          <div class="err" id="nameErr" role="alert"></div>
          <p class="dg-note" id="nameHint">3 to 20 characters: letters, numbers, spaces, dot, dash or underscore. Other players see this name.</p>
        </form>
        <div><button class="dg-btn danger" data-act="logout"><span>Sign out</span></button></div>
      </div>
    </section>

    <section class="sec" aria-labelledby="hLim">
      <div class="sec-h"><h2 class="dg-h" id="hLim">Daily loss limit</h2>
        <p>The most you can lose in a day. Once you reach it, staked play pauses until the day resets. Lowering it applies straight away. Raising or removing it takes 24 hours, so a bad moment cannot undo it.</p></div>
      <div class="sec-b">
        <div class="ledger ledger-2" aria-label="Your limit today">
          ${stat("Current limit", limit ? `${eth(limit)}` : "Off", limit ? esc(sym()) : "")}
          ${stat("Lost today", eth(lost), esc(sym()), { cls: lost > 0n ? "dg-bad" : "" })}
        </div>
        ${limit ? `<div class="meter-bar" role="img" aria-label="${pct}% of the daily limit used"><i style="width:${pct}%" class="${pct >= 100 ? "full" : pct >= 75 ? "high" : ""}"></i></div>` : ""}
        ${r.pending ? `<div class="notice" role="status">${icon("clock")}<span>Change pending: ${r.pending.lossLimit ? `limit becomes ${eth(r.pending.lossLimit)} ${esc(sym())}` : "limit turns off"} on ${esc(when(r.pending.effectiveAt))}.</span></div>` : ""}
        <form data-form="limit" class="form-stack" autocomplete="off">
          <div class="field"><label for="limitAmt">${limit ? "Change limit" : "Set a limit"} (${esc(sym())} per day)</label>
            <div class="inline-form"><input id="limitAmt" type="text" inputmode="decimal" placeholder="0.02" aria-describedby="limErr"><button class="dg-btn primary" type="submit" id="limBtn">${limit ? "Update limit" : "Set limit"}</button></div></div>
          <div class="err" id="limErr" role="alert"></div>
        </form>
        ${limit || r.pending ? `<div><button class="dg-btn" type="button" data-act="limit-off">Turn off the limit</button></div>` : ""}
      </div>
    </section>

    <section class="sec" aria-labelledby="hAge">
      <div class="sec-h"><h2 class="dg-h" id="hAge">Age confirmation</h2>
        <p>Staked play is for players aged 18 or over. You confirm once, before your first staked match. Free play never needs it.</p></div>
      <div class="sec-b">
        <div class="age-status" id="ageStatus" data-confirmed="${ac === true ? "yes" : ac === false ? "no" : "unknown"}">
          ${ac === true ? `<span class="rpill win">Confirmed</span><span>You have confirmed that you are 18 or older.</span>`
            : `<span class="rpill draw">Not confirmed</span><span>${ac === false ? "You will be asked before your first staked match." : "You will be asked when you first play for a stake."}</span>`}
        </div>
        ${ac === true ? "" : `<div><button class="dg-btn" type="button" id="ageOpen" data-act="age-open"><span>Confirm now</span></button></div>`}
      </div>
    </section>`;
  },
};

/* ---------------------------------------------------------------------- hooks */

let appRef = null;
export function mount(view, app) {
  appRef = app;
  if (view !== "wallet") return;
  syncSent(app);
  trackSent(app);
}

/* ---- depositing from the browser wallet */
const hex = (n) => "0x" + BigInt(n).toString(16);
const errCode = (e) => e && (e.code ?? (e.error && e.error.code) ?? (e.info && e.info.error && e.info.error.code));
const rejected = (e) => errCode(e) === 4001 || errCode(e) === "ACTION_REJECTED" || /user (rejected|denied)|rejected the request/i.test(String((e && e.message) || ""));
/* an expected stop (wrong network, wrong account, cancelled): shown as a calm message under the button, not as an error */
class Soft extends Error { constructor(text, warn = true) { super(text); this.warn = warn; } }

/* Switch the wallet to the right network and account, then ask it to send `amount` to the player's own deposit address.
   Nothing is sent unless the player approves it in the wallet. */
async function sendFromWallet(app) {
  const { S, h } = app;
  if (S.ui.depBusy || S.depositing || !S.wallet) return;
  const m = depositModel(S, h);
  if (m.faucet || m.amount == null) return;
  const w = S.wallet, chain = S.cfg.chain, name = (w.chain && w.chain.name) || chain.name, sym = h.sym(), eth = window.ethereum;
  const busy = (t) => { S.ui.depBusy = t; app.render(true); };
  S.ui.depMsg = null;
  try {
    if (!eth) throw new Soft("No browser wallet found. Open this page in a wallet browser, or install a wallet such as MetaMask, then reload.");
    if (!window.ethers.isAddress(w.depositAddress)) throw new Soft("Your deposit address could not be read. Reload the page and try again.");
    busy("Checking your wallet…");
    const want = BigInt(chain.id);
    if (BigInt(await eth.request({ method: "eth_chainId" })) !== want) {
      busy(`Switch to ${name} in your wallet…`);
      try { await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex(want) }] }); }
      catch (e) {
        if (errCode(e) === 4902) throw new Soft(`Your wallet does not know ${name} yet. Add the network in your wallet, then try again.`);
        if (rejected(e)) throw new Soft("The network switch was cancelled. Nothing was sent.", false);
        throw e;
      }
      if (BigInt(await eth.request({ method: "eth_chainId" })) !== want) throw new Soft(`Your wallet is still on another network. Switch it to ${name} and try again.`);
    }
    let accounts = await eth.request({ method: "eth_accounts" });
    if (!accounts || !accounts.length) accounts = await eth.request({ method: "eth_requestAccounts" });
    const from = accounts && accounts[0];
    if (S.me.address && (!from || from.toLowerCase() !== String(S.me.address).toLowerCase())) { // an email account without a wallet may deposit from any wallet
      throw new Soft(`Your wallet has ${from ? h.short(from) : "no account"} selected. Switch it to ${h.short(S.me.address)}, the account you signed in with, and try again.`);
    }
    busy("Confirm in your wallet…");
    const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: w.depositAddress, value: hex(m.amount) }] });
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Soft("Your wallet did not report a transaction. Check its activity list before you try again.");
    setSent(S, { hash, amount: m.amount.toString(), at: h.now(), conf: 0 });
    const N = w.chain.confirmations || 1;
    app.toast(`Deposit of ${h.eth(m.amount, 9)} ${sym} sent. Waiting for ${N} confirmation${N > 1 ? "s" : ""}.`, "good");
  } catch (e) {
    const text = String((e && e.message) || e);
    S.ui.depMsg = e instanceof Soft ? { text, warn: e.warn }
      : rejected(e) ? { text: "You closed the request in your wallet. Nothing was sent.", warn: false }
      : errCode(e) === -32002 ? { text: "Your wallet already has a request waiting. Open it, approve or reject it, then try again.", warn: true }
      : /insufficient funds/i.test(text) ? { text: `Your wallet does not have enough ${sym} for this amount plus the network fee. Try a smaller amount.`, warn: true }
      : { text: `The deposit could not be sent: ${text.slice(0, 160)}`, warn: true };
  } finally {
    S.ui.depBusy = null;
    app.render(true);
  }
}

/* The server lists a deposit only once it is `confirmations` deep, and then it owns it: drop our own copy and say what happened. */
function syncSent(app) {
  const { S, h } = app, sent = S.wallet && sentOf(S);
  if (!sent) return;
  const d = (S.wallet.deposits || []).find((x) => sameHash(x.txHash, sent.hash));
  if (!d) return;
  setSent(S, null);
  if (depState(d) === "credited") app.toast(`Deposit credited: +${h.eth(d.amount, 9)} ${h.sym()}.`, "good");
  else app.toast(`Your deposit of ${h.eth(d.amount, 9)} ${h.sym()} arrived, but it is below the minimum, so it is not credited yet.`, "gold");
  app.render(true);
}

/* While a sent deposit is waiting, ask the wallet how deep it is (for "n / N") and, once it should be listed, refresh the wallet. The server's
   wallet.updated event normally does that first; this is the fallback. One loop at a time, and it stops when the page is left. */
let tracking = false;
function trackSent(app) {
  const { S } = app;
  if (tracking || !sentOf(S)) return;
  tracking = true;
  const tick = async () => {
    const sent = sentOf(S);
    if (!sent || S.view !== "lobby" || S.tab !== "wallet" || !S.wallet) { tracking = false; return; }
    try {
      let conf = 0;
      const eth = window.ethereum;
      const rc = eth && await eth.request({ method: "eth_getTransactionReceipt", params: [sent.hash] });
      if (rc && rc.blockNumber) conf = Math.max(0, Number(BigInt(await eth.request({ method: "eth_blockNumber" })) - BigInt(rc.blockNumber) + 1n));
      if (conf !== sent.conf) { setSent(S, { ...sent, conf }); app.render(); }
      if (conf >= (S.wallet.chain.confirmations || 1)) { await app.refreshWallet(); app.render(); }
    } catch { /* the wallet cannot say: the server lists the deposit once it is deep enough */ }
    setTimeout(tick, 6000);
  };
  setTimeout(tick, 4000);
}

/* a custom amount is checked as it is typed; only the error line and the button are patched, so the field keeps focus and the caret */
function patchDeposit(app) {
  const { S, h } = app, m = depositModel(S, h);
  const err = document.getElementById("depErr"), inp = document.getElementById("depCustom"), btn = document.querySelector(".dep-go");
  if (err) err.textContent = m.err;
  if (inp) inp.setAttribute("aria-invalid", m.err ? "true" : "false");
  if (btn && !S.depositing && !S.ui.depBusy) {
    btn.disabled = m.amount == null;
    if (m.faucet) btn.dataset.eth = m.amount != null ? window.ethers.formatEther(m.amount) : "";
    const span = btn.querySelector("span"); if (span) span.innerHTML = depLabel(m, h);
  }
  const msg = document.getElementById("depMsg"); if (msg) msg.remove();
}
export function onInput(e, app) {
  if (!e.target || e.target.id !== "depCustom") return false;
  app.S.ui.depCustom = e.target.value;
  app.S.ui.depMsg = null;
  patchDeposit(app);
  return true;
}
/* Enter in the custom amount deposits, like the button */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target || e.target.id !== "depCustom") return;
  e.preventDefault();
  const btn = document.querySelector(".dep-go");
  if (btn && !btn.disabled) btn.click();
});

const focusAfter = (sel) => { const el = document.querySelector(sel); if (el) el.focus(); };

export const actions = {
  /* deposit amount on the wallet page: a preset, or "custom" (shows the amount field) */
  "dep-amt": async (el, app) => {
    app.S.ui.depAmt = el.dataset.v; app.S.ui.depMsg = null;
    app.render(true);
    focusAfter(el.dataset.v === "custom" ? "#depCustom" : `[data-act="dep-amt"][data-v="${el.dataset.v}"]`);
  },
  /* the primary Deposit button when there is no faucet: send from the browser wallet */
  "dep-send": async (el, app) => sendFromWallet(app),
  "tx-filter": async (el, app) => { app.S.ui.txFilter = el.dataset.v; app.S.ui.txLimit = TX_PAGE; app.render(true); focusAfter(`[data-act="tx-filter"][data-v="${el.dataset.v}"]`); },
  "tx-more": async (el, app) => { app.S.ui.txLimit = (app.S.ui.txLimit || TX_PAGE) + TX_PAGE; app.render(true); focusAfter("#txMore"); },
  "copy-tx": async (el, app) => {
    try { await navigator.clipboard.writeText(el.dataset.v); app.toast("Transaction hash copied.", "good"); }
    catch { app.toast("Select the hash and copy it.", ""); }
  },
  /* back from the confirm step to the amount */
  "wd-edit": async (el, app) => { closeWdConfirm(app); const i = document.getElementById("wdAmt"); if (i) i.focus(); },
  /* fill the withdraw box with the most the player can take out in one go (their balance, capped by the per-withdrawal maximum) */
  "wd-max": async (el, app) => {
    const { S, h } = app;
    let amt = BigInt(S.me.balances.available || 0);
    const fee = withdrawFeeOf(S);
    if (fee != null) amt = amt > fee ? amt - fee : 0n; // the network fee is charged on top of the amount
    const cap = S.cfg && S.cfg.withdrawal && S.cfg.withdrawal.max ? BigInt(S.cfg.withdrawal.max) : null;
    if (cap != null && amt > cap) amt = cap;
    const inp = document.getElementById("wdAmt");
    if (inp) { inp.value = amt > 0n ? window.ethers.formatEther(amt) : ""; inp.focus(); }
  },
};

/* the withdraw form's confirm step is shown in place (no page render), and closed again by app.js after the request answers */
export function showWdConfirm(app, typed) {
  const { S } = app;
  S.ui.wdPending = typed;
  const fee = withdrawFeeOf(S);
  S.ui.wdFee = fee != null ? fee.toString() : null; // sent as maxFee: the server refuses (FEE_CHANGED) if the fee went up since this was shown
  const slot = document.getElementById("wdConfirmSlot"), inp = document.getElementById("wdAmt");
  if (!slot) return;
  slot.innerHTML = wdConfirmHTML(app.ctx, typed);
  if (inp) inp.readOnly = true;
  for (const id of ["wdBtn", "wdMax"]) { const b = document.getElementById(id); if (b) b.disabled = true; }
  const ok = document.getElementById("wdConfirmBtn"); if (ok) ok.focus();
}
export function closeWdConfirm(app) {
  app.S.ui.wdPending = null; app.S.ui.wdFee = null;
  const slot = document.getElementById("wdConfirmSlot"), inp = document.getElementById("wdAmt");
  if (slot) slot.innerHTML = "";
  if (inp) inp.readOnly = false;
  for (const id of ["wdBtn", "wdMax"]) { const b = document.getElementById(id); if (b) b.disabled = false; }
}

/* display-name form: the core owns [data-form], so this one uses its own marker and handler */
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-name-form]");
  if (!form) return;
  e.preventDefault();
  const app = appRef;
  if (!app) return;
  const err = document.getElementById("nameErr"), btn = document.getElementById("nameBtn");
  err.textContent = "";
  btn.disabled = true;
  try {
    const r = await app.api("PATCH", "/v1/me", { displayName: document.getElementById("nameIn").value });
    app.toast(`Display name saved: ${r.displayName}`, "good");
    await app.refreshMe();
    app.render(true);
  } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
});

/* first press of Withdraw on a network that charges a fee (or real money): read the current fee, check the numbers, show the confirm step */
async function confirmStep(app, typed, inp, err) {
  const { S, h } = app, btn = document.getElementById("wdBtn");
  err.textContent = "";
  if (btn) btn.disabled = true;
  try { await app.refreshWallet(); } catch { /* the last known fee is used */ }
  if (S.ui.wdPending != null) return; // already showing
  const fee = withdrawFeeOf(S);
  let amount = 0n;
  try { amount = window.ethers.parseEther(typed); } catch { if (btn) btn.disabled = false; return; }
  const avail = BigInt(S.me.balances.available || 0);
  const msg = fee == null && S.cfg.chain && S.cfg.chain.realMoney ? "The network fee cannot be estimated right now. Try again in a moment."
    : fee != null && amount + fee > avail ? `Your balance must cover the amount plus the network fee of ${h.eth(fee, 9)} ${h.sym()}.` : "";
  if (msg) { err.textContent = msg; inp.setAttribute("aria-invalid", "true"); inp.focus(); if (btn) btn.disabled = false; return; }
  showWdConfirm(app, typed);
}

/* amount check for the core's withdraw and loss-limit forms, before app.js submits them: ethers' parse errors are not for people */
document.addEventListener("submit", (e) => {
  const form = e.target.closest('[data-form="withdraw"],[data-form="limit"]');
  if (!form) return;
  const inp = form.querySelector("input"), err = form.querySelector(".err");
  if (!inp || !err) return;
  const v = inp.value.trim();
  const msg = !v ? "Enter an amount." : !/^(\d+\.?\d*|\.\d+)$/.test(v) ? "Enter a number, like 0.05." : /^[0.]+$/.test(v) ? "Enter an amount above 0."
    : (v.split(".")[1] || "").length > 18 ? "Use at most 18 decimal places." : "";
  inp.setAttribute("aria-invalid", msg ? "true" : "false");
  if (!msg) {
    /* a withdrawal first shows its confirm step (amount, network fee, what arrives); the Confirm button sends it */
    if (form.dataset.form === "withdraw" && appRef && !(e.submitter && e.submitter.id === "wdConfirmBtn") && needsConfirm(appRef.S)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      confirmStep(appRef, v, inp, err);
    }
    return;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
  err.textContent = msg;
  inp.focus();
}, true);
