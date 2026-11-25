import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { createApp } from "../src/server/app.js";
import { DeckInputError, MAX_REVISIONS, sanitizeInput } from "../src/decks/model.js";
import { DeckNotFoundError, DeckStore } from "../src/decks/store.js";
import { seedDecks } from "../src/decks/seed.js";
import { openStore, PreconditionFailedError } from "../src/storage/object-store.js";
import { buildFixtureDb } from "./helpers/fixture-db.js";

const tmpStore = () => openStore(mkdtempSync(join(tmpdir(), "dm-decks-")));
const card = (name: string, count = 4) => ({ zone: "main" as const, name, count });

describe("sanitizeInput", () => {
  it("merges duplicate rows and trims names", () => {
    expect(sanitizeInput({ cards: [card(" A ", 2), card("A", 1)] }).cards).toEqual([card("A", 3)]);
  });
  it("rejects bad input", () => {
    expect(() => sanitizeInput({ name: "" })).toThrow(DeckInputError);
    expect(() => sanitizeInput({ format: "x" as never })).toThrow(DeckInputError);
    expect(() => sanitizeInput({ cards: [card("A", 0)] })).toThrow(DeckInputError);
    expect(() => sanitizeInput({ cards: [{ zone: "deck" as never, name: "A", count: 1 }] })).toThrow(DeckInputError);
    expect(() => sanitizeInput({ source: { eventId: "1" } as never })).toThrow(DeckInputError);
  });
  it("sanitizes the source (https only, bounded strings)", () => {
    const s = sanitizeInput({
      source: {
        eventId: 1,
        placementIdx: 2,
        url: "https://supersolenoid.jp/blog-entry-1.html",
        image: "javascript:alert(1)",
        eventName: "x".repeat(300),
        date: "2026-11-22",
        rank: "優勝",
        player: null,
        archetype: "a",
      },
    }).source!;
    expect(s.image).toBeNull();
    expect(s.eventName).toHaveLength(200);
    expect(() => sanitizeInput({ source: { ...s, url: "http://x" } })).toThrow(/https/);
  });
});

describe("DeckStore", () => {
  it("creates, updates with revisions, detects conflicts, restores and deletes", async () => {
    const decks = new DeckStore(tmpStore());
    const { deck, version } = await decks.create({ name: "d", format: "original", cards: [card("A")] }, "me");
    expect(deck.id).toMatch(/^u-/);
    const u1 = await decks.update(deck.id, { cards: [card("A", 3)] }, version, "you");
    expect(u1.deck.revisions).toHaveLength(1);
    expect(u1.deck.revisions[0]).toMatchObject({ by: "me", cards: [card("A")] });
    expect(u1.deck.updatedBy).toBe("you");
    // a client still holding the first version must not overwrite the second save
    await expect(decks.update(deck.id, { note: "stale" }, version, "me")).rejects.toBeInstanceOf(PreconditionFailedError);
    const r = await decks.restore(deck.id, 0, u1.version, "me");
    expect(r.deck.cards).toEqual([card("A")]);
    expect(r.deck.revisions).toHaveLength(2); // the restored-over version is kept too
    expect((await decks.list(true)).map((d) => d.id)).toEqual([deck.id]);
    await expect(decks.delete(deck.id, version)).rejects.toBeInstanceOf(PreconditionFailedError);
    await decks.delete(deck.id, r.version);
    await expect(decks.get(deck.id)).rejects.toBeInstanceOf(DeckNotFoundError);
  });

  it(`keeps at most ${MAX_REVISIONS} revisions`, async () => {
    const decks = new DeckStore(tmpStore());
    let { deck, version } = await decks.create({ name: "d", format: "original" }, null);
    for (let i = 1; i <= MAX_REVISIONS + 3; i++) ({ deck, version } = await decks.update(deck.id, { note: String(i) }, version, null));
    expect(deck.revisions).toHaveLength(MAX_REVISIONS);
    expect(deck.revisions[0]!.note).toBe(String(MAX_REVISIONS + 2));
  });

  it("seeds bundled lists once and never overwrites user corrections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-seed-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "5-1.txt"), "# event: 5\n# placement: 1\n# archetype: X\n# format: original\n4 A\n");
    writeFileSync(join(dir, "5-2.txt"), "# event: 5\n# placement: 2\n# status: unreadable\n");
    const decks = new DeckStore(tmpStore());
    expect((await seedDecks(decks, dir, [])).created).toBe(1);
    const { deck, version } = await decks.get("m-5-1");
    expect(deck).toMatchObject({ kind: "meta", archetype: "X", cards: [card("A")] });
    await decks.update(deck.id, { cards: [card("B")] }, version, "me");
    expect((await seedDecks(decks, dir, [])).created).toBe(0);
    expect((await decks.get("m-5-1")).deck.cards).toEqual([card("B")]);
  });
});

describe("deck API", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    db = buildFixtureDb().db;
    app = createApp(db, { decks: new DeckStore(tmpStore()) });
  });
  afterAll(() => db?.close());
  const req = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });

  it("analyzes, saves canonical names, and enforces versions", async () => {
    const a = await (
      await req("POST", "/api/decks/analyze", { format: "original", cards: [card("ボルメテウス・サファイア・ドラゴン"), card("存在しないカード", 1)] })
    ).json();
    expect(a.counts).toEqual({ main: 5, hyperspatial: 0, gr: 0, special: 0, unknown: 1 });
    expect(a.cards[0]).toMatchObject({ method: "exact", cost: expect.any(Number) });
    expect(a.problems.join()).toMatch(/存在しないカード/);
    expect(a.report.problems.map((p: { message: string }) => p.message).join()).toMatch(/現在 5 枚、うち特定できないカード 1 枚/);

    const created = await req("POST", "/api/decks", { name: "テスト", format: "original", cards: [card("ボルメテウスサファイアドラゴン")] });
    expect(created.status).toBe(201);
    const c = await created.json();
    expect(c.deck.cards[0].name).toBe("ボルメテウス・サファイア・ドラゴン"); // canonicalized
    const put = await req("PUT", `/api/decks/${c.deck.id}`, { version: c.version, note: "n", kind: "meta" });
    const u = await put.json();
    expect(u.deck).toMatchObject({ note: "n", kind: "user" }); // kind is fixed after creation
    const stale = await req("PUT", `/api/decks/${c.deck.id}`, { version: c.version, note: "old" });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("conflict");
    expect((await req("PUT", `/api/decks/${c.deck.id}`, { note: "no version" })).status).toBe(400);
    expect((await req("DELETE", `/api/decks/${c.deck.id}?version=${encodeURIComponent(u.version)}`)).status).toBe(200);
    expect((await req("GET", `/api/decks/${c.deck.id}`)).status).toBe(404);
  });

  it("gives a meta deck registered for a placement the placement's id, once", async () => {
    const source = {
      eventId: 77,
      placementIdx: 3,
      url: "https://supersolenoid.jp/blog-entry-77.html",
      image: null,
      eventName: "CS",
      date: "2026-11-22",
      rank: "ベスト4",
      player: null,
      archetype: "X",
    };
    const r = await req("POST", "/api/decks", { name: "X", format: "original", kind: "meta", source, cards: [] });
    expect((await r.json()).deck.id).toBe("m-77-3");
    expect((await req("POST", "/api/decks", { name: "X", format: "original", kind: "meta", source, cards: [] })).status).toBe(409);
    const list = await (await req("GET", "/api/decks?kind=meta")).json();
    expect(list.decks.map((d: { id: string }) => d.id)).toContain("m-77-3");
  });

  it("parses deck text", async () => {
    const r = await (await req("POST", "/api/decks/parse", { text: "4 A\n2 B\n超次元\n1 C" })).json();
    expect(r.cards).toEqual([card("A"), card("B", 2), { zone: "hyperspatial", name: "C", count: 1 }]);
  });
});
