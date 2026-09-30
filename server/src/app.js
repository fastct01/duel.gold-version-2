/* Wires every service together. `createApp(config)` returns an object with start()/stop(); nothing listens on a
   port or touches the chain until start(). Tests build one per case (with an in-memory database). */
import http from "node:http";
import { createLogger } from "./util/log.js";
import { openDb } from "./db/index.js";
import { Ledger } from "./ledger.js";
import { Hub } from "./hub.js";
import { Users } from "./users.js";
import { Responsible } from "./responsible.js";
import { Auth } from "./auth.js";
import { WalletService } from "./wallet/index.js";
import { loadCatalog } from "./games/catalog.js";
import { MatchService } from "./matches/service.js";
import { Router } from "./http/router.js";
import { registerRoutes } from "./http/routes.js";
import { attachStatic } from "./http/static.js";
import { Gateway } from "./ws/gateway.js";

export async function createApp(config, { now = () => Date.now() } = {}) {
  const log = createLogger(config.logLevel);
  const db = openDb(config.dbPath);
  const ledger = new Ledger(db, now);
  const hub = new Hub();
  const users = new Users(db, now);
  const responsible = new Responsible({ db, config, now });
  let wallet;
  try {
    wallet = await WalletService.create({ db, ledger, cfg: config, log, bus: hub, now });
  } catch (e) { db.close(); throw e; }
  const auth = new Auth({ db, users, config, chainId: () => (wallet.enabled ? wallet.chain.chainId : 0), now });
  const catalog = loadCatalog({ gamesDir: config.gamesDir, log });
  const matches = new MatchService({ db, ledger, users, responsible, catalog, cfg: config, log, hub, now });

  const app = { config, cfg: config, log, db, ledger, hub, users, responsible, wallet, auth, catalog, matches };
  const router = new Router({ cfg: config, log, auth, now });
  registerRoutes(router, app);
  attachStatic(router, config);

  const server = http.createServer(router.handler());
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  const gateway = new Gateway({ server, cfg: config, log, auth, hub, matches, meView: app.meView, now });
  let purgeTimer = null;

  Object.assign(app, {
    server, gateway, router,
    /* Recover unfinished matches first, then start the chain workers, then accept connections. */
    async start() {
      matches.start();
      wallet.start();
      purgeTimer = setInterval(() => auth.purge(), 3600000);
      purgeTimer.unref?.();
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, resolve); });
      const addr = server.address();
      app.address = addr;
      app.url = `http://${addr.address === "::" ? "localhost" : addr.address}:${addr.port}`;
      log.info("duel.gold server listening", { url: app.url, wallet: wallet.enabled ? wallet.chainInfo().name : "disabled" });
      return addr;
    },
    async stop() {
      clearInterval(purgeTimer);
      gateway.close();
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
      matches.stop();
      await wallet.stop();
      db.close();
    },
  });
  return app;
}
