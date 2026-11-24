import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { createApp } from "../src/server/app.js";
import { parseDeckText, validateDeck } from "../src/deck/validate.js";
import { buildFixtureDb } from "./helpers/fixture-db.js";

let db: Database;
let app: ReturnType<typeof createApp>;
beforeAll(() => {
  db = buildFixtureDb().db;
  app = createApp(db);
});
afterAll(() => db?.close());

const MAIN10 = [
  "天空の守護者グラン・ギューレ",
  "制服槍 ブータン",
  "魔誕邪脚ブレイズ・イヤリング",
  "ボルメテウス・ホワイト・ドラゴン / ボルメテウス・レジェンド・フレア",
  "ボルメテウス・サファイア・ドラゴン",
  "アルケミック・プラチナム",
  "クリスタル・ツヴァイランサーP’S",
  "熱血の親衛隊クラップ",
  "アアルカイトの電影",
  "神羅の銀月 ザ・ラムーン",
];
const deck40 = MAIN10.map((n) => `4 ${n}`).join("\n");

describe("deck validation", () => {
  it("accepts a legal 40-card original deck", () => {
    const r = validateDeck(db, parseDeckText(deck40, "original"));
    expect(r.problems).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.counts.main).toBe(40);
    expect(r.civs["火"]).toBe(16);
  });
  it("rejects wrong size, too many copies and unknown cards", () => {
    const r = validateDeck(db, parseDeckText(`${deck40}\n1 熱血の親衛隊クラップ\n1 存在しないカード`, "original"));
    expect(r.valid).toBe(false);
    const msgs = r.problems.map((p) => p.message).join("\n");
    expect(msgs).toMatch(/40枚ちょうど/);
    expect(msgs).toMatch(/同名カードは4枚まで.*クラップ/);
    expect(msgs).toMatch(/見つかりません/);
  });
  it("enforces zones per format", () => {
    const withPsychic = `${deck40}\n超次元\n1 切札連結 ガイアーセイ・カイザー`;
    expect(validateDeck(db, parseDeckText(withPsychic, "original")).problems.map((p) => p.message)).toContain("オリジナルでは超次元ゾーンを使用できません");
    expect(validateDeck(db, parseDeckText(withPsychic, "advance")).valid).toBe(true);
    const psychicInMain = deck40.replace("4 神羅の銀月 ザ・ラムーン", "4 切札連結 ガイアーセイ・カイザー");
    expect(validateDeck(db, parseDeckText(psychicInMain, "advance")).problems.some((p) => /メインデッキに入れられません/.test(p.message))).toBe(true);
    const grOne = `${deck40}\nGR\n1 鉄壁の守護者ガリア・ゾールα GR`;
    expect(validateDeck(db, parseDeckText(grOne, "advance")).problems.some((p) => /0枚か12枚/.test(p.message))).toBe(true);
  });
  it("parses common deck-list notations", () => {
    expect(parseDeckText("4 A\nB x3\nC×2\n超次元\n1 D").main).toEqual([
      { name: "A", count: 4 },
      { name: "B", count: 3 },
      { name: "C", count: 2 },
    ]);
  });
});

describe("HTTP API", () => {
  it("GET /api/search", async () => {
    const res = await app.request(`/api/search?q=${encodeURIComponent("kw:ジャストダイバー")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.items[0].faces[0].abilities.length).toBeGreaterThan(0);
  });
  it("GET /api/search returns 400 with a message on bad queries", async () => {
    const res = await app.request(`/api/search?q=${encodeURIComponent("(kw:ブロッカー")}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/\(/);
  });
  it("GET /api/card/:id", async () => {
    const search = await (await app.request(`/api/search?q=${encodeURIComponent("is:twinpact set:dm26bd1 order:name")}`)).json();
    const res = await app.request(`/api/card/${search.items[0].id}`);
    const card = await res.json();
    expect(card.faces).toHaveLength(2);
    expect(card.printings.length).toBeGreaterThan(0);
    expect((await app.request("/api/card/999999")).status).toBe(404);
  });
  it("GET /api/meta", async () => {
    const meta = await (await app.request("/api/meta")).json();
    expect(meta.counts.cards).toBe(18);
    expect(meta.keywords.map((k: { name: string }) => k.name)).toContain("ジャストダイバー");
    expect(meta.fields.kw.names).toContain("kw");
  });
  it("POST /api/deck/validate", async () => {
    const res = await app.request("/api/deck/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: "original", text: deck40 }),
    });
    expect((await res.json()).valid).toBe(true);
  });
});
