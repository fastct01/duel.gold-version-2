/* Wires every service together. `createApp(config)` returns an object with start()/stop(); nothing listens on a
   port or touches the chain until start(). Tests build one per case (each in its own Postgres schema). */
import http from "node:http";
import { createLogger } from "./util/log.js";
import { openDb } from "./db/index.js";
import { Ledger } from "./ledger.js";
import { Hub } from "./hub.js";
import { Users } from "./users.js";
import { Responsible } from "./responsible.js";
import { Auth } from "./auth.js";
import { Mailer } from "./mail.js";
import { EmailAuth } from "./emailAuth.js";
import { SupabaseAuth } from "./supabaseAuth.js";
import { WalletService } from "./wallet/index.js";
import { loadCatalog } from "./games/catalog.js";
import { MatchService } from "./matches/service.js";
import { Router } from "./http/router.js";
import { registerRoutes } from "./http/routes.js";
import { attachStatic } from "./http/static.js";
import { Gateway } from "./ws/gateway.js";

export async function createApp(config, { now = () => Date.now(), supabaseFetch } = {}) {
  const log = createLogger(config.logLevel);
  const db = await openDb({ ...config.db, log });
  let ledger;
  try { ledger = await new Ledger(db, now).init(); } catch (e) { await db.close(); throw e; }
  const hub = new Hub();
  const users = new Users(db, now);
  const responsible = new Responsible({ db, config, now });
  let wallet;
  try {
    wallet = await WalletService.create({ db, ledger, cfg: config, log, bus: hub, now });
  } catch (e) { await db.close(); throw e; }
  if (wallet.enabled && wallet.chain.realMoney && !config.adminToken) {
    log.warn("ADMIN_TOKEN is not set on a real-money deployment: /v1/admin/* (ledger audit, solvency, flagged scores) is disabled. Set it, and watch the logs for INSOLVENT.");
  }
  const auth = new Auth({ db, users, config, chainId: () => (wallet.enabled ? wallet.chain.chainId : 0), now });
  const mailer = new Mailer({ cfg: config, log });
  const emailDeps = { db, users, auth, mailer, config, now, baseUrl: () => config.mail.publicUrl || app.url };
  const emailAuth = config.supabase.url && config.supabase.secretKey
    ? new SupabaseAuth({ ...emailDeps, supabase: config.supabase, log, fetchImpl: supabaseFetch })
    : new EmailAuth(emailDeps);
  if (config.production && !emailAuth.enabled) log.warn("email sign-in is off: set SUPABASE_URL and SUPABASE_SECRET_KEY (or RESEND_API_KEY and MAIL_FROM) to turn it on");
  const catalog = loadCatalog({ gamesDir: config.gamesDir, log, tableOpts: config.tables });
  const matches = new MatchService({ db, ledger, users, responsible, catalog, cfg: config, log, hub, now });

  const app = { config, cfg: config, log, db, ledger, hub, users, responsible, wallet, auth, mailer, emailAuth, catalog, matches };
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
      await matches.start();
      wallet.start();
      purgeTimer = setInterval(() => auth.purge().catch((e) => log.warn("session purge failed", { error: String(e.message || e) })), 3600000);
      purgeTimer.unref?.();
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, resolve); });
      const addr = server.address();
      app.address = addr;
      app.url = `http://${addr.address === "::" ? "localhost" : addr.address}:${addr.port}`;
      log.info("PlayVault server listening", { url: app.url, wallet: wallet.enabled ? wallet.chainInfo().name : "disabled" });
      return addr;
    },
    async stop() {
      clearInterval(purgeTimer);
      gateway.close();
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
      matches.stop();
      await wallet.stop();
      await matches.flagsSettled();
      await db.exclusive(async () => {}); // let an operation that is still running finish
      await db.close();
    },
  });
  return app;
}
