/**
 * Web UI + API + MCP (HTTP) server.
 *   tsx src/server/index.ts [--port=8787] [--db=data/dm.sqlite] [--store=gs://bucket/prefix]
 * Configuration: see src/server/config.ts.
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { relative, join } from "node:path";
import { DEFAULT_STORE, ROOT } from "../lib/raw.js";
import { DeckStore } from "../decks/store.js";
import { MetaRepo } from "../meta/repo.js";
import { MetaService } from "../meta/service.js";
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

  // Writable store for decks and meta data: the same store as the DB, or a local directory.
  const store = openStore(config.dataStore ?? DEFAULT_STORE);
  const decks = new DeckStore(store);
  const meta = new MetaService(new MetaRepo(store), decks, config.refreshSeconds * 1000, log);
  await meta.init().catch((e) => log(`meta not loaded yet: ${String(e)}`));

  const app = createApp(holder, { auth: config.auth, decks, meta });
  // React UI (web/dist, built by `npm run build:web`): static files, then index.html for client-side routes.
  const webDir = join(ROOT, "web", "dist");
  const webRoot = relative(process.cwd(), webDir) || ".";
  const indexHtml = existsSync(join(webDir, "index.html")) ? readFileSync(join(webDir, "index.html"), "utf8") : null;
  if (!indexHtml) log("web/dist/index.html not found: run `npm run build:web` to serve the UI");
  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.ok) c.header("cache-control", "public, max-age=31536000, immutable");
  });
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("*", (c) => {
    if (!indexHtml || /^\/(api|mcp)(\/|$)/.test(c.req.path) || /\.[a-z0-9]+$/i.test(c.req.path)) return c.notFound();
    c.header("cache-control", "no-cache");
    return c.html(indexHtml);
  });

  const mode = config.auth.public ? "PUBLIC (no auth)" : [config.auth.basic && "basic", config.auth.token && "token"].filter(Boolean).join("+");
  serve({ fetch: app.fetch, port: config.port }, (info) => log(`DM card DB on :${info.port} (db ${holder.version}, auth ${mode})`));
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? `config error: ${e.message}` : e);
  process.exit(1);
});
