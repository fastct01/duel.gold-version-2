/* SQLite access (node:sqlite, synchronous). One process owns the database file.
   Everything that moves money runs inside `db.tx()`; because the driver is synchronous and Node is single-threaded,
   no other work can interleave inside a transaction. */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./schema.js";

export class Db {
  constructor(file) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
    this.stmts = new Map();
    this.depth = 0;
    this.migrate();
  }

  migrate() {
    const cur = this.raw.prepare("PRAGMA user_version").get().user_version;
    if (cur > MIGRATIONS.length) throw new Error(`database schema v${cur} is newer than this server (v${MIGRATIONS.length})`);
    for (let v = cur; v < MIGRATIONS.length; v++) {
      this.raw.exec("BEGIN IMMEDIATE");
      try {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec("COMMIT");
      } catch (e) {
        this.raw.exec("ROLLBACK");
        throw e;
      }
    }
  }

  #stmt(sql) {
    let s = this.stmts.get(sql);
    if (!s) { s = this.raw.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }
  /* undefined → null; BigInt is refused so an amount can never be silently stored as an INTEGER */
  #args(params) {
    return params.map((p) => {
      if (p === undefined) return null;
      if (typeof p === "bigint") throw new TypeError("bind a BigInt as a string (toStr) — amounts are stored as TEXT");
      if (typeof p === "boolean") return p ? 1 : 0;
      return p;
    });
  }
  run(sql, ...params) { return this.#stmt(sql).run(...this.#args(params)); }
  get(sql, ...params) { return this.#stmt(sql).get(...this.#args(params)); }
  all(sql, ...params) { return this.#stmt(sql).all(...this.#args(params)); }

  /* Run fn atomically. Nested calls become savepoints. fn must be synchronous. */
  tx(fn) {
    const nested = this.depth > 0;
    const name = `sp${this.depth}`;
    this.raw.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      if (out && typeof out.then === "function") throw new TypeError("db.tx callback must be synchronous");
      this.depth--;
      this.raw.exec(nested ? `RELEASE ${name}` : "COMMIT");
      return out;
    } catch (e) {
      this.depth--;
      this.raw.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
      throw e;
    }
  }

  close() {
    this.stmts.clear();
    this.raw.close();
  }
}

export const openDb = (file) => new Db(file);
