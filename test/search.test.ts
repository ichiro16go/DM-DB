import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { SearchEngine } from "../src/search/engine.js";
import { QueryError } from "../src/search/query.js";
import type { BuildReport } from "../src/db/build.js";
import { buildFixtureDb } from "./helpers/fixture-db.js";

/**
 * End-to-end over real data: 18 real card pages → build pipeline → SQLite → search engine.
 */
let db: Database;
let engine: SearchEngine;
let report: BuildReport;

beforeAll(() => {
  const built = buildFixtureDb();
  db = built.db;
  report = built.report;
  engine = new SearchEngine(db);
});
afterAll(() => db?.close());

const names = (q: string, opts = {}) =>
  engine
    .search(q, { pageSize: 500, ...opts })
    .items.map((c) => c.name)
    .sort();
const has = (q: string, name: string) => names(q).includes(name);

const BOLMETEUS = "ボルメテウス・ホワイト・ドラゴン / ボルメテウス・レジェンド・フレア";
const SAPPHIRE = "ボルメテウス・サファイア・ドラゴン";
const CLAP = "熱血の親衛隊クラップ";
const EARRING = "魔誕邪脚ブレイズ・イヤリング";

describe("build", () => {
  it("creates cards, faces and printings", () => {
    expect(report.parseErrors).toBe(0);
    expect(report.printings).toBe(18);
    expect(report.cards).toBe(18);
    expect(report.faces).toBe(22); // 2 twinpacts + psychic + dragheart add one face each
  });
  it("stores structured stats", () => {
    const row = db.prepare("SELECT cost, power, power_mod, breaks FROM faces WHERE name = ?").get(SAPPHIRE);
    expect(row).toEqual({ cost: 10, power: 11000, power_mod: "+", breaks: 3 });
    const zones = db.prepare("SELECT zone, COUNT(*) n FROM cards GROUP BY zone ORDER BY zone").all();
    expect(zones).toEqual([
      { zone: "gr", n: 1 },
      { zone: "hyperspatial", n: 2 },
      { zone: "main", n: 15 },
    ]);
  });
  it("compares extracted keywords with the official ability filter", () => {
    const pa = report.keywordAgreement.find((k) => k.keyword === "パワーアタッカー")!;
    expect(pa).toMatchObject({ official: 3, parsed: 3, both: 3 });
    const jd = report.keywordAgreement.find((k) => k.keyword === "ジャストダイバー")!;
    expect(jd).toMatchObject({ official: 2, parsed: 2, both: 2 });
  });
});

describe("search: keywords", () => {
  it("kw: finds keyword holders", () => {
    expect(names("kw:ジャストダイバー")).toEqual(["アルケミック・プラチナム", "クリスタル・ツヴァイランサーP’S"]);
    expect(names("kw:パワーアタッカー")).toEqual([CLAP, SAPPHIRE, EARRING].sort());
  });
  it("kw: with numeric parameter comparison", () => {
    expect(names("kw:パワーアタッカー>=3500")).toEqual([EARRING]);
    expect(names("kw:パワーアタッカー=3000")).toEqual([CLAP, SAPPHIRE].sort());
    expect(names("kw:パワーアタッカー+3000")).toEqual([CLAP, SAPPHIRE].sort());
    expect(names("kw:パワーアタッカー3000")).toEqual([CLAP, SAPPHIRE].sort());
  });
  it("AND / OR / NOT over keywords", () => {
    expect(names("kw:ジャストダイバー kw:S・トリガー")).toEqual([]);
    expect(names("kw:ジャストダイバー or kw:S・トリガー")).toHaveLength(3);
    expect(names("kw:パワーアタッカー -kw:T・ブレイカー")).toEqual([CLAP, EARRING].sort());
    expect(names("(kw:ジャストダイバー or kw:パワーアタッカー) c:水")).toEqual(["アルケミック・プラチナム", "クリスタル・ツヴァイランサーP’S"]);
  });
  it("grant: is separate from kw:", () => {
    expect(names("grant:スピードアタッカー")).toEqual(["切札混成 ドギラダンテ刈", "熱血剣 レジェンドホーン"]);
    expect(has("kw:スピードアタッカー", "切札混成 ドギラダンテ刈")).toBe(false);
    expect(has("kw:スピードアタッカー", SAPPHIRE)).toBe(true);
  });
  it("family search: kw:ブレイカー covers W/T/… breakers", () => {
    const all = names("kw:ブレイカー");
    expect(all).toEqual(expect.arrayContaining([BOLMETEUS, SAPPHIRE, "制服槍 ブータン"]));
    expect(names("kw=ブレイカー")).toEqual([]); // exact keyword only — there is no plain "ブレイカー"
  });
  it("breaks: counts shields", () => {
    expect(has("breaks>=3", SAPPHIRE)).toBe(true);
    expect(has("breaks>=3", "制服槍 ブータン")).toBe(false);
    expect(has("breaks=2", "制服槍 ブータン")).toBe(true);
  });
  it("okw: uses the official ground truth", () => {
    expect(names("okw:パワーアタッカー")).toHaveLength(3);
  });
  it("unknown keyword gives suggestions", () => {
    expect(() => engine.search("kw:ジャストダイバ")).toThrow(/候補/);
  });
});

describe("search: stats and attributes", () => {
  it("civilization semantics", () => {
    expect(names("c=火")).toEqual([BOLMETEUS, CLAP, SAPPHIRE, EARRING].sort());
    expect(names("c<=火")).toContain("切札連結 「修羅」「黄金」「覇」"); // colorless fits any deck
    expect(names("c:光 c:水")).toEqual(["ボルメテウス・ホワイト・ドラゴン・ネクサス", "切札混成 ドギラダンテ刈"]);
    expect(names("c:光水")).toEqual(names("c:光 c:水"));
    expect(names("c:無色")).toEqual(["切札連結 「修羅」「黄金」「覇」"]);
    expect(names("c:多色").length).toBeGreaterThan(3);
  });
  it("numeric filters are any-face (twinpact spell side counts)", () => {
    expect(names("cost=6")).toEqual([BOLMETEUS, "天空の守護者グラン・ギューレ", "西虎の炎 ボルメテウス・イエロー / ボルメテウス・スパーク"].sort());
    expect(names("cost<=2 pow>=2000")).toEqual(["制服槍 ブータン", "熱血の親衛隊クラップ", "西虎の炎 ボルメテウス・イエロー / ボルメテウス・スパーク"].sort());
    expect(names("cost:3-4")).toEqual(expect.arrayContaining(["アルケミック・プラチナム", "神羅の銀月 ザ・ラムーン"]));
  });
  it("name search ignores kana type and separators; = is exact (face names too)", () => {
    expect(names("ほわいとどらごん")).toEqual([BOLMETEUS, "ボルメテウス・ホワイト・ドラゴン・ネクサス"].sort());
    expect(names("name=ボルメテウス・レジェンド・フレア")).toEqual([BOLMETEUS]);
  });
  it("type / race / zone / layout / format", () => {
    expect(names("type:呪文")).toHaveLength(2);
    expect(names("is:twinpact")).toHaveLength(2);
    expect(names("zone:hyperspatial")).toEqual(["切札連結 ガイアーセイ・カイザー", "熱血剣 レジェンドホーン"]);
    expect(names("is:gr")).toEqual(["鉄壁の守護者ガリア・ゾールα GR"]);
    expect(names("f:original")).toHaveLength(15);
    expect(has("race:ドラゴン", SAPPHIRE)).toBe(true);
    expect(names("race=アーマード・ドラゴン")).toEqual([BOLMETEUS, "ボルメテウス・ホワイト・ドラゴン・ネクサス", SAPPHIRE].sort());
  });
  it("text, regex, tags", () => {
    expect(has("text:墓地に置く", BOLMETEUS)).toBe(true);
    expect(has("text:/パワー\\d+以下のクリーチャーをすべて破壊/", BOLMETEUS)).toBe(true);
    expect(has("tag:removal_destroy", BOLMETEUS)).toBe(true);
    expect(has("tag:除去:破壊", BOLMETEUS)).toBe(true);
  });
});

describe("search: printings", () => {
  it("set: accepts official and short codes, with prefix match", () => {
    expect(names("set:DM26-BD1")).toHaveLength(4);
    expect(names("set:dm26bd1")).toEqual(names("set:26bd1"));
    expect(names("set:dm26*").length).toBeGreaterThan(10);
    expect(() => engine.search("set:nope")).toThrow(QueryError);
  });
  it("first: only matches the set a card debuted in", () => {
    expect(names("first:DM26-BD1")).toContain(BOLMETEUS);
    expect(names("first:DM26-BD1").length).toBeLessThanOrEqual(names("set:DM26-BD1").length);
  });
  it("illustrator search", () => {
    expect(names("illust:shishizaru")).toEqual([BOLMETEUS, "ボルメテウス・ホワイト・ドラゴン・ネクサス"].sort());
  });
  it("unique:prints returns printings with their own image", () => {
    const r = engine.search("set:DM26-BD1 unique:prints order:name");
    expect(r.unique).toBe("prints");
    expect(r.items.every((i) => i.printing?.setCode === "26bd1")).toBe(true);
  });
  it("card() returns every printing", () => {
    const c = engine.card(BOLMETEUS)!;
    expect(c.faces).toHaveLength(2);
    expect(c.printings[0]!.image).toMatch(/^https:\/\/dm\.takaratomy\.co\.jp\/wp-content\/card\/cardimage\//);
    expect(engine.card("ボルメテウス・レジェンド・フレア")!.name).toBe(BOLMETEUS); // by face name
  });
});

describe("search: ordering, paging, errors", () => {
  it("order:cost asc and paging", () => {
    const r = engine.search("order:cost dir:asc", { pageSize: 5 });
    expect(r.total).toBe(18);
    expect(r.items[0]!.minCost).toBeLessThanOrEqual(r.items[4]!.minCost!);
    const p2 = engine.search("order:cost dir:asc", { pageSize: 5, page: 2 });
    expect(p2.items.map((i) => i.id)).not.toContain(r.items[0]!.id);
  });
  it("friendly errors", () => {
    expect(() => engine.search("foo:bar")).toThrow(/不明なフィールド/);
    expect(() => engine.search("cost<=abc")).toThrow(/数値/);
    expect(() => engine.search("c:紫")).toThrow(/文明/);
  });
});
