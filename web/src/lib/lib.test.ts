import { describe, expect, it } from "vitest";
import { addCard, deckToText, diffCards, normalize } from "./deck";
import { emptyFilters, filtersToQuery } from "./query";

describe("filtersToQuery", () => {
  const q = (patch: Partial<ReturnType<typeof emptyFilters>>) => filtersToQuery({ ...emptyFilters(), ...patch });
  it("is empty without filters", () => expect(q({})).toBe(""));
  it("builds civilization, range and keyword terms", () => {
    expect(q({ civs: ["光", "水"], civMode: "any" })).toBe("(c:光 or c:水)");
    expect(q({ civs: ["水", "闇", "無色"], civMode: "<=" })).toBe("c<=水闇");
    expect(q({ costMin: "3", costMax: "3", powMin: "2000" })).toBe("cost=3 pow>=2000");
    expect(q({ keywords: ["ジャストダイバー", "パワーアタッカー>=2000"], kwMode: "or" })).toBe("(kw:ジャストダイバー or kw:パワーアタッカー>=2000)");
    expect(q({ keywords: ["S・トリガー"], kwAlways: true, tags: ["draw", "removal_destroy"] })).toBe("kwa:S・トリガー tag:draw tag:removal_destroy");
  });
  it("quotes values with spaces", () => {
    expect(q({ name: "ザ ラムーン", set: "DM26-RP1", setFirst: true, format: "advance" })).toBe('"ザ ラムーン" first:DM26-RP1 f:advance');
  });
});

describe("deck helpers", () => {
  const A = { zone: "main" as const, name: "A", count: 4 };
  it("adds and removes copies", () => {
    expect(addCard([], "main", "A")).toEqual([{ zone: "main", name: "A", count: 1 }]);
    expect(addCard([A], "main", "A", 2)).toEqual([{ ...A, count: 6 }]);
    expect(addCard([A], "main", "A", -4)).toEqual([]);
    expect(addCard([A], "gr", "A")).toHaveLength(2);
  });
  it("normalizes, diffs and exports", () => {
    expect(normalize([A, { ...A, count: 1 }])).toEqual([{ ...A, count: 5 }]);
    expect(
      diffCards(
        [A],
        [
          { ...A, count: 3 },
          { zone: "main", name: "B", count: 1 },
        ],
      ),
    ).toEqual([
      { zone: "main", name: "A", before: 4, after: 3 },
      { zone: "main", name: "B", before: 0, after: 1 },
    ]);
    expect(deckToText([A, { zone: "hyperspatial", name: "P", count: 1 }])).toBe("4 A\n\n超次元\n1 P");
  });
});
