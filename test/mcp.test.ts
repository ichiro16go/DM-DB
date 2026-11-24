import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Database } from "better-sqlite3";
import { createMcpServer } from "../src/mcp/tools.js";
import { buildFixtureDb } from "./helpers/fixture-db.js";

let db: Database;
let client: Client;

beforeAll(async () => {
  db = buildFixtureDb().db;
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer(db).connect(serverT);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
});
afterAll(async () => {
  await client?.close();
  db?.close();
});

const text = (r: unknown) => ((r as { content: { type: string; text: string }[] }).content ?? []).map((c) => c.text).join("\n");

describe("MCP tools", () => {
  it("lists the tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_card", "list_keywords", "search_cards", "validate_deck"]);
  });
  it("search_cards returns readable card text", async () => {
    const r = await client.callTool({ name: "search_cards", arguments: { query: "kw:ジャストダイバー", limit: 5 } });
    const t = text(r);
    expect(t).toMatch(/^2件ヒット/);
    expect(t).toContain("《アルケミック・プラチナム》");
    expect(t).toContain("ジャストダイバー");
  });
  it("search_cards reports query errors as tool errors", async () => {
    const r = await client.callTool({ name: "search_cards", arguments: { query: "kw:存在しない能力" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/クエリエラー/);
  });
  it("get_card by face name", async () => {
    const r = await client.callTool({ name: "get_card", arguments: { name: "ボルメテウス・レジェンド・フレア" } });
    expect(text(r)).toContain("《ボルメテウス・ホワイト・ドラゴン / ボルメテウス・レジェンド・フレア》");
    expect(text(r)).toMatch(/収録\(1\)/);
  });
  it("validate_deck", async () => {
    const r = await client.callTool({ name: "validate_deck", arguments: { format: "original", decklist: "4 熱血の親衛隊クラップ" } });
    expect(text(r)).toMatch(/違反/);
    expect(text(r)).toMatch(/40枚ちょうど/);
  });
});
