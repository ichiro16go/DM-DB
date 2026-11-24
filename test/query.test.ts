import { describe, expect, it } from "vitest";
import { formatQuery, parseQuery, QueryError } from "../src/search/query.js";

const fmt = (q: string) => formatQuery(parseQuery(q));

describe("query parser", () => {
  it("implicit AND, explicit OR, negation and grouping", () => {
    expect(fmt("kw:ブロッカー (civ:光 or civ:水) cost<=3 pow>=2000")).toBe("kw:ブロッカー (civ:光 or civ:水) cost<=3 pow>=2000");
    expect(fmt("a | b")).toBe("a or b");
    expect(fmt("-kw:スレイヤー")).toBe("-kw:スレイヤー");
    expect(fmt("not (a or b)")).toBe("-(a or b)");
    expect(fmt("a and b")).toBe("a b");
  });

  it("keeps comparison inside keyword values", () => {
    const n = parseQuery("kw:パワーアタッカー>=2000");
    expect(n).toMatchObject({ type: "term", field: "kw", op: ":", value: "パワーアタッカー>=2000" });
  });

  it("normalizes full-width input (NFKC)", () => {
    expect(parseQuery("ｃｏｓｔ＜＝３")).toMatchObject({ field: "cost", op: "<=", value: "3" });
    expect(parseQuery("文明：光")).toMatchObject({ field: "文明", op: ":", value: "光" });
  });

  it("supports quoted values and regex", () => {
    expect(parseQuery('text:"カードを1枚引く"')).toMatchObject({ value: "カードを1枚引く", quoted: true });
    expect(parseQuery("text:/破壊.*引く/")).toMatchObject({ value: "破壊.*引く", regex: true });
  });

  it("bare words are name terms", () => {
    expect(parseQuery("ボルシャック")).toMatchObject({ type: "term", field: null, value: "ボルシャック" });
  });

  it("reports syntax errors", () => {
    expect(() => parseQuery("(a or b")).toThrow(QueryError);
    expect(() => parseQuery("a or")).toThrow(QueryError);
    expect(() => parseQuery('text:"abc')).toThrow(QueryError);
    expect(() => parseQuery("a)")).toThrow(QueryError);
  });

  it("empty query matches everything", () => {
    expect(parseQuery("  ")).toEqual({ type: "and", children: [] });
  });
});
