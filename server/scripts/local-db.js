#!/usr/bin/env node
/* A local Postgres for development and tests, in Docker:   npm run db
   Starts (or creates) the container "playvault-pg" — Postgres 17 on 127.0.0.1:54329 — and waits until it accepts
   connections. Its address is LOCAL_DATABASE_URL in src/config.js, which development and the tests use by default.
   Production never uses it: there DATABASE_URL is required (Supabase). */
import { execFileSync } from "node:child_process";

const NAME = "playvault-pg";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

try { docker("info", "--format", "{{.ServerVersion}}"); }
catch { console.error("Docker is not running. Start Docker Desktop, then run `npm run db` again."); process.exit(1); }

const exists = docker("ps", "-a", "--filter", `name=^${NAME}$`, "--format", "{{.Names}}") === NAME;
if (!exists) {
  docker("run", "-d", "--name", NAME, "--restart", "unless-stopped", "-e", "POSTGRES_PASSWORD=playvault",
    "-p", "127.0.0.1:54329:5432", "postgres:17");
} else {
  docker("start", NAME);
}
for (let i = 0; ; i++) {
  try { docker("exec", NAME, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"); break; }
  catch { if (i > 60) { console.error("Postgres did not become ready."); process.exit(1); } await new Promise((r) => setTimeout(r, 500)); }
}
console.log(`Postgres is ready: postgres://postgres:playvault@127.0.0.1:54329/postgres (container ${NAME})`);
