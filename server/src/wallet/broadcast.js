import { safeMessage } from "../util/errors.js";

/* Broadcast a signed raw transaction and classify the outcome.
   - ok: the node has it ("already known" counts: we are re-sending something it already holds)
   - nonceUsed: the sender's nonce is already spent — either this very tx was mined, or something else took the nonce;
     the caller must look at receipts to tell which, never guess from the error string
   - otherwise a plain failure (node down, underfunded, …): nothing reached the chain, safe to retry the same bytes */
export async function broadcast(provider, raw) {
  try {
    await provider.broadcastTransaction(raw);
    return { ok: true };
  } catch (e) {
    const message = String(e.shortMessage || e.message || e);
    const inner = String(e.info?.error?.message || e.error?.message || "");
    if (/already known|known transaction|already imported|already in mempool|tx already exists/i.test(message + " " + inner)) return { ok: true, known: true };
    if (e.code === "NONCE_EXPIRED" || /nonce too low|nonce has already been used|nonce is too low/i.test(message + " " + inner)) {
      return { ok: false, nonceUsed: true, error: safeMessage(e), code: e.code };
    }
    return { ok: false, error: safeMessage(e), code: e.code };
  }
}
