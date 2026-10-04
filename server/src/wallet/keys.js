/* Key management.

   One BIP-39 mnemonic derives everything:
     m/44'/60'/0'/0/<userId>   per-player deposit address (custodial: the server holds these keys)
     m/44'/60'/1'/0/0          the treasury / hot wallet that pays withdrawals

   HOT WALLET. Anyone who can read the mnemonic controls ALL funds: every player's deposit address and the treasury. On mainnet
   that is real money, so keep the treasury balance small and sweep the surplus to cold storage by hand (see README, "Running on
   mainnet"). There is no KMS/HSM here. The mnemonic and the private keys are never logged. */
import fs from "node:fs";
import path from "node:path";
import { HDNodeWallet, Mnemonic } from "ethers";

const USER_PATH = "m/44'/60'/0'/0";
const TREASURY_PATH = "m/44'/60'/1'/0/0";

export function resolveMnemonic(cfg, log) {
  if (cfg.keys.mnemonic) {
    if (!Mnemonic.isValidMnemonic(cfg.keys.mnemonic)) throw new Error("HD_MNEMONIC is not a valid BIP-39 mnemonic");
    return cfg.keys.mnemonic;
  }
  if (cfg.production || cfg.mainnet) throw new Error("HD_MNEMONIC is required in production and on mainnet");
  const file = cfg.keys.devMnemonicFile;
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const phrase = HDNodeWallet.createRandom().mnemonic.phrase;
  fs.writeFileSync(file, phrase + "\n", { mode: 0o600 });
  log.warn("HD_MNEMONIC not set: generated a development wallet", { file, note: "development only. Set HD_MNEMONIC for any shared deployment" });
  return phrase;
}

export class KeyManager {
  constructor(phrase) {
    const m = Mnemonic.fromPhrase(phrase);
    this.userRoot = HDNodeWallet.fromMnemonic(m, USER_PATH);
    this._treasury = HDNodeWallet.fromMnemonic(m, TREASURY_PATH);
    this.cache = new Map();
  }
  /* wallet for a deposit index (we use the player id) */
  user(index) {
    if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new RangeError("bad derivation index");
    let w = this.cache.get(index);
    if (!w) { w = this.userRoot.deriveChild(index); this.cache.set(index, w); }
    return w;
  }
  userAddress(index) { return this.user(index).address.toLowerCase(); }
  treasury() { return this._treasury; }
}
