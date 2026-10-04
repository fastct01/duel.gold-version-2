/* Shared view helpers. Every view module gets these as `h` (see app.js makeHelpers). Pure functions of their inputs. */

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function makeHelpers(S) {
  const { ethers } = window;
  /* wei (decimal string or BigInt) → "0.0015" trimmed to `max` decimals */
  const eth = (wei, max = 6) => {
    const s = ethers.formatEther(BigInt(wei || 0));
    const [i, f = ""] = s.split(".");
    const cut = f.slice(0, max).replace(/0+$/, "");
    return cut ? `${i}.${cut}` : i;
  };
  const sym = () => (S.cfg && S.cfg.chain ? S.cfg.chain.symbol : "ETH");
  /* real money or test money: every piece of money copy switches on this (GET /v1/config → chain.realMoney) */
  const real = () => !!(S.cfg && S.cfg.chain && S.cfg.chain.realMoney);
  const chainName = () => (S.cfg && S.cfg.chain && S.cfg.chain.name) || (real() ? "Ethereum" : "the test network");
  const feePct = () => (S.cfg && S.cfg.feeBps != null ? `${S.cfg.feeBps / 100}%` : "");
  const feeText = () => (feePct() ? `A ${feePct()} fee` : "A fee");
  /* one sober sentence for the rooms and terms: what the money is and where it sits */
  const moneyNote = () => (real()
    ? `Real ${sym()} on ${chainName()}. Stakes are held in escrow until the match is decided. ${feeText()} is taken from the pot.`
    : `Test ${sym()} only, no real money.`);
  const now = () => (S.client ? S.client.serverNow() : Date.now());
  /* seconds left until epoch-ms `t`, as "1:05" or "42s"; pair with data-until="t" so app.js keeps it ticking */
  const left = (t) => { const s = Math.max(0, Math.ceil((Number(t) - now()) / 1000)); return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`; };
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
  const game = (id) => S.games.find((g) => g.id === id);
  const ago = (t) => { const s = Math.max(0, Math.round((now() - Number(t)) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
  return { esc, eth, sym, real, chainName, feePct, moneyNote, now, left, short, game, ago, cap, avatar, icon, meter };
}

/* Deterministic avatar for an address or name: a 5×5 mirrored pixel mark on a dark disc. Returns inline SVG. */
export function avatar(seed, size = 40) {
  let h = 2166136261;
  for (const ch of String(seed || "?")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  /* warm fallback palette (gold rules: no blue/purple hues). Presentation attributes, so the views' CSS
     (.ava circle / .ava g in app.css, match.css) can still recolour avatars per role. */
  const MARKS = ["#E2C675", "#F3E7C3", "#A39C8C", "#C9A227"];
  const mark = MARKS[h % MARKS.length], cells = [];
  let bits = h;
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    if (bits & 1) { cells.push([x, y]); if (x < 2) cells.push([4 - x, y]); }
    bits = (bits >>> 1) || Math.imul(h, y + 7) >>> 0;
  }
  const rects = cells.map(([x, y]) => `<rect x="${7 + x * 5.2}" y="${7 + y * 5.2}" width="5.2" height="5.2"/>`).join("");
  return `<svg class="ava" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="20" fill="#1F1C17"/><g fill="${mark}">${rects}</g></svg>`;
}

/* 24×24 stroke icons. icon("name", "extra-class") */
const ICONS = {
  home: '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/>',
  games: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v4h4M12 8v4l3 2"/>',
  wallet: '<rect x="3.5" y="6" width="17" height="13" rx="2.5"/><path d="M3.5 9.5h17M16 14h1.5"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="16.5" cy="9.5" r="2.6"/><path d="M15.5 14.2A4.6 4.6 0 0 1 20.5 19"/>',
  star: '<path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.1" fill="currentColor"/><circle cx="15" cy="15" r="1.1" fill="currentColor"/><circle cx="15" cy="9" r="1.1" fill="currentColor"/><circle cx="9" cy="15" r="1.1" fill="currentColor"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  out: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  flame: '<path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.6-5.3 3.6-8.8 2.2 1.4 3 3.4 3 5.2 1-.6 1.7-1.7 1.9-3 2.4 1.9 4.5 4.2 4.5 6.9 0 3.4-2.7 5.9-6.5 5.9z"/>',
  chain: '<path d="M7 7h4v4H7zM13 13h4v4h-4z"/><path d="M11 9h2a2 2 0 0 1 2 2v2M9 11v2a2 2 0 0 0 2 2h2"/>',
};
export function icon(name, cls = "") {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

/* 10-segment meter, e.g. meter("Skill", 8, "skill") */
export function meter(label, n, kind = "") {
  const segs = Array.from({ length: 10 }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("");
  return `<div class="meter ${kind}" role="img" aria-label="${esc(label)} ${n} out of 10"><span>${esc(label)}</span><span class="segs">${segs}</span><b>${n}</b></div>`;
}

/* The persistent network badge: "ETHEREUM MAINNET" in a hairline gold frame for real money, a quieter "… · TEST" otherwise.
   `long` is the full label; `short` is what a phone shows (MAINNET / TESTNET / LOCAL). Returns "" until the config is loaded. */
export function netBadge(S) {
  const c = S.cfg && S.cfg.chain;
  if (!c) return "";
  const net = S.cfg.network || (c.realMoney ? "mainnet" : "testnet");
  const name = String(c.name || "Ethereum");
  const long = net === "mainnet" ? (/mainnet/i.test(name) ? name : `${name} mainnet`)
    : net === "local" ? (/local/i.test(name) ? name : `${name} local`)
    : (/test/i.test(name) ? name : `${name} testnet`);
  const short = net === "mainnet" ? "Mainnet" : net === "local" ? "Local" : "Testnet";
  const title = c.realMoney ? `${name}: real ${c.symbol || "ETH"}` : `${name}: test ${c.symbol || "ETH"} with no real value`;
  return `<span class="net-tag${c.realMoney ? " real" : ""}" id="netTag" title="${esc(title)}"><i aria-hidden="true"></i><span class="sr-only">Network: ${esc(long)}</span><span class="nt-long" aria-hidden="true">${esc(long)}</span><span class="nt-short" aria-hidden="true">${esc(short)}</span></span>`;
}
