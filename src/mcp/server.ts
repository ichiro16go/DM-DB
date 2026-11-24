/**
 * MCP server (stdio) so an AI agent can search the DB and validate decks.
 *
 *   claude mcp add dm-cards -- npx tsx /path/to/dm-card-db/src/mcp/server.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_DB_PATH } from "../lib/raw.js";
import { openDb } from "../search/engine.js";
import { createMcpServer } from "./tools.js";

const dbPath = process.argv.find((a) => a.startsWith("--db="))?.split("=")[1] ?? DEFAULT_DB_PATH;
await createMcpServer(openDb(dbPath)).connect(new StdioServerTransport());
