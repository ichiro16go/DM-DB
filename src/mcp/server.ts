/**
 * MCP server (stdio) so an AI agent can search the DB and validate decks.
 *
 *   claude mcp add dm-cards -- npx tsx /path/to/dm-card-db/src/mcp/server.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_DB_PATH } from "../lib/raw.js";
import { env } from "node:process";
import { openDb } from "../search/engine.js";
import { openStore } from "../storage/object-store.js";
import { DEFAULT_STORE } from "../lib/raw.js";
import { DeckStore } from "../decks/store.js";
import { MetaRepo } from "../meta/repo.js";
import { MetaService } from "../meta/service.js";
import { createMcpServer } from "./tools.js";

const dbPath = process.argv.find((a) => a.startsWith("--db="))?.split("=")[1] ?? DEFAULT_DB_PATH;
const store = openStore(process.argv.find((a) => a.startsWith("--store="))?.split("=")[1] ?? env.DM_DATA_STORE ?? DEFAULT_STORE);
const decks = new DeckStore(store);
const meta = new MetaService(new MetaRepo(store), decks);
await meta.init().catch(() => {});
await createMcpServer(openDb(dbPath), { meta, decks }).connect(new StdioServerTransport());
