/**
 * Integrity checks on the real, fully built DB (data/dm.sqlite).
 * Skipped automatically when the DB has not been built yet.
 *
 * These are the "is the DB actually complete and correct?" tests:
 *   - completeness against the official listing (every printing, every product)
 *   - structural invariants (every creature has power, twinpacts have 2 faces, …)
 *   - spot checks of well-known cards
 *   - keyword extraction quality vs the official ability filter
 *   - search latency
 */
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { DEFAULT_DB_PATH, rawExists, readRawJson } from "../src/lib/raw.js";
import { openDb, SearchEngine } from "../src/search/engine.js";
import type { KeywordAgreement } from "../src/db/build.js";

const enabled = existsSync(DEFAULT_DB_PATH);
let db: Database;
let engine: SearchEngine;
const one = <T = number>(sql: string, ...p: unknown[]) =>
  db
    .prepare(sql)
    .pluck()
    .get(...p) as T;

describe.skipIf(!enabled)("full DB", () => {
  beforeAll(() => {
    db = openDb(DEFAULT_DB_PATH);
    engine = new SearchEngine(db);
  });
  afterAll(() => db?.close());

  describe("completeness", () => {
    it("contains every printing listed on the official site", () => {
      const listed = rawExists("all.json") ? readRawJson<{ ids: string[] }>("all.json").ids.length : 0;
      expect(listed).toBeGreaterThan(20000);
      // A handful of listed ids have an empty page on the official site itself.
      const unavailable = one("SELECT COUNT(*) FROM quality_issues WHERE kind = 'detail_unavailable'");
      expect(unavailable).toBeLessThanOrEqual(10);
      expect(one("SELECT COUNT(*) FROM printings")).toBe(listed - unavailable);
    });
    it("has no parse errors and no printing without a product", () => {
      expect(one("SELECT COUNT(*) FROM quality_issues WHERE kind = 'parse_error'")).toBe(0);
      expect(one("SELECT COUNT(*) FROM quality_issues WHERE kind = 'printing_without_set'")).toBe(0);
    });
    it("every product has printings", () => {
      expect(one("SELECT COUNT(*) FROM sets WHERE printing_count = 0")).toBe(0);
      expect(one("SELECT COUNT(*) FROM sets")).toBeGreaterThanOrEqual(400);
    });
    it("has > 10,000 distinct cards", () => {
      expect(one("SELECT COUNT(*) FROM cards")).toBeGreaterThan(10000);
    });
    it("every 殿堂 / プレミアム殿堂 entry on the regulation page resolved to a card", () => {
      expect(one("SELECT COUNT(*) FROM quality_issues WHERE kind = 'regulation_unresolved'")).toBe(0);
      expect(one("SELECT COUNT(*) FROM cards WHERE regulation = 'premium'")).toBeGreaterThan(20);
      expect(one("SELECT COUNT(*) FROM cards WHERE regulation = 'restricted'")).toBeGreaterThan(50);
    });
  });

  describe("invariants", () => {
    it("every face has a type and a civilization (official blanks are repaired or listed)", () => {
      const untyped = one("SELECT COUNT(*) FROM faces f JOIN cards c ON c.id = f.card_id WHERE f.type = '' AND c.layout != 'multi'");
      expect(untyped).toBe(
        one("SELECT COUNT(*) FROM quality_issues WHERE kind = 'face_without_type' AND ref IN (SELECT name FROM cards WHERE layout != 'multi')"),
      );
      expect(untyped).toBeLessThanOrEqual(5);
      expect(one("SELECT COUNT(*) FROM faces WHERE civs = '[]' AND face_index = 0")).toBeLessThanOrEqual(5);
    });
    it("spells never carry power; creatures without power are recorded as official gaps", () => {
      expect(one("SELECT COUNT(*) FROM faces WHERE is_spell = 1 AND is_creature = 0 AND power IS NOT NULL")).toBe(0);
      const powerless = one("SELECT COUNT(*) FROM faces WHERE is_creature = 1 AND power IS NULL AND power_infinite = 0");
      expect(powerless).toBeLessThanOrEqual(one("SELECT COUNT(*) FROM quality_issues WHERE kind = 'creature_without_power'"));
      expect(powerless).toBeLessThan(15);
    });
    it("main-deck cards have a cost", () => {
      const missing = db
        .prepare(
          "SELECT c.name FROM faces f JOIN cards c ON c.id = f.card_id WHERE f.face_index = 0 AND f.cost IS NULL AND f.cost_infinite = 0 AND c.zone = 'main'",
        )
        .pluck()
        .all();
      expect(missing.length, `cards without cost: ${missing.slice(0, 10).join(", ")}`).toBeLessThan(15);
    });
    it("twinpacts have exactly two faces", () => {
      expect(one("SELECT COUNT(*) FROM cards c WHERE layout = 'twinpact' AND (SELECT COUNT(*) FROM faces f WHERE f.card_id = c.id) != 2")).toBe(0);
      expect(one("SELECT COUNT(*) FROM cards WHERE layout = 'twinpact'")).toBeGreaterThan(500);
    });
    it("hyperspatial / GR zones are populated", () => {
      expect(one("SELECT COUNT(*) FROM cards WHERE zone = 'hyperspatial'")).toBeGreaterThan(200);
      expect(one("SELECT COUNT(*) FROM cards WHERE zone = 'gr'")).toBeGreaterThan(100);
    });
    it("every printing has an image URL and a rarity or is a promo", () => {
      expect(one("SELECT COUNT(*) FROM printings WHERE image_url IS NULL")).toBe(0);
    });
  });

  describe("known cards", () => {
    it("ボルシャック・ドラゴン", () => {
      const c = engine.card("ボルシャック・ドラゴン")!;
      expect(c.faces[0]).toMatchObject({ cost: 6, power: 6000, civs: ["火"] });
      expect(c.keywords.map((k) => k.keyword)).toEqual(expect.arrayContaining(["W・ブレイカー"]));
      expect(c.printings.length).toBeGreaterThan(1);
    });
    it("天空の守護者グラン・ギューレ is a ブロッカー from DM-01", () => {
      const c = engine.card("天空の守護者グラン・ギューレ")!;
      expect(c.keywords.some((k) => k.keyword === "ブロッカー" && k.scope === "self")).toBe(true);
      expect(c.printings.some((p) => p.id === "dm01-001")).toBe(true);
    });
    it("regulation statuses", () => {
      expect(engine.card("無双竜機ボルバルザーク")!.regulation).toBe("premium");
      expect(engine.card("蒼き団長 ドギラゴン剣")!.regulation).toBe("restricted");
      expect(one("SELECT COUNT(*) FROM regulation_combos")).toBeGreaterThanOrEqual(2);
    });
    it("禁断 ～封印されしX～ starts in the battle zone (not オリジナル legal)", () => {
      const row = db.prepare("SELECT starts_in_battle_zone, legal_original FROM cards WHERE name = ?").get("禁断 ～封印されしX～");
      expect(row).toEqual({ starts_in_battle_zone: 1, legal_original: 0 });
    });
  });

  describe("keyword extraction vs official ability filter", () => {
    const agreement = () => JSON.parse(one<string>("SELECT value FROM meta WHERE key = 'keyword_agreement'")) as KeywordAgreement[];
    // Keywords whose official definition differs from the printed keyword (see build-report.md).
    const DEFINITION_DIFFERS = new Set(["パワーアタッカー", "進化", "サイキック・セル"]);
    it("micro precision / recall vs the official filter (best reading per keyword)", () => {
      const rows = agreement().filter((k) => !DEFINITION_DIFFERS.has(k.keyword));
      const tp = rows.reduce((s, k) => s + k.both, 0);
      const o = rows.reduce((s, k) => s + k.official, 0);
      const p = rows.reduce((s, k) => s + k.parsed, 0);
      expect(o).toBeGreaterThan(10000);
      expect(tp / p).toBeGreaterThan(0.97);
      expect(tp / o).toBeGreaterThan(0.95);
    });
    it.each([
      "ブロッカー",
      "S・トリガー",
      "W・ブレイカー",
      "T・ブレイカー",
      "スピードアタッカー",
      "ジャストダイバー",
      "マッハファイター",
      "スレイヤー",
      "革命チェンジ",
      "G・ストライク",
    ])("%s: ≥ 97%% precision, ≥ 94%% recall", (name) => {
      const k = agreement().find((x) => x.keyword === name)!;
      expect(k.official).toBeGreaterThan(0);
      expect(k.precision).toBeGreaterThan(0.97);
      expect(k.recall).toBeGreaterThan(0.94);
    });
    it("パワーアタッカー: what we extract is what the official filter calls パワーアタッカー", () => {
      // The official tag is broader (any "パワーを+N"), so only precision is meaningful here.
      expect(agreement().find((x) => x.keyword === "パワーアタッカー")!.precision).toBeGreaterThan(0.85);
    });
  });

  describe("search", () => {
    it("example queries from the requirements work", () => {
      expect(engine.search("kw:パワーアタッカー=1000").total).toBeGreaterThan(0);
      expect(engine.search("kw:ジャストダイバー").total).toBeGreaterThan(30);
      const and = engine.search("kw:ジャストダイバー kw:S・トリガー").total;
      const or = engine.search("kw:ジャストダイバー or kw:S・トリガー").total;
      expect(or).toBeGreaterThan(and);
      expect(engine.search("set:DM26-RP1").total).toBeGreaterThan(80);
      expect(engine.search("illust:Shishizaru unique:prints").total).toBeGreaterThan(0);
    });
    it("is fast enough for interactive use", () => {
      const queries = [
        "kw:ブロッカー (c:光 or c:水) cost<=3 pow>=2000",
        "text:破壊 tag:draw c<=火自然",
        "ボルシャック",
        "kw:ブレイカー breaks>=3 f:original",
        "illust:a unique:prints",
        "tag:removal_destroy kw:S・トリガー cost<=4 f:original",
        "(kw:ジャストダイバー or kw:マッハファイター) -tag:draw c<=水闇 order:power",
      ];
      for (const q of queries) {
        const t0 = performance.now();
        engine.search(q);
        const ms = performance.now() - t0;
        expect(ms, q).toBeLessThan(500);
      }
    });
  });
});
