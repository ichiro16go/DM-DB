/**
 * Web UI + API + MCP (HTTP) server.
 *   tsx src/server/index.ts [--port=8787] [--db=data/dm.sqlite] [--store=gs://bucket/prefix]
 * Configuration: see src/server/config.ts.
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { relative, join } from "node:path";
import { ROOT } from "../lib/raw.js";
import { openStore } from "../storage/object-store.js";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { DbHolder } from "./db-holder.js";

const log = (msg: string) => console.log(JSON.stringify({ severity: "INFO", message: msg }));

async function main() {
  const config = loadConfig(undefined, process.argv.slice(2));
  const holder = new DbHolder({
    path: config.dbPath,
    store: config.dataStore ? openStore(config.dataStore) : undefined,
    refreshMs: config.refreshSeconds * 1000,
    log,
  });
  await holder.init();

  const app = createApp(holder, { auth: config.auth });
  const webRoot = relative(process.cwd(), join(ROOT, "web")) || ".";
  app.use("/*", serveStatic({ root: webRoot }));

  const mode = config.auth.public ? "PUBLIC (no auth)" : [config.auth.basic && "basic", config.auth.token && "token"].filter(Boolean).join("+");
  serve({ fetch: app.fetch, port: config.port }, (info) => log(`DM card DB on :${info.port} (db ${holder.version}, auth ${mode})`));
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? `config error: ${e.message}` : e);
  process.exit(1);
});
