/* Configuration: environment variables → one validated plain object. Tests pass `overrides` instead of env. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWei } from "./util/amounts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(SERVER_ROOT, "..");

const ETH = 10n ** 18n;
const int = (v, d, name, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (v == null || v === "") return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`config: ${name} must be an integer in [${min}, ${max}], got "${v}"`);
  return n;
};
const list = (v, d) => (v == null || v === "" ? d : String(v).split(",").map((s) => s.trim()).filter(Boolean));
const bool = (v, d) => (v == null || v === "" ? d : ["1", "true", "yes", "on"].includes(String(v).toLowerCase()));
const wei = (v, d, name) => {
  if (v == null || v === "") return d;
  try { return parseWei(String(v), name); } catch { throw new Error(`config: ${name} must be a whole number of wei`); }
};

function merge(base, extra) {
  if (!extra) return base;
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof v !== "bigint" && base[k] && typeof base[k] === "object") merge(base[k], v);
    else base[k] = v;
  }
  return base;
}

export function loadConfig(env = process.env, overrides = {}) {
  const nodeEnv = env.NODE_ENV || "development";
  const production = nodeEnv === "production";

  const cfg = {
    env: nodeEnv,
    production,
    port: int(env.PORT, 8787, "PORT", 0, 65535),
    host: env.HOST || "127.0.0.1",
    publicDomain: env.PUBLIC_DOMAIN || "localhost",
    /* Bearer tokens (no cookies) are used for auth, so a wildcard CORS policy is safe; WebSocket origins are still checked. */
    allowedOrigins: list(env.ALLOWED_ORIGINS, ["*"]),
    trustProxy: bool(env.TRUST_PROXY, false),
    dbPath: env.DB_PATH || path.join(SERVER_ROOT, "data", "duel.db"),
    logLevel: env.LOG_LEVEL || (nodeEnv === "test" ? "silent" : "info"),
    adminToken: env.ADMIN_TOKEN || "",
    gamesDir: env.GAMES_DIR || path.join(REPO_ROOT, "src"),
    publicDir: path.join(SERVER_ROOT, "public"),
    clientDir: path.join(SERVER_ROOT, "client"),
    vendorDir: path.join(SERVER_ROOT, "node_modules", "ethers", "dist"),
    devFaucet: false, // set only by scripts/dev-stack.js on a local chain

    chain: {
      /* null rpcUrl = wallet features disabled (used by tests that fund accounts directly) */
      rpcUrl: env.RPC_URL || "http://127.0.0.1:8545",
      expectedChainId: env.CHAIN_ID ? int(env.CHAIN_ID, null, "CHAIN_ID", 1) : null,
      confirmations: int(env.CONFIRMATIONS, 6, "CONFIRMATIONS", 1, 1000),
      pollMs: int(env.POLL_MS, 4000, "POLL_MS", 50),
      startBlock: env.START_BLOCK ? int(env.START_BLOCK, null, "START_BLOCK", 0) : null,
      sweepIntervalMs: int(env.SWEEP_INTERVAL_MS, 30000, "SWEEP_INTERVAL_MS", 50),
      sweepMinWei: wei(env.SWEEP_MIN_WEI, ETH / 2000n, "SWEEP_MIN_WEI"), // 0.0005
      withdrawIntervalMs: int(env.WITHDRAW_INTERVAL_MS, 5000, "WITHDRAW_INTERVAL_MS", 50),
      rebroadcastAfterMs: int(env.REBROADCAST_AFTER_MS, 120000, "REBROADCAST_AFTER_MS", 50),
    },

    keys: {
      mnemonic: env.HD_MNEMONIC || "",
      devMnemonicFile: path.join(SERVER_ROOT, "data", "dev-mnemonic.txt"),
    },

    economy: {
      feeBps: int(env.FEE_BPS, 1000, "FEE_BPS", 0, 5000), // 10%
      minStake: wei(env.MIN_STAKE_WEI, ETH / 10000n, "MIN_STAKE_WEI"), // 0.0001
      maxStake: wei(env.MAX_STAKE_WEI, ETH / 20n, "MAX_STAKE_WEI"), // 0.05
      stakeTiers: list(env.STAKE_TIERS_WEI, ["500000000000000", "1000000000000000", "2500000000000000", "5000000000000000", "10000000000000000"]).map((s) => parseWei(s, "STAKE_TIERS_WEI")),
      minWithdrawal: wei(env.MIN_WITHDRAWAL_WEI, ETH / 10000n, "MIN_WITHDRAWAL_WEI"),
      maxWithdrawal: wei(env.MAX_WITHDRAWAL_WEI, ETH, "MAX_WITHDRAWAL_WEI"),
      dailyWithdrawalCap: wei(env.DAILY_WITHDRAWAL_CAP_WEI, 2n * ETH, "DAILY_WITHDRAWAL_CAP_WEI"),
    },

    match: {
      acceptMs: int(env.MATCH_ACCEPT_MS, 15000, "MATCH_ACCEPT_MS", 20),
      countdownMs: int(env.MATCH_COUNTDOWN_MS, 3000, "MATCH_COUNTDOWN_MS", 0),
      graceMs: int(env.MATCH_GRACE_MS, 15000, "MATCH_GRACE_MS", 0),
      /* submit deadline = start + nominal game length × durationFactor × durationScale + grace */
      durationFactor: Number(env.MATCH_DURATION_FACTOR || 1.5),
      durationScale: Number(env.MATCH_DURATION_SCALE || 1),
      queueTimeoutMs: int(env.QUEUE_TIMEOUT_MS, 90000, "QUEUE_TIMEOUT_MS", 20),
      disconnectQueueMs: int(env.QUEUE_DISCONNECT_MS, 10000, "QUEUE_DISCONNECT_MS", 0),
      ratingBase: int(env.RATING_WINDOW, 60, "RATING_WINDOW", 0),
      ratingGrowthPerSec: int(env.RATING_WINDOW_GROWTH, 15, "RATING_WINDOW_GROWTH", 0),
      ratingMax: int(env.RATING_WINDOW_MAX, 600, "RATING_WINDOW_MAX", 0),
      pairIntervalMs: int(env.PAIR_INTERVAL_MS, 1000, "PAIR_INTERVAL_MS", 10),
      maxScore: Number(env.MAX_SCORE || 1e7),
      strikesBeforeBan: int(env.STRIKES_BEFORE_BAN, 3, "STRIKES_BEFORE_BAN", 1),
      banMs: int(env.QUEUE_BAN_MS, 5 * 60000, "QUEUE_BAN_MS", 0),
      strikeDecayMs: int(env.STRIKE_DECAY_MS, 24 * 3600000, "STRIKE_DECAY_MS", 0),
    },

    responsible: {
      /* loosening a loss limit (raising it, or switching it off) only takes effect after this delay */
      lossLimitDelayMs: int(env.LOSS_LIMIT_DELAY_MS, 24 * 3600000, "LOSS_LIMIT_DELAY_MS", 0),
    },

    auth: {
      nonceTtlMs: 5 * 60000,
      sessionTtlMs: int(env.SESSION_TTL_MS, 7 * 24 * 3600000, "SESSION_TTL_MS", 1000),
    },

    rate: {
      authPerMin: int(env.RATE_AUTH_PER_MIN, 20, "RATE_AUTH_PER_MIN", 1),
      apiPerMin: int(env.RATE_API_PER_MIN, 240, "RATE_API_PER_MIN", 1),
      wsPerSec: int(env.RATE_WS_PER_SEC, 20, "RATE_WS_PER_SEC", 1),
    },
  };

  merge(cfg, overrides);
  validate(cfg);
  return cfg;
}

function validate(cfg) {
  const e = cfg.economy;
  if (e.minStake > e.maxStake) throw new Error("config: MIN_STAKE_WEI must be <= MAX_STAKE_WEI");
  for (const t of e.stakeTiers) if (t < e.minStake || t > e.maxStake) throw new Error(`config: stake tier ${t} is outside [MIN_STAKE_WEI, MAX_STAKE_WEI]`);
  if (e.minWithdrawal > e.maxWithdrawal) throw new Error("config: MIN_WITHDRAWAL_WEI must be <= MAX_WITHDRAWAL_WEI");
  if (!(cfg.match.durationFactor >= 1)) throw new Error("config: MATCH_DURATION_FACTOR must be >= 1");
  if (!(cfg.match.durationScale > 0)) throw new Error("config: MATCH_DURATION_SCALE must be > 0");
  if (cfg.production) {
    if (cfg.chain.rpcUrl && !cfg.keys.mnemonic) throw new Error("config: HD_MNEMONIC is required in production (refusing to generate a dev wallet)");
    if (cfg.allowedOrigins.includes("*")) throw new Error("config: set ALLOWED_ORIGINS explicitly in production");
    if (cfg.adminToken && cfg.adminToken.length < 24) throw new Error("config: ADMIN_TOKEN must be at least 24 characters");
  }
}
