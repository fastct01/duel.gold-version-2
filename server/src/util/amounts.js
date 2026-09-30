/* Money is always integer wei held as BigInt in memory and as decimal TEXT in SQLite.
   JS Numbers never touch an amount: they lose precision above 2^53 (about 0.009 ETH in wei). */
import { formatEther } from "ethers";
import { bad } from "./errors.js";

/* Parse an amount from JSON input. Accepts a non-negative decimal string, or a safe integer Number. */
export function parseWei(v, field = "amount") {
  if (typeof v === "bigint") {
    if (v < 0n) throw bad("BAD_AMOUNT", `${field} must not be negative.`);
    return v;
  }
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) throw bad("BAD_AMOUNT", `${field} must be a whole number of wei (use a string for large values).`);
    return BigInt(v);
  }
  if (typeof v === "string" && /^\d{1,40}$/.test(v)) return BigInt(v);
  throw bad("BAD_AMOUNT", `${field} must be a whole number of wei, as a decimal string.`);
}

export const toStr = (n) => n.toString();
export const big = (s) => BigInt(s);

/* human form for logs and messages: "0.0105" (ETH-style, 18 decimals trimmed) */
export function fmtEth(wei) {
  const s = formatEther(wei);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/* winner payout / fee for a pot. The fee absorbs the rounding remainder so payout + fee === pot exactly. */
export function splitPot(pot, feeBps) {
  const payout = (pot * BigInt(10000 - feeBps)) / 10000n;
  return { payout, fee: pot - payout };
}
