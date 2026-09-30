/* Player accounts. A player is identified by the wallet address they sign in with. */
import { bad, notFound } from "./util/errors.js";
import { shortAddress } from "./util/address.js";

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{1,18}[\p{L}\p{N}]$/u;

export class Users {
  constructor(db, now = () => Date.now()) {
    this.db = db;
    this.now = now;
  }

  byId(id) { return this.db.get("SELECT * FROM users WHERE id = ?", id) || null; }
  byAddress(address) { return this.db.get("SELECT * FROM users WHERE address = ?", address) || null; }
  require(id) { const u = this.byId(id); if (!u) throw notFound("Unknown player."); return u; }

  getOrCreate(address) {
    return this.db.tx(() => {
      const existing = this.byAddress(address);
      if (existing) return { user: existing, created: false };
      const name = `Player-${address.slice(2, 6)}${address.slice(-2)}`;
      const id = this.db.run("INSERT INTO users (address, display_name, created_at) VALUES (?, ?, ?)", address, name, this.now()).lastInsertRowid;
      return { user: this.byId(Number(id)), created: true };
    });
  }

  setDisplayName(id, raw) {
    const name = String(raw ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!NAME_RE.test(name)) throw bad("BAD_NAME", "Names are 3–20 characters: letters, numbers, spaces, dot, dash or underscore.");
    if (/^0x[0-9a-f]{4,}/i.test(name)) throw bad("BAD_NAME", "A name cannot look like a wallet address.");
    this.db.run("UPDATE users SET display_name = ? WHERE id = ?", name, id);
    return name;
  }

  /* what other players may see */
  publicView(u) {
    return { id: u.id, name: u.display_name, address: shortAddress(u.address) };
  }
}
