/* Entry point: `npm start`. Configuration comes from environment variables (see .env.example / README). */
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { createLogger } from "./util/log.js";

const config = loadConfig();
const log = createLogger(config.logLevel);

process.on("unhandledRejection", (e) => log.error("unhandled rejection", { error: e instanceof Error ? e : new Error(String(e)) }));
process.on("uncaughtException", (e) => { log.error("uncaught exception", { error: e }); process.exit(1); });

let app;
try {
  app = await createApp(config);
  await app.start();
} catch (e) {
  log.error("failed to start", { error: e });
  process.exit(1);
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal: sig });
    try { await app.stop(); } finally { process.exit(0); }
  });
}
