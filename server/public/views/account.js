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

function header(title, text) {
  return `<header class="page-h"><h1>${title}</h1><p>${text}</p></header>`;
}

/* one figure of a ledger band: small uppercase label, a large serif numeral, a quiet unit. Pass id for a number the tests read. */
const stat = (label, value, unit, { id = "", cls: c = "", live = false } = {}) =>
  `<div class="dg-stat"><span class="stat-l">${label}</span><div class="stat-v"><b class="dg-mono ${c}"${id ? ` id="${id}"` : ""}${live ? ' aria-live="polite"' : ""}>${value}</b>${unit ? `<span class="unit">${unit}</span>` : ""}</div></div>`;

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
    const { S, h } = ctx; const { esc, eth, sym, short, ago } = h;
    const me = S.me, w = S.wallet, cfg = S.cfg, real = h.real();
    const wd = w && w.withdrawals ? w.withdrawals : [];
    const deps = w && w.deposits ? w.deposits : [];
    const depAmt = S.ui.depAmt || "1";
    const amtChip = (v) => `<button type="button" class="dg-chip dg-mono" data-act="dep-amt" data-v="${v}" aria-pressed="${depAmt === v}">${v}</button>`;
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
    /* a deposit is "credited", or "pending": seen on-chain but below the minimum so far (they are credited together once the total at the address reaches it) */
    const depState = (d) => (d.credited === true || String(d.status || "credited").toLowerCase() === "credited" ? "credited" : "pending");
    const dep = (w && w.deposit) || {};
    const waiting = toWei(first(dep.pending, me.balances.pendingDeposit)) || 0n, missing = toWei(dep.remaining);
    const depRow = (d) => {
      const st = depState(d), when = first(d.creditedAt, d.detectedAt, d.createdAt);
      const label = st === "credited" ? "credited" : "pending";
      const sub = st === "pending" ? `Below the minimum deposit${minDep != null ? ` of ${eth(minDep, 9)}&nbsp;${esc(sym())}` : ""}, so it is not credited yet.` : "";
      const tx = d.explorerUrl || explorerUrl(S, "tx", d.txHash);
      return `<div class="row wd-row">
        <div class="wd-main"><b class="dg-mono">${st === "credited" ? "+" : ""}${eth(d.amount, 9)}&nbsp;${esc(sym())}</b><span class="sub">${when != null ? esc(ago(when)) : ""}${d.blockNumber != null ? `${when != null ? " · " : ""}block ${esc(d.blockNumber)}` : ""}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</div>
        <div class="wd-side"><span class="rpill ${st === "credited" ? "win" : "draw"}">${label}</span>${tx ? `<a class="dg-link" href="${esc(tx)}" target="_blank" rel="noopener">View transaction</a>` : ""}</div>
      </div>`;
    };
    const pend = S.ui.wdPending;
    return `${head}${limits}
    <section class="ledger ledger-3" aria-label="Balances">
      ${stat("Available", eth(me.balances.available), esc(sym()), { id: "balAvail", live: true })}
      ${stat("In play", eth(me.balances.inPlay), "staked in matches")}
      ${stat("Withdrawing", eth(me.balances.pendingWithdrawal), "on its way out")}
    </section>
    ${w ? `<section class="sec" aria-labelledby="hDep">
      <div class="sec-h"><h2 class="dg-h" id="hDep">Deposit</h2><p>${real ? `Send ${esc(sym())} to your personal deposit address to add it to your play balance.` : `Add test ${esc(sym())} to your play balance.`}</p></div>
      <div class="sec-b">
        ${real ? `<div class="notice warn" role="note" id="depWarn">${icon("shield")}<span><b>Send only ${esc(sym())} on ${esc(chain)}.</b> Other tokens or networks are lost.</span></div>` : ""}
        ${waiting > 0n ? `<div class="notice" role="status" id="depPending">${icon("clock")}<span><b class="dg-mono">${eth(waiting, 9)}&nbsp;${esc(sym())}</b> has arrived but is not credited yet, because it is below the minimum deposit.${missing != null && missing > 0n ? ` Send at least <b class="dg-mono">${eth(missing, 9)}&nbsp;${esc(sym())}</b> more to the same address and everything is credited together.` : ""}</span></div>` : ""}
        ${cfg.devFaucet ? `<div class="field"><span class="label" id="depAmtL">Amount (test ${esc(sym())})</span>
          <div class="chips dep-amts" role="group" aria-labelledby="depAmtL">${amtChip("0.1")}${amtChip("0.5")}${amtChip("1")}</div></div>` : ""}
        <div class="field"><span class="label">Your deposit address on ${esc(chain)}</span>
          <div class="mono-box" id="depositAddr" data-test="deposit-address">${esc(addr)}</div></div>
        <div class="dep-acts">
          ${cfg.devFaucet ? `<button class="dg-btn primary" data-act="faucet" data-eth="${esc(depAmt)}" id="faucetBtn"${S.depositing ? " disabled" : ""}><span>${S.depositing ? `Depositing ${esc(S.depositing)} test ${esc(sym())}…` : `Deposit ${esc(depAmt)}&nbsp;${esc(sym())}`}</span></button>` : ""}
          <button class="dg-btn${cfg.devFaucet ? "" : " primary"}" data-act="copy" id="copyAddr"><span>Copy address</span></button>
          ${addrUrl ? `<a class="dg-btn" href="${esc(addrUrl)}" target="_blank" rel="noopener" id="addrExplorer"><span>View on explorer</span></a>` : ""}
        </div>
        <ul class="notes" id="depNotes">
          ${minDep != null ? `<li>Minimum deposit: <b class="dg-mono">${eth(minDep, 9)}&nbsp;${esc(sym())}</b>. A smaller deposit waits until your deposits at this address add up to the minimum, and is credited then.</li>` : ""}
          <li>Deposits are credited after ${conf} confirmation${conf > 1 ? "s" : ""}, so they can take a moment to show up.</li>
          <li>Send ${real ? esc(sym()) : `test ${esc(sym())}`} from a normal wallet, not a smart-contract wallet.</li>
          ${cfg.devFaucet ? `<li>Deposit sends free test ${esc(sym())} from the test faucet to this address. It counts once it is confirmed, like any deposit.</li>` : ""}
        </ul>
      </div>
    </section>

    <section class="sec" aria-labelledby="hWd">
      <div class="sec-h"><h2 class="dg-h" id="hWd">Withdraw</h2><p>${real ? `Send ${esc(sym())} back to your own wallet on ${esc(chain)}. The network fee is charged on top of the amount.` : `Send test ${esc(sym())} back to your own wallet.`}</p></div>
      <form data-form="withdraw" class="sec-b form-stack" autocomplete="off">
        <div class="field"><label for="wdAmt">Amount (${esc(sym())})</label>
          <div class="inline-form"><input id="wdAmt" type="text" inputmode="decimal" placeholder="${lim ? esc(eth(lim.min)) : "0.01"}" value="${esc(pend || "")}"${pend ? " readonly" : ""} aria-describedby="wdHint wdErr"><button class="dg-btn" type="button" data-act="wd-max" id="wdMax"${pend ? " disabled" : ""}>Max</button><button class="dg-btn" type="submit" id="wdBtn"${pend ? " disabled" : ""}>Withdraw</button></div></div>
        <div class="err" id="wdErr" role="alert"></div>
        <div id="wdConfirmSlot">${pend ? wdConfirmHTML(ctx, pend) : ""}</div>
        <p class="dg-note" id="wdHint">${lim ? `Minimum ${eth(lim.min)}&nbsp;${esc(sym())}, up to ${eth(lim.max)} per withdrawal and ${eth(lim.dailyCap)} per day. ` : ""}${fee != null ? `Network fee: <b class="dg-mono">${eth(fee, 9)}&nbsp;${esc(sym())}</b>, charged on top of the amount. ` : real ? "A network fee is charged on top of every withdrawal. " : ""}Payouts go only to the wallet you signed in with: <span class="dg-mono" title="${esc(w.withdrawTo)}">${esc(short(w.withdrawTo))}</span>.</p>
      </form>
    </section>

    <section class="sec" aria-labelledby="hDepl">
      <div class="sec-h"><h2 class="dg-h" id="hDepl">Recent deposits</h2></div>
      <div class="sec-b">${deps.length ? `<div class="list" aria-label="Recent deposits">${deps.slice(0, 10).map(depRow).join("")}</div>` : `<p class="dg-note">No deposits yet. Each deposit shows up here once it is confirmed and credited to your balance.</p>`}</div>
    </section>

    <section class="sec" aria-labelledby="hWdl">
      <div class="sec-h"><h2 class="dg-h" id="hWdl">Recent withdrawals</h2></div>
      <div class="sec-b">${wd.length ? `<div class="list" aria-label="Recent withdrawals">${wd.slice(0, 10).map((x) => { const xf = toWei(first(x.feeWei, x.fee)); const tx = x.explorerUrl || explorerUrl(S, "tx", x.txHash); return `<div class="row wd-row">
        <div class="wd-main"><b class="dg-mono">${eth(x.amount, 9)}&nbsp;${esc(sym())}</b><span class="sub">${esc(ago(x.createdAt))} · to <span title="${esc(x.to)}">${esc(short(x.to))}</span>${xf != null && xf > 0n ? ` · fee ${eth(xf, 9)}&nbsp;${esc(sym())}` : ""}</span>${x.status === "failed" && x.error ? `<span class="sub dg-bad">${esc(x.error)}</span>` : ""}</div>
        <div class="wd-side"><span class="rpill ${x.status === "confirmed" ? "win" : x.status === "failed" ? "loss" : "draw"}">${esc(x.status)}</span>${tx ? `<a class="dg-link" href="${esc(tx)}" target="_blank" rel="noopener">View transaction</a>` : ""}</div>
      </div>`; }).join("")}</div>` : `<p class="dg-note">No withdrawals yet. When you withdraw, each one shows up here with its status and a link to the transaction.</p>`}</div>
    </section>` : `<section class="sec"><div class="sec-h"><h2 class="dg-h">Wallet</h2></div><div class="sec-b"><p class="dg-note">The wallet is not enabled on this server.</p></div></section>`}`;
  },

  /* ------------------------------------------------------------------ history */
  history(ctx) {
    const { S, h } = ctx; const { esc, eth, sym, ago } = h;
    const head = header("History", `Your last 30 matches. Every finished match reveals its seed so you can replay and check it.`);
    if (S.history == null) {
      return `${head}<div class="ledger ledger-4" aria-hidden="true">${Array.from({ length: 4 }, () => `<div class="dg-stat"><span class="skel hs-skel"></span></div>`).join("")}</div>
        <section class="hist-wrap" aria-busy="true"><span class="sr-only">Loading history</span><ul class="hist" aria-hidden="true">${Array.from({ length: 4 }, () => `<li class="hrow-skel"><span class="skel"></span></li>`).join("")}</ul></section>`;
    }
    const done = S.history.filter((m) => m.result);
    let w = 0, l = 0, d = 0, v = 0, net = 0n, best = 0, run = 0;
    for (const m of done) { if (m.result === "win") w++; else if (m.result === "loss") l++; else if (m.result === "draw") d++; else v++; net += netOf(m); }
    for (const m of [...done].reverse()) { if (m.result === "win") { run++; best = Math.max(best, run); } else if (m.result !== "void") run = 0; }
    const strip = `<section class="ledger ledger-4" aria-label="Summary of your matches">
      ${stat("Played", w + l + d, v ? `${v} cancelled` : "finished matches")}
      ${stat("Record", `<span class="dg-good">${w}</span><i>–</i><span class="dg-bad">${l}</span><i>–</i><span class="dg-gold">${d}</span>`, "wins, losses, draws")}
      ${stat("Net", sign(net, eth), `${esc(sym())} in this list`, { cls: cls(net) })}
      ${stat("Best streak", best, "wins in a row")}
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
    </section>

    <section class="sec" aria-labelledby="hAcct">
      <div class="sec-h"><h2 class="dg-h" id="hAcct">Your account</h2></div>
      <div class="sec-b">
        <div class="acct-card"><span class="acct-ava">${avatar(me.address, 56)}</span><div><b>${esc(me.displayName)}</b><span class="dg-mono sub" title="${esc(me.address)}">${esc(h.short(me.address))}</span></div></div>
        <form class="form-stack" data-name-form autocomplete="off">
          <div class="field"><label for="nameIn">Display name</label>
            <div class="inline-form"><input id="nameIn" type="text" maxlength="20" value="${esc(me.displayName)}" aria-describedby="nameHint nameErr"><button class="dg-btn" type="submit" id="nameBtn">Save</button></div></div>
          <div class="err" id="nameErr" role="alert"></div>
          <p class="dg-note" id="nameHint">3 to 20 characters: letters, numbers, spaces, dot, dash or underscore. Other players see this name.</p>
        </form>
        <div><button class="dg-btn danger" data-act="logout"><span>Sign out</span></button></div>
      </div>
    </section>`;
  },
};

/* ---------------------------------------------------------------------- hooks */

let appRef = null;
export function mount(view, app) { appRef = app; }

export const actions = {
  /* deposit amount on the wallet page (the faucet, local chain only, sends at most 1 test ETH per deposit) */
  "dep-amt": async (el, app) => { app.S.ui.depAmt = el.dataset.v; app.render(true); },
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
