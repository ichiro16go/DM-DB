/**
 * Local web UI + API.
 *   tsx src/server/index.ts [--port=8787] [--db=data/dm.sqlite]
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { relative, join } from "node:path";
import { DEFAULT_DB_PATH, ROOT } from "../lib/raw.js";
import { openDb } from "../search/engine.js";
import { createApp } from "./app.js";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const port = Number(arg("port") ?? 8787);
const db = openDb(arg("db") ?? DEFAULT_DB_PATH);
const app = createApp(db);
const webRoot = relative(process.cwd(), join(ROOT, "web")) || ".";
app.use("/*", serveStatic({ root: webRoot }));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`DM card DB: http://localhost:${info.port}`);
});
