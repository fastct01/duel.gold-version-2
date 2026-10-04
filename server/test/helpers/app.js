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
    banMs: 60000,
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
    /* a signed-in, connected, funded player; adult: false skips the 18+ attestation that staked lobbies require */
    async player({ fund = 100n * mETH, connect = true, name, adult = true } = {}) {
      const wallet = Wallet.createRandom();
      const client = new DuelClient({ baseUrl: app.url, address: wallet.address, sign: (m) => wallet.signMessage(m) });
      await client.login();
      if (connect) await client.connect();
      const id = client.me.id;
      if (fund > 0n) helpers.credit(id, fund);
      if (name) await client.api("PATCH", "/v1/me", { displayName: name });
      if (adult) await client.api("POST", "/v1/me/age", { adult: true });
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
    /* two players meet the only way there is: an invite lobby. `a` hosts, `b` joins with the code, `a` starts it; both then
       have match.found. Returns { id, a, b } with each player's view of the match (state "found"). */
    async pair(a, b, { game = "reaction", stake = mETH } = {}) {
      const m = await helpers.lobbyMatch([a, b], { game, stake });
      const [va, vb] = await Promise.all([a, b].map((p) => p.client.api("GET", `/v1/matches/${m.id}`)));
      return { id: m.id, a: va, b: vb, code: m.code };
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
    /* every player ready → everybody gets the seed → wait until the shared start time. Returns the match.start messages. */
    async beginAll(group, matchId) {
      for (const p of group) await p.client.ready(matchId);
      const starts = await Promise.all(group.map((p) => p.client.waitFor("match.start")));
      const wait = starts[0].startAt - group[0].client.serverNow();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait + 10));
      return starts;
    },
    /* a lobby: the first player hosts, the rest join over REST. Returns { code, lobby, match }: the lobby as the last joiner
       saw it, and that joiner's view of the match when their join filled the lobby and started it (otherwise undefined). */
    async lobbyOf(group, { game = "reaction", stake = mETH } = {}) {
      const [host, ...guests] = group;
      const { code } = await host.client.createLobby({ game, stake: String(stake) });
      let out = null;
      for (const g of guests) out = await g.client.joinLobby(code);
      return { code, lobby: out && out.lobby, match: out && out.match };
    },
    /* a lobby of `group` played through the real flow: create → join → host starts (unless the lobby filled and started itself)
       → everyone has match.found. Returns { code, id, match } where match is the host's view. */
    async lobbyMatch(group, opts = {}) {
      const { code, match: auto } = await helpers.lobbyOf(group, opts);
      const m = auto ? await group[0].client.api("GET", `/v1/matches/${auto.id}`) : await group[0].client.startLobby(code);
      await Promise.all(group.map((p) => p.client.waitFor("match.found", (e) => e.match.id === m.id)));
      return { code, id: m.id, match: m };
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
