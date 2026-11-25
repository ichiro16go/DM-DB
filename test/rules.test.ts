import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";
import { civFill, FORMAT_ZONES, homeZone, zonesOf } from "../src/deck/rules.js";
import { parseDeckText, validateDeck } from "../src/deck/validate.js";
import { buildFixtureDb } from "./helpers/fixture-db.js";

describe("rules", () => {
  it("lists the zones of each format", () => {
    expect(zonesOf("original")).toEqual(["main"]);
    expect(zonesOf("advance")).toEqual(["main", "hyperspatial", "gr", "special"]);
  });
  it("tells where a card belongs", () => {
    expect(homeZone("main", false)).toBe("main");
    expect(homeZone("main", true)).toBe("special");
    expect(homeZone("gr", false)).toBe("gr");
  });
  it("colors civilizations (multi = gradient)", () => {
    expect(civFill(["火"])).toBe("#D8443A");
    expect(civFill([])).toBe("#9AA0AA");
    expect(civFill(["火", "自然"])).toBe("linear-gradient(135deg, #D8443A, #3C9A4B)");
  });
});

describe("特殊枠 and zone rules in the validator", () => {
  let db: Database;
  beforeAll(() => (db = buildFixtureDb().db));
  afterAll(() => db?.close());
  const msgs = (r: ReturnType<typeof validateDeck>) => r.problems.map((p) => p.message).join("\n");

  it("parses a 特殊枠 section", () => {
    const d = parseDeckText("4 A\n特殊枠\n1 禁断 ～封印されしX～", "advance");
    expect(d.main).toEqual([{ name: "A", count: 4 }]);
    expect(d.special).toEqual([{ name: expect.stringMatching(/^禁断 .封印されしX.$/), count: 1 }]); // names are NFKC-normalized
  });
  it("rejects normal cards in 特殊枠 and the zone in オリジナル", () => {
    const adv = validateDeck(db, { format: "advance", main: [], special: [{ name: "熱血の親衛隊クラップ", count: 1 }] });
    expect(adv.counts.special).toBe(1);
    expect(msgs(adv)).toMatch(/《熱血の親衛隊クラップ》は特殊枠に入れられません/);
    const orig = validateDeck(db, { format: "original", main: [], special: [{ name: "熱血の親衛隊クラップ", count: 1 }] });
    expect(msgs(orig)).toMatch(/オリジナルでは特殊枠を使用できません/);
  });
  it("applies zone sizes and per-zone copy limits from the rules", () => {
    const gr = validateDeck(db, { format: "advance", main: [], gr: [{ name: "鉄壁の守護者ガリア・ゾールα GR", count: 3 }] });
    expect(msgs(gr)).toMatch(/超GRゾーンは0枚か12枚ちょうどです（現在 3 枚）/);
    expect(msgs(gr)).toMatch(new RegExp(`超GRゾーンの同名カードは${FORMAT_ZONES.advance.gr!.perName}枚までです`));
    const hs = validateDeck(db, { format: "advance", main: [], hyperspatial: [{ name: "熱血剣 レジェンドホーン", count: 9 }] });
    expect(msgs(hs)).toMatch(/超次元ゾーンは8枚までです（現在 9 枚）/);
  });
});
