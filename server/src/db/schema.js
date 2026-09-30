/* Schema migrations, applied in order; the index+1 is stored in PRAGMA user_version.
   Amount columns are TEXT holding decimal wei (see util/amounts.js). Timestamps are epoch milliseconds. */
export const MIGRATIONS = [
  /* 1 — initial schema */
  `
  CREATE TABLE users (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    address               TEXT    NOT NULL UNIQUE,          -- lowercase 0x…, the wallet that signs in
    display_name          TEXT    NOT NULL,
    created_at            INTEGER NOT NULL,
    age_attested_at       INTEGER,                          -- "I am 18 or older", required to stake
    cool_off_until        INTEGER NOT NULL DEFAULT 0,
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
    seat          INTEGER NOT NULL,                         -- 0 | 1
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
];
