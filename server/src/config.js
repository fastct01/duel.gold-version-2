/* Configuration: environment variables → one validated plain object. Tests pass `overrides` instead of env. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWei } from "./util/amounts.js";
import { MAINNETS } from "./wallet/networks.js";

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

const feeMode = (v, d) => {
  if (v == null || v === "") return d;
  const m = String(v).trim().toLowerCase();
  if (m !== "estimate" && m !== "fixed") throw new Error(`config: WITHDRAWAL_FEE_MODE must be "estimate" or "fixed", got "${v}"`);
  return m;
};

function merge(base, extra) {
  if (!extra) return base;
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof v !== "bigint" && base[k] && typeof base[k] === "object") merge(base[k], v);
    else base[k] = v;
  }
  return base;
}

const NETWORKS = ["mainnet", "testnet", "local"];
const LOCALISH = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$|\.localhost$/i;

export function loadConfig(env = process.env, overrides = {}) {
  const nodeEnv = env.NODE_ENV || "development";
  const production = nodeEnv === "production";
  /* NETWORK=mainnet is the explicit opt-in to real money. Without it the server only ever runs on test or local chains. */
  const network = String(env.NETWORK || "").trim().toLowerCase();
  if (network && !NETWORKS.includes(network)) throw new Error(`config: NETWORK must be one of ${NETWORKS.join(", ")} (or unset), got "${env.NETWORK}"`);
  const mainnet = network === "mainnet";

  const cfg = {
    env: nodeEnv,
    production,
    network, // the operator's declaration ("" = unset: test and local chains only); the chain actually connected is checked at startup
    mainnet,
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
      rpcUrl: env.RPC_URL || (mainnet ? "" : "http://127.0.0.1:8545"), // on mainnet there is no localhost fallback
      expectedChainId: env.CHAIN_ID ? int(env.CHAIN_ID, null, "CHAIN_ID", 1) : null,
      confirmations: int(env.CONFIRMATIONS, mainnet ? 12 : 6, "CONFIRMATIONS", 1, 1000),
      pollMs: int(env.POLL_MS, 4000, "POLL_MS", 50),
      startBlock: env.START_BLOCK ? int(env.START_BLOCK, null, "START_BLOCK", 0) : null,
      sweepIntervalMs: int(env.SWEEP_INTERVAL_MS, 30000, "SWEEP_INTERVAL_MS", 50),
      sweepMinWei: wei(env.SWEEP_MIN_WEI, ETH / 2000n, "SWEEP_MIN_WEI"), // 0.0005
      /* a deposit address is swept only when its balance is at least this many times the sweep's gas cost (L1 gas is real money) */
      sweepMinMultiplier: int(env.SWEEP_MIN_MULTIPLIER, mainnet ? 3 : 1, "SWEEP_MIN_MULTIPLIER", 1, 1000),
      /* background solvency check (assets vs ledger liabilities) that logs an error when insolvent; 0 = off */
      solvencyCheckMs: int(env.SOLVENCY_CHECK_MS, mainnet ? 300000 : 0, "SOLVENCY_CHECK_MS", 0),
      withdrawIntervalMs: int(env.WITHDRAW_INTERVAL_MS, 5000, "WITHDRAW_INTERVAL_MS", 50),
      rebroadcastAfterMs: int(env.REBROADCAST_AFTER_MS, 120000, "REBROADCAST_AFTER_MS", 50),
    },

    keys: {
      mnemonic: env.HD_MNEMONIC || "",
      devMnemonicFile: path.join(SERVER_ROOT, "data", "dev-mnemonic.txt"),
    },

    /* Defaults differ by network: mainnet gets real-money-sized stakes and a minimum deposit/withdrawal that gas cannot eat. */
    economy: {
      feeBps: int(env.FEE_BPS, 1000, "FEE_BPS", 0, 5000), // 10%
      minStake: wei(env.MIN_STAKE_WEI, mainnet ? ETH / 1000n : ETH / 10000n, "MIN_STAKE_WEI"), // mainnet 0.001, else 0.0001
      maxStake: wei(env.MAX_STAKE_WEI, ETH / 20n, "MAX_STAKE_WEI"), // 0.05
      stakeTiers: list(env.STAKE_TIERS_WEI, mainnet
        ? ["1000000000000000", "2500000000000000", "5000000000000000", "10000000000000000", "25000000000000000"] // 0.001 / 0.0025 / 0.005 / 0.01 / 0.025
        : ["500000000000000", "1000000000000000", "2500000000000000", "5000000000000000", "10000000000000000"]).map((s) => parseWei(s, "STAKE_TIERS_WEI")),
      /* deposits are recorded as they arrive but credited only once the uncredited total at an address reaches this */
      minDeposit: wei(env.MIN_DEPOSIT_WEI, mainnet ? ETH / 200n : 0n, "MIN_DEPOSIT_WEI"), // mainnet 0.005, else off
      minWithdrawal: wei(env.MIN_WITHDRAWAL_WEI, mainnet ? ETH / 1000n : ETH / 10000n, "MIN_WITHDRAWAL_WEI"), // mainnet 0.001, else 0.0001
      maxWithdrawal: wei(env.MAX_WITHDRAWAL_WEI, ETH, "MAX_WITHDRAWAL_WEI"),
      dailyWithdrawalCap: wei(env.DAILY_WITHDRAWAL_CAP_WEI, 2n * ETH, "DAILY_WITHDRAWAL_CAP_WEI"),
      /* Network fee charged on top of every withdrawal (the player receives the full amount asked for, the fee is debited
         as well). estimate = current gas estimate + margin; fixed = WITHDRAWAL_FEE_WEI. Off (fixed 0) outside mainnet. */
      withdrawalFee: {
        mode: feeMode(env.WITHDRAWAL_FEE_MODE, mainnet ? "estimate" : "fixed"),
        fixed: wei(env.WITHDRAWAL_FEE_WEI, 0n, "WITHDRAWAL_FEE_WEI"),
        marginBps: int(env.WITHDRAWAL_FEE_MARGIN_BPS, 2500, "WITHDRAWAL_FEE_MARGIN_BPS", 0, 100000), // +25% over the estimate
      },
    },

    match: {
      acceptMs: int(env.MATCH_ACCEPT_MS, 15000, "MATCH_ACCEPT_MS", 20),
      countdownMs: int(env.MATCH_COUNTDOWN_MS, 3000, "MATCH_COUNTDOWN_MS", 0),
      graceMs: int(env.MATCH_GRACE_MS, 15000, "MATCH_GRACE_MS", 0),
      /* submit deadline = start + nominal game length × durationFactor × durationScale + grace */
      durationFactor: Number(env.MATCH_DURATION_FACTOR || 1.5),
      durationScale: Number(env.MATCH_DURATION_SCALE || 1),
      /* There is no public matchmaking: players reach each other only through invite lobbies (code or link).
         Invite-only lobbies: how long an unclaimed lobby (and the host's escrowed stake) stays open */
      lobbyTtlMs: int(env.LOBBY_TTL_MS, 30 * 60000, "LOBBY_TTL_MS", 20),
      /* most players one invite lobby can hold (host included); the lobby auto-starts the moment it is full. 2 = classic 1v1 */
      lobbyMaxPlayers: int(env.LOBBY_MAX_PLAYERS, 10, "LOBBY_MAX_PLAYERS", 2, 10),
      maxScore: Number(env.MAX_SCORE || 1e7),
      strikesBeforeBan: int(env.STRIKES_BEFORE_BAN, 3, "STRIKES_BEFORE_BAN", 1),
      banMs: int(env.QUEUE_BAN_MS, 5 * 60000, "QUEUE_BAN_MS", 0), // temporary ban from hosting/joining after repeated no-shows (name kept for compatibility)
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
  /* Secrets stay out of JSON.stringify(cfg) and console.log(cfg) so a careless log line cannot leak them. */
  for (const [obj, key] of [[cfg.keys, "mnemonic"], [cfg, "adminToken"]]) {
    Object.defineProperty(obj, key, { value: obj[key], writable: true, enumerable: false, configurable: true });
  }
  validate(cfg, { trustProxyExplicit: (env.TRUST_PROXY != null && env.TRUST_PROXY !== "") || (overrides && overrides.trustProxy !== undefined), trustProxyRaw: env.TRUST_PROXY });
  return cfg;
}

function validate(cfg, ctx = {}) {
  const e = cfg.economy;
  if (e.minStake > e.maxStake) throw new Error("config: MIN_STAKE_WEI must be <= MAX_STAKE_WEI");
  for (const t of e.stakeTiers) if (t < e.minStake || t > e.maxStake) throw new Error(`config: stake tier ${t} is outside [MIN_STAKE_WEI, MAX_STAKE_WEI]`);
  if (e.minWithdrawal > e.maxWithdrawal) throw new Error("config: MIN_WITHDRAWAL_WEI must be <= MAX_WITHDRAWAL_WEI");
  if (!(cfg.match.durationFactor >= 1)) throw new Error("config: MATCH_DURATION_FACTOR must be >= 1");
  if (!(cfg.match.durationScale > 0)) throw new Error("config: MATCH_DURATION_SCALE must be > 0");
  const lmp = cfg.match.lobbyMaxPlayers; // also checked here because test/programmatic overrides bypass the env parser
  if (!Number.isInteger(lmp) || lmp < 2 || lmp > 10) throw new Error(`config: LOBBY_MAX_PLAYERS must be an integer in [2, 10], got "${lmp}"`);
  const fee = e.withdrawalFee;
  if (fee.mode !== "estimate" && fee.mode !== "fixed") throw new Error(`config: WITHDRAWAL_FEE_MODE must be "estimate" or "fixed", got "${fee.mode}"`);
  if (cfg.chain.sweepMinMultiplier < 1) throw new Error("config: SWEEP_MIN_MULTIPLIER must be >= 1");
  if (cfg.devFaucet && cfg.mainnet) throw new Error("config: the dev faucet can never be enabled with NETWORK=mainnet");
  /* a mainnet chain id without the explicit opt-in is caught here too, before any RPC call */
  const id = cfg.chain.expectedChainId;
  if (id != null && MAINNETS.has(id) && !cfg.mainnet) {
    throw new Error(`config: CHAIN_ID ${id} (${MAINNETS.get(id).name}) is a mainnet where funds have real value. Set NETWORK=mainnet to run with real money on purpose.`);
  }
  if (cfg.mainnet) validateMainnet(cfg, ctx);
  if (cfg.production) {
    if (cfg.chain.rpcUrl && !cfg.keys.mnemonic) throw new Error("config: HD_MNEMONIC is required in production (refusing to generate a dev wallet)");
    if (cfg.allowedOrigins.includes("*")) throw new Error("config: set ALLOWED_ORIGINS explicitly in production");
    if (cfg.adminToken && cfg.adminToken.length < 24) throw new Error("config: ADMIN_TOKEN must be at least 24 characters");
  }
}

/* NETWORK=mainnet moves real money, so nothing may be left to a default. Every problem is reported in one error. */
function validateMainnet(cfg, ctx) {
  const problems = [];
  if (!cfg.production) problems.push(`NODE_ENV=production is required with NETWORK=mainnet (got "${cfg.env}")`);
  if (!cfg.keys.mnemonic) problems.push("HD_MNEMONIC is required with NETWORK=mainnet (the server will not generate a wallet for real money)");
  const origins = cfg.allowedOrigins;
  if (!origins.length || origins.includes("*")) {
    problems.push('ALLOWED_ORIGINS must list your front-end origin(s) explicitly, e.g. https://duel.example ("*" is not allowed with NETWORK=mainnet)');
  } else {
    for (const o of origins) {
      let ok = false;
      try { const u = new URL(o); ok = u.protocol === "https:" && u.origin === o; } catch { /* not a URL */ }
      if (!ok) problems.push(`ALLOWED_ORIGINS entry "${o}" must be an https origin like https://duel.example (no path, no trailing slash)`);
    }
  }
  const domain = String(cfg.publicDomain || "").trim();
  if (!domain || LOCALISH.test(domain) || /[/:\s]/.test(domain)) {
    problems.push(`PUBLIC_DOMAIN must be your real public host name, e.g. duel.example (got "${domain || ""}"; not localhost, no scheme or port)`);
  }
  if (cfg.chain.expectedChainId == null) {
    problems.push(`CHAIN_ID is required with NETWORK=mainnet (${[...MAINNETS].map(([i, m]) => `${i} for ${m.name}`).join(", ")}); the RPC must report the same id`);
  } else if (!MAINNETS.has(cfg.chain.expectedChainId)) {
    problems.push(`CHAIN_ID ${cfg.chain.expectedChainId} is not a supported mainnet (${[...MAINNETS.keys()].join(", ")}) but NETWORK=mainnet is set`);
  }
  if (!cfg.chain.rpcUrl) problems.push("RPC_URL is required with NETWORK=mainnet (a mainnet JSON-RPC endpoint)");
  if (!ctx.trustProxyExplicit) {
    problems.push("TRUST_PROXY must be set explicitly (true behind a reverse proxy such as Render, false if the server is directly exposed)");
  } else if (ctx.trustProxyRaw != null && ctx.trustProxyRaw !== "" && !["1", "true", "yes", "on", "0", "false", "no", "off"].includes(String(ctx.trustProxyRaw).toLowerCase())) {
    problems.push(`TRUST_PROXY must be true or false (got "${ctx.trustProxyRaw}")`);
  }
  if (problems.length) {
    throw new Error(`config: refusing to start with NETWORK=mainnet (real money):\n  - ${problems.join("\n  - ")}`);
  }
}
