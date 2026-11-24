import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createApp } from "../src/server/app.js";
import { ConfigError, loadConfig } from "../src/server/config.js";
import { DbHolder } from "../src/server/db-holder.js";
import { openStore } from "../src/storage/object-store.js";
import { evaluateGate } from "../src/jobs/update.js";
import type { BuildReport } from "../src/db/build.js";
import { buildFixtureDb } from "./helpers/fixture-db.js";

const TOKEN = "tok_0123456789abcdefghijklmnop";
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

let fixture: ReturnType<typeof buildFixtureDb>;
beforeAll(() => {
  fixture = buildFixtureDb();
});
afterAll(() => fixture?.db.close());

describe("config", () => {
  it("refuses to start on Cloud Run without credentials", () => {
    expect(() => loadConfig({ K_SERVICE: "dm" })).toThrow(ConfigError);
    expect(loadConfig({ K_SERVICE: "dm", DM_PUBLIC: "1" }).auth.public).toBe(true);
  });
  it("is public locally when nothing is configured", () => {
    expect(loadConfig({}).auth).toEqual({ public: true });
  });
  it("validates credentials", () => {
    expect(() => loadConfig({ DM_AUTH_USER: "me" })).toThrow(/together/);
    expect(() => loadConfig({ DM_AUTH_USER: "me", DM_AUTH_PASSWORD: "short" })).toThrow(/12/);
    expect(() => loadConfig({ DM_API_TOKEN: "short" })).toThrow(/24/);
    const c = loadConfig({ DM_AUTH_USER: "me", DM_AUTH_PASSWORD: "correct-horse-battery", DM_API_TOKEN: TOKEN, PORT: "8080", DM_DATA_STORE: "gs://b/p" });
    expect(c).toMatchObject({ port: 8080, dataStore: "gs://b/p", auth: { basic: { user: "me" }, token: TOKEN } });
    expect(c.auth.public).toBeUndefined();
  });
  it("CLI flags override the environment", () => {
    expect(loadConfig({ PORT: "1" }, ["--port=2", "--db=/x.sqlite"])).toMatchObject({ port: 2, dbPath: "/x.sqlite" });
  });
});

describe("auth", () => {
  const app = () => createApp(fixture.db, { auth: { basic: { user: "me", password: "correct-horse-battery" }, token: TOKEN } });
  const get = (path: string, headers: Record<string, string> = {}) => app().request(path, { headers });

  it("health check is open, everything else needs credentials", async () => {
    expect((await get("/health")).status).toBe(200);
    expect((await get("/healthz")).status).toBe(200);
    const r = await get("/api/meta");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/Basic/);
  });
  it("accepts Basic auth and Bearer tokens, rejects wrong ones", async () => {
    expect((await get("/api/meta", { authorization: basic("me", "correct-horse-battery") })).status).toBe(200);
    expect((await get("/api/meta", { authorization: basic("me", "wrong") })).status).toBe(401);
    expect((await get("/api/meta", { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect((await get("/api/meta", { authorization: "Bearer nope" })).status).toBe(401);
  });
  it("the /mcp/<token> path only accepts the right token", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await app().request(`/mcp/${TOKEN}`, { method: "POST", headers, body })).status).toBe(200);
    expect((await app().request("/mcp/wrong", { method: "POST", headers, body })).status).toBe(401);
    expect((await app().request("/mcp", { method: "POST", headers, body })).status).toBe(401);
  });
});

describe("MCP over HTTP", () => {
  const app = () => createApp(fixture.db);
  const rpc = async (method: string, params: unknown) => {
    const res = await app().request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { result: { tools?: { name: string }[]; content?: { text: string }[] } };
  };
  it("lists tools and answers a search", async () => {
    expect((await rpc("tools/list", {})).result.tools!.map((t) => t.name)).toContain("search_cards");
    const r = await rpc("tools/call", { name: "search_cards", arguments: { query: "kw:ジャストダイバー" } });
    expect(r.result.content![0]!.text).toMatch(/^2件ヒット/);
  });
});

describe("DbHolder + object store", () => {
  it("downloads the published DB, then hot-swaps when a new version appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dmstore-"));
    const store = openStore(join(dir, "store"));
    const local = join(dir, "run", "dm.sqlite");
    await store.upload(fixture.path, "dm.sqlite");

    const holder = new DbHolder({ path: local, store, refreshMs: 0 });
    await holder.init();
    const v1 = holder.version;
    const app = createApp(holder);
    const count = async () => ((await (await app.request("/health")).json()) as { cards: number }).cards;
    expect(await count()).toBe(18);

    // Unchanged store → no reload.
    expect(await holder.sync()).toBe(false);

    // Publish a modified DB (one card fewer) and sync.
    const modified = join(dir, "modified.sqlite");
    copyFileSync(fixture.path, modified);
    const w = new Database(modified);
    w.pragma("foreign_keys = ON");
    w.prepare("DELETE FROM cards WHERE id = (SELECT MAX(id) FROM cards)").run();
    w.close();
    utimesSync(modified, new Date(), new Date(Date.now() + 5000));
    await store.upload(modified, "dm.sqlite");
    expect(await holder.sync()).toBe(true);
    expect(holder.version).not.toBe(v1);
    expect(await count()).toBe(17);
    holder.close();
  });

  it("falls back to the local file if the store is unreachable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dmstore-"));
    const local = join(dir, "dm.sqlite");
    copyFileSync(fixture.path, local);
    const holder = new DbHolder({ path: local, store: openStore(join(dir, "empty-store")) });
    await holder.init();
    expect(holder.version).toBe("local");
    holder.close();
  });

  it("fails clearly when there is no DB anywhere", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dmstore-"));
    const holder = new DbHolder({ path: join(dir, "none.sqlite"), store: openStore(join(dir, "empty")) });
    await expect(holder.init()).rejects.toThrow(/no dm.sqlite/);
  });
});

describe("update job quality gate", () => {
  const base: BuildReport = {
    printings: 24116,
    cards: 11867,
    faces: 12768,
    sets: 400,
    parseErrors: 0,
    issues: { detail_unavailable: 7 },
    keywordAgreement: [
      { keyword: "x", mode: "kwa/exact", official: 100, parsed: 100, both: 97, precision: 0.97, recall: 0.97, withConditional: { parsed: 100, both: 97 } },
    ],
  };
  const prev = { builtAt: "", printings: 24116, cards: 11867, listed: 24123, revision: null };
  it("accepts a complete build", () => {
    expect(evaluateGate(base, 24123, prev)).toEqual([]);
    expect(evaluateGate({ ...base, printings: 24200, cards: 11900 }, 24207, prev)).toEqual([]);
  });
  it("rejects incomplete or degraded builds", () => {
    expect(evaluateGate({ ...base, printings: 20000 }, 24123, prev).join()).toMatch(/crawl incomplete/);
    expect(evaluateGate({ ...base, parseErrors: 3 }, 24123, prev).join()).toMatch(/parse errors/);
    expect(evaluateGate({ ...base, cards: 11000 }, 24123, prev).join()).toMatch(/cards dropped/);
    expect(evaluateGate({ ...base, issues: { detail_unavailable: 7, regulation_unresolved: 2 } }, 24123, prev).join()).toMatch(/regulation/);
    const broken = { ...base, keywordAgreement: [{ ...base.keywordAgreement[0]!, both: 50 }] };
    expect(evaluateGate(broken, 24123, prev).join()).toMatch(/keyword precision/);
  });
});
