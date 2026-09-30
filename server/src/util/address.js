import { getAddress, isAddress } from "ethers";
import { bad } from "./errors.js";

/* Validate and return the lowercase form used as the database key. Accepts checksummed or all-lowercase input;
   a mixed-case address with a wrong checksum is refused (it usually means a typo). */
export function normalizeAddress(input, field = "address") {
  if (typeof input !== "string" || !isAddress(input)) throw bad("BAD_ADDRESS", `${field} is not a valid Ethereum address.`);
  return getAddress(input).toLowerCase();
}

export const checksum = (lower) => getAddress(lower);
export const shortAddress = (lower) => `${lower.slice(0, 6)}…${lower.slice(-4)}`;
