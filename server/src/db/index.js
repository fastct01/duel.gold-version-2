/* Postgres access (Supabase in production, any Postgres 13+ elsewhere) through node-postgres.

   The services were written for a synchronous database in a single process: a run of code with no await in it could never
   interleave with another request. With a network database every query is an await, so that guarantee is rebuilt here:

     db.exclusive(fn)  runs fn while holding ONE process-wide lock (FIFO). Every operation that reads state and then acts on
                       it (lobbies, matches, sign-ups) runs inside it, so two of them still never interleave.
     db.tx(fn)         exclusive + a real transaction on one dedicated connection. Every db.get/all/run made inside fn — however
                       deep in the call stack — is routed to that connection automatically (AsyncLocalStorage), so a ledger
                       posting inside a settlement is part of the settlement's transaction. Nested tx() become savepoints.
                       Each transaction also takes a Postgres advisory lock, so even two server processes (e.g. the old and
                       the new instance during a deploy) can never move money at the same time.
     db.detach(fn)     runs fn outside any lock/transaction context. Timers and background loops started from inside an
                       exclusive section must use it, or they would inherit a lock they do not actually hold.

   SQL is written with `?` placeholders (converted to $1, $2, ... here). run() returns { changes, lastInsertRowid, rows }:
   lastInsertRowid is the `id` of the first row an INSERT ... RETURNING id gave back (reading it without RETURNING throws). BIGINT columns come back as JS numbers
   (ids and epoch-millisecond timestamps are far below 2^53); amounts are TEXT holding decimal wei and are never numbers. */
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { MIGRATIONS } from "./schema.js";

pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/;
const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/* `?` → `$n`, leaving quoted strings and identifiers alone */
const converted = new Map();
function toPg(sql) {
  let out = converted.get(sql);
  if (out) return out;
  let n = 0, quote = null;
  out = "";
  for (const ch of sql) {
    if (quote) { if (ch === quote) quote = null; out += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    out += ch === "?" ? `$${++n}` : ch;
  }
  if (converted.size < 2000) converted.set(sql, out);
  return out;
}

/* a FIFO lock: lock() resolves to a release function */
class Mutex {
  #tail = Promise.resolve();
  lock() {
    let release;
    const turn = new Promise((r) => { release = r; });
    const before = this.#tail;
    this.#tail = before.then(() => turn);
    return before.then(() => release);
  }
}

export class Db {
  constructor(pool, { schema = null, dropOnClose = false } = {}) {
    this.pool = pool;
    this.schema = schema;
    this.dropOnClose = dropOnClose;
    this.als = new AsyncLocalStorage();
    this.mutex = new Mutex();
    this.closed = false;
  }

  /* url: postgres connection string. schema: use (and create) this schema instead of the default one — tests give every app
     its own; dropOnClose removes it again. ssl defaults to on for any host that is not this machine. */
  static async open({ url, schema = null, dropOnClose = false, poolMax = 5, ssl = null, log = null, allowExitOnIdle = false } = {}) {
    if (!url) throw new Error("DATABASE_URL is not set: point it at your Postgres database (Supabase: Connect → Session pooler).");
    if (schema != null && !SCHEMA_RE.test(schema)) throw new Error(`bad schema name "${schema}"`);
    const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
    const useSsl = ssl ?? !LOCAL_HOST.test(host);
    if (schema) {
      const boot = new pg.Client({ connectionString: url, ssl: useSsl ? { rejectUnauthorized: false } : false });
      await boot.connect();
      try { await boot.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`); } finally { await boot.end(); }
    }
    const pool = new pg.Pool({
      connectionString: url,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
      max: poolMax,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      allowExitOnIdle, // tests: an idle pool must not keep the process alive
    });
    // a plain SET on every new connection (the pooler in front of Supabase does not pass startup options through)
    if (schema) pool.on("connect", (client) => { client.query(`SET search_path TO ${schema}`).catch(() => {}); });
    // an idle connection dropped by the server must not crash the process; the pool replaces it
    pool.on("error", (e) => (log ? log.warn("idle database connection failed", { error: String(e.message || e) }) : undefined));
    const db = new Db(pool, { schema, dropOnClose });
    try { await db.migrate(); } catch (e) { await pool.end().catch(() => {}); throw e; }
    return db;
  }

  /* Apply pending migrations, each in its own transaction, under a session advisory lock so two processes starting at
     once cannot both migrate. The applied version is kept in schema_migrations. */
  async migrate() {
    const c = await this.pool.connect();
    try {
      await c.query("SELECT pg_advisory_lock(hashtext('playvault-migrate:' || current_schema()))");
      try {
        await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)");
        const cur = (await c.query("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations")).rows[0].v;
        if (cur > MIGRATIONS.length) throw new Error(`database schema v${cur} is newer than this server (v${MIGRATIONS.length})`);
        for (let v = cur; v < MIGRATIONS.length; v++) {
          await c.query("BEGIN");
          try {
            await c.query(MIGRATIONS[v]);
            await c.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)", [v + 1, Date.now()]);
            await c.query("COMMIT");
          } catch (e) {
            await c.query("ROLLBACK").catch(() => {});
            throw e;
          }
        }
      } finally {
        await c.query("SELECT pg_advisory_unlock(hashtext('playvault-migrate:' || current_schema()))").catch(() => {});
      }
    } finally { c.release(); }
  }

  async version() {
    return (await this.get("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations")).v;
  }

  /* undefined → null; BigInt is refused so an amount can never be silently stored as a number; booleans are 0/1 */
  #args(params) {
    return params.map((p) => {
      if (p === undefined) return null;
      if (typeof p === "bigint") throw new TypeError("bind a BigInt as a string (toStr) — amounts are stored as TEXT");
      if (typeof p === "boolean") return p ? 1 : 0;
      return p;
    });
  }

  #query(sql, params) {
    const args = this.#args(params); // throws synchronously on a BigInt, before anything is sent
    const store = this.als.getStore();
    return (store && store.client ? store.client : this.pool).query(toPg(sql), args);
  }

  async run(sql, ...params) {
    const r = await this.#query(sql, params);
    const rows = r.rows || [];
    const out = { changes: r.rowCount ?? 0, rows };
    // reading the new id of an INSERT that did not ask for it is a bug, not a silent undefined
    Object.defineProperty(out, "lastInsertRowid", {
      get() {
        if (!rows[0] || rows[0].id === undefined) throw new Error(`lastInsertRowid needs "RETURNING id" in: ${sql.slice(0, 80)}`);
        return rows[0].id;
      },
    });
    return out;
  }
  async get(sql, ...params) { return (await this.#query(sql, params)).rows[0]; }
  async all(sql, ...params) { return (await this.#query(sql, params)).rows; }

  /* true while the caller holds the process-wide lock */
  get locked() { const s = this.als.getStore(); return !!(s && s.locked); }

  async exclusive(fn) {
    if (this.locked) return fn();
    const release = await this.mutex.lock();
    try { return await this.als.run({ locked: true, client: null, depth: 0 }, fn); }
    finally { release(); }
  }

  /* Run fn atomically. Nested calls become savepoints. */
  async tx(fn) {
    const s = this.als.getStore();
    if (s && s.client) {
      const name = `sp${s.depth}`;
      await s.client.query(`SAVEPOINT ${name}`);
      try {
        const out = await this.als.run({ ...s, depth: s.depth + 1 }, fn);
        await s.client.query(`RELEASE SAVEPOINT ${name}`);
        return out;
      } catch (e) {
        await s.client.query(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
        throw e;
      }
    }
    return this.exclusive(async () => {
      const client = await this.pool.connect();
      let broken = false;
      try {
        await client.query("BEGIN; SELECT pg_advisory_xact_lock(hashtext('playvault-money:' || current_schema()))");
        const out = await this.als.run({ locked: true, client, depth: 1 }, fn);
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => { broken = true; });
        throw e;
      } finally {
        client.release(broken || undefined);
      }
    });
  }

  /* run fn with no lock or transaction context (for timers and background work started from inside one) */
  detach(fn) { return this.als.exit(fn); }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.dropOnClose && this.schema) {
      await this.pool.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`).catch(() => {});
    }
    await this.pool.end();
  }
}

export const openDb = (opts) => Db.open(opts);
