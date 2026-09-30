/* Test harness: a full app (in-memory DB, real HTTP + WebSocket on an ephemeral port) and players that talk to it
   through the same DuelClient a real client would use. Funding is a direct ledger credit — the on-chain path is covered
   by wallet.chain.test.js and e2e.test.js. */
import { Wallet } from "ethers";
import { loadConfig } from "../../src/config.js";
import { createApp } from "../../src/app.js";
import { ACCT } from "../../src/ledger.js";
import { DuelClient } from "../../client/duel-client.js";

export const ETH = 10n ** 18n;
export const mETH = ETH / 1000n; // 0.001

/* Timings are tiny so a whole match takes a fraction of a second; every test can override them. */
export const FAST = {
  match: {
    acceptMs: 500, countdownMs: 40, graceMs: 200, durationScale: 0.004, durationFactor: 1.5,
    queueTimeoutMs: 3000, disconnectQueueMs: 150, pairIntervalMs: 40, banMs: 60000,
  },
  economy: { minStake: mETH / 100n, maxStake: ETH / 10n, stakeTiers: [mETH] },
  rate: { authPerMin: 1000, apiPerMin: 100000, wsPerSec: 500 },
};

export async function startApp(overrides = {}) {
  const cfg = loadConfig({ NODE_ENV: "test", PORT: "0", HOST: "127.0.0.1" }, {
    dbPath: ":memory:", chain: { rpcUrl: "" }, ...merge(structuredCloneSafe(FAST), overrides),
  });
  const app = await createApp(cfg);
  await app.start();
  const players = [];
  const helpers = {
    app,
    url: app.url,
    /* a signed-in, connected, funded player */
    async player({ fund = 100n * mETH, adult = true, connect = true, name } = {}) {
      const wallet = Wallet.createRandom();
      const client = new DuelClient({ baseUrl: app.url, address: wallet.address, sign: (m) => wallet.signMessage(m) });
      await client.login();
      if (connect) await client.connect();
      const id = client.me.id;
      if (fund > 0n) helpers.credit(id, fund);
      if (adult) await client.api("POST", "/v1/me/age", { adult: true });
      if (name) await client.api("PATCH", "/v1/me", { displayName: name });
      const p = { client, wallet, id, address: wallet.address.toLowerCase(), bal: () => app.ledger.balance(ACCT.user(id)) };
      players.push(p);
      return p;
    },
    /* simulate an on-chain deposit: external → user */
    credit(userId, wei) {
      helpers.seq = (helpers.seq || 0) + 1;
      app.ledger.post({ kind: "deposit", ref: `test-${helpers.seq}`, uniq: `test-deposit:${helpers.seq}`, entries: [[ACCT.chain, -wei], [ACCT.user(userId), wei]] });
    },
    house: () => app.ledger.balance(ACCT.house),
    /* both players queue for the same game/stake and end up in a match; returns their match ids */
    async pair(a, b, { game = "reaction", stake = mETH, code } = {}) {
      await a.client.joinQueue({ game, stake: String(stake), code });
      await b.client.joinQueue({ game, stake: String(stake), code });
      const [fa, fb] = await Promise.all([a.client.waitFor("match.found"), b.client.waitFor("match.found")]);
      return { id: fa.match.id, a: fa.match, b: fb.match };
    },
    /* both ready → both get the seed → wait until the match's start time */
    async begin(a, b, matchId) {
      await a.client.ready(matchId);
      await b.client.ready(matchId);
      const [sa, sb] = await Promise.all([a.client.waitFor("match.start"), b.client.waitFor("match.start")]);
      const wait = sa.startAt - a.client.serverNow();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait + 10));
      return { a: sa, b: sb };
    },
    async close() {
      for (const p of players) p.client.close();
      await app.stop();
    },
  };
  return helpers;
}

function structuredCloneSafe(o) {
  return { match: { ...o.match }, economy: { ...o.economy }, rate: { ...o.rate } };
}
function merge(a, b) {
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof v !== "bigint" && a[k] && typeof a[k] === "object") merge(a[k], v);
    else a[k] = v;
  }
  return a;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
