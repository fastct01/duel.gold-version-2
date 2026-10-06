/* Schema migrations, applied in order; the index+1 is stored in PRAGMA user_version. An entry is SQL text, or a function
   (rawDatabase) => void for a step that must inspect the database first. Applied migrations are never edited.
   Amount columns are TEXT holding decimal wei (see util/amounts.js). Timestamps are epoch milliseconds.
   Database files created before two retired features were removed still carry two unused `users` columns (one NOT NULL
   with a default). Migration 4 brings `age_attested_at` back; the other (`cool_off_until`) is still unused and left in place. */
export const MIGRATIONS = [
  /* 1 — initial schema */
  `
  CREATE TABLE users (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    address               TEXT    NOT NULL UNIQUE,          -- lowercase 0x…, the wallet that signs in
    display_name          TEXT    NOT NULL,
    created_at            INTEGER NOT NULL,
    loss_limit            TEXT,                             -- daily loss limit in wei, NULL = off
    loss_limit_pending    TEXT,                             -- a loosening that has not taken effect yet: wei, or 'off'
    loss_limit_pending_at INTEGER,
    strikes               INTEGER NOT NULL DEFAULT 0,       -- no-shows
    last_strike_at        INTEGER NOT NULL DEFAULT 0,
    queue_ban_until       INTEGER NOT NULL DEFAULT 0,
    banned                INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE auth_nonces (
    nonce      TEXT PRIMARY KEY,                            -- keyed by nonce (not address) so nobody can burn another wallet's pending sign-in
    address    TEXT NOT NULL,
    message    TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX auth_nonces_address ON auth_nonces(address);

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,                            -- sha256 of the bearer token; the token itself is never stored
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip         TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE deposit_addresses (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id),
    idx        INTEGER NOT NULL UNIQUE,                     -- HD derivation index
    address    TEXT    NOT NULL UNIQUE,                     -- lowercase
    needs_sweep INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  /* ---- double-entry ledger ---- */
  CREATE TABLE accounts (
    id      TEXT PRIMARY KEY,                               -- user:7 | escrow:ticket:3 | escrow:match:9 | escrow:withdrawal:2 | house:fees | external:chain
    kind    TEXT NOT NULL,
    balance TEXT NOT NULL DEFAULT '0'
  );
  CREATE TABLE ledger_tx (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT    NOT NULL,
    ref        TEXT,
    uniq       TEXT UNIQUE,                                 -- idempotency key: a second insert with the same key is refused
    memo       TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE ledger_entries (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_id   INTEGER NOT NULL REFERENCES ledger_tx(id),
    account TEXT    NOT NULL REFERENCES accounts(id),
    amount  TEXT    NOT NULL                                -- signed; every tx sums to 0
  );
  CREATE INDEX entries_account ON ledger_entries(account, id);
  CREATE INDEX entries_tx      ON ledger_entries(tx_id);

  /* ---- chain plumbing ---- */
  CREATE TABLE chain_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE deposits (
    tx_hash      TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    address      TEXT    NOT NULL,
    amount       TEXT    NOT NULL,
    block_number INTEGER NOT NULL,
    credited_at  INTEGER NOT NULL
  );
  CREATE INDEX deposits_user ON deposits(user_id, credited_at);

  CREATE TABLE sweeps (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    address    TEXT    NOT NULL,
    amount     TEXT    NOT NULL,                            -- value sent to the treasury
    tx_hash    TEXT    NOT NULL,
    raw_tx     TEXT    NOT NULL,
    status     TEXT    NOT NULL,                            -- pending | confirmed | failed
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX sweeps_status ON sweeps(status);

  CREATE TABLE withdrawals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    to_address   TEXT    NOT NULL,
    amount       TEXT    NOT NULL,
    status       TEXT    NOT NULL,                          -- queued | signed | broadcast | confirmed | failed
    idem_key     TEXT,
    nonce        INTEGER,
    tx_hash      TEXT,
    raw_tx       TEXT,
    block_number INTEGER,
    error        TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    broadcast_at INTEGER,
    UNIQUE (user_id, idem_key)
  );
  CREATE INDEX withdrawals_status ON withdrawals(status, id);

  /* ---- games ---- */
  CREATE TABLE tickets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    game       TEXT    NOT NULL,
    stake      TEXT    NOT NULL,
    code       TEXT,                                        -- private-match code, NULL for open queue
    rating     INTEGER NOT NULL,
    state      TEXT    NOT NULL,                            -- queued | matched | cancelled | expired
    created_at INTEGER NOT NULL,
    closed_at  INTEGER,
    match_id   INTEGER
  );
  CREATE INDEX tickets_state ON tickets(state);

  CREATE TABLE matches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    game            TEXT    NOT NULL,
    stake           TEXT    NOT NULL,                       -- per player
    pot             TEXT    NOT NULL,
    fee             TEXT    NOT NULL DEFAULT '0',
    state           TEXT    NOT NULL,                       -- found | playing | settled | void
    outcome         TEXT,                                   -- win | draw | void
    reason          TEXT,                                   -- scores | forfeit | timeout | no_show | no_result
    seed            INTEGER,
    code            TEXT,
    created_at      INTEGER NOT NULL,
    ready_deadline  INTEGER,
    start_at        INTEGER,
    submit_deadline INTEGER,
    settled_at      INTEGER,
    winner_seat     INTEGER
  );
  CREATE INDEX matches_state ON matches(state);

  CREATE TABLE match_players (
    match_id      INTEGER NOT NULL REFERENCES matches(id),
    seat          INTEGER NOT NULL,                         -- 0..9, in join order (a lobby host is seat 0)
    user_id       INTEGER NOT NULL REFERENCES users(id),
    ticket_id     INTEGER,
    rating_before INTEGER NOT NULL,
    rating_after  INTEGER,
    ready_at      INTEGER,
    seed_sent     INTEGER NOT NULL DEFAULT 0,
    score         REAL,
    detail        TEXT,
    submitted_at  INTEGER,
    forfeited     INTEGER NOT NULL DEFAULT 0,
    payout        TEXT,
    flag          TEXT,                                     -- set when the score looks implausible (reviewed by an operator)
    PRIMARY KEY (match_id, seat)
  );
  CREATE INDEX match_players_user ON match_players(user_id, match_id);

  CREATE TABLE ratings (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    game       TEXT    NOT NULL,
    rating     INTEGER NOT NULL DEFAULT 1200,
    wins       INTEGER NOT NULL DEFAULT 0,
    losses     INTEGER NOT NULL DEFAULT 0,
    draws      INTEGER NOT NULL DEFAULT 0,
    best       REAL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, game)
  );
  CREATE INDEX ratings_board ON ratings(game, rating DESC);

  CREATE TABLE player_day (
    user_id INTEGER NOT NULL REFERENCES users(id),
    day     TEXT    NOT NULL,                               -- UTC yyyy-mm-dd
    net     TEXT    NOT NULL DEFAULT '0',                   -- signed wei: payouts minus stakes for settled staked matches
    PRIMARY KEY (user_id, day)
  );
  `,
  /* 2 — invite-only lobbies: a lobby is the host's escrowed ticket plus a server-generated invite code */
  `
  ALTER TABLE tickets ADD COLUMN lobby_code TEXT;
  CREATE UNIQUE INDEX tickets_lobby_code ON tickets(lobby_code) WHERE lobby_code IS NOT NULL;
  `,
  /* 3 — multi-player lobbies: a guest's ticket points at the host's lobby ticket (the host's own ticket keeps lobby_code).
     Guest ticket states: queued (waiting in the lobby) | matched | cancelled | expired (lobby closed) | left (guest left). */
  `
  ALTER TABLE tickets ADD COLUMN lobby_ticket_id INTEGER;
  CREATE INDEX tickets_lobby_ticket ON tickets(lobby_ticket_id) WHERE lobby_ticket_id IS NOT NULL;
  `,
  /* 4 — 18+ attestation, required before any staked action. Databases created before the attestation was retired still have the
     column (with their players' old answers, which stay valid), so it is only added where it is missing. */
  (raw) => {
    const has = raw.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "age_attested_at");
    if (!has) raw.exec("ALTER TABLE users ADD COLUMN age_attested_at INTEGER");
  },
  /* 5 — minimum deposit: a deposit below the minimum is recorded as 'pending' and credited (with the other pending deposits
     at that address) once their total reaches it. credited_at is 0 while pending; detected_at is when the watcher saw it. */
  `
  ALTER TABLE deposits ADD COLUMN status TEXT NOT NULL DEFAULT 'credited';
  ALTER TABLE deposits ADD COLUMN detected_at INTEGER;
  CREATE INDEX deposits_pending ON deposits(address) WHERE status = 'pending';
  `,
  /* 6 — withdrawal network fee, charged on top of `amount` and recorded in the ledger as its own entry (house:gas) */
  `
  ALTER TABLE withdrawals ADD COLUMN fee TEXT NOT NULL DEFAULT '0';
  `,
  /* 7 — email accounts. An account can sign in with an email and a password instead of a wallet, so users.address becomes
     optional: it is the wallet linked to the account (set at wallet sign-in, or linked later by signature) and withdrawals
     need it. SQLite cannot drop NOT NULL in place, so the table is rebuilt with every column it has (older files carry extra
     ones) and every row, keeping ids. email is stored lowercase; password_hash is "scrypt$N$r$p$salt$hash" (base64url).
     email_tokens holds one-time links (verify the address, reset the password); only the token's sha256 is stored. */
  Object.assign((raw) => {
    const cols = raw.prepare("PRAGMA table_info(users)").all();
    const def = (c) => {
      if (c.name === "id") return "id INTEGER PRIMARY KEY AUTOINCREMENT";
      if (c.name === "address") return "address TEXT UNIQUE";
      return `${c.name} ${c.type || ""}${c.notnull ? " NOT NULL" : ""}${c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : ""}`;
    };
    const names = cols.map((c) => c.name).join(", ");
    raw.exec(`
      CREATE TABLE users_new (${cols.map(def).join(", ")},
        email TEXT UNIQUE, email_verified_at INTEGER, password_hash TEXT);
      INSERT INTO users_new (${names}) SELECT ${names} FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      CREATE TABLE email_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id),
        kind       TEXT    NOT NULL,                          -- 'verify' | 'reset'
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX email_tokens_user ON email_tokens(user_id, kind);
    `);
  }, { foreignKeysOff: true }),
];
