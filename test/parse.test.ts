import { describe, expect, it } from "vitest";
import { looseKey, nfkc, setKey, stripReminder } from "../src/lib/normalize.js";
import { parseDetail, parseNumberField, parsePower } from "../src/parse/detail.js";
import { isSelfSubject, KeywordExtractor } from "../src/parse/keywords.js";
import { parseListPage, parseMaster } from "../src/parse/master.js";
import { parseRegulation } from "../src/parse/regulation.js";
import { tagAbilities } from "../src/parse/tags.js";
import { fixtureHtml, fixtureMaster, fixtureRegulation } from "./helpers/fixture-db.js";

const extractor = new KeywordExtractor(fixtureMaster().abilities.map((a) => a.label));
const kw = (...lines: string[]) => extractor.extract(lines).map((h) => ({ k: h.keyword, scope: h.scope, cond: h.conditional, v: h.value, t: h.valueText }));

describe("normalize", () => {
  it("NFKC folds full-width digits and punctuation", () => {
    expect(nfkc("カードを１枚引く。（ ）")).toBe("カードを1枚引く。( )");
  });
  it("looseKey ignores kana type, middle dots and spaces", () => {
    expect(looseKey("ボルシャック・ドラゴン")).toBe(looseKey("ぼるしゃっく どらごん"));
    expect(looseKey("ボルメテウス・ホワイト・ドラゴン")).toContain(looseKey("ホワイトドラゴン"));
  });
  it("setKey accepts every common spelling", () => {
    expect(setKey("DM26-RP1")).toBe("dm26rp1");
    expect(setKey("ｄｍ２６ｒｐ１")).toBe("dm26rp1");
  });
  it("stripReminder removes (nested) reminder text", () => {
    expect(stripReminder("W・ブレイカー（このクリーチャーはシールドを２つブレイクする）")).toBe("W・ブレイカー");
    expect(stripReminder("A(b(c)d)E")).toBe("AE");
  });
  it("parses power / cost fields", () => {
    expect(parsePower("9000+")).toEqual({ value: 9000, mod: "+", infinite: false });
    expect(parsePower("")).toEqual({ value: null, mod: null, infinite: false });
    expect(parsePower("∞")).toMatchObject({ infinite: true });
    expect(parseNumberField("７")).toEqual({ value: 7, infinite: false });
    expect(parseNumberField("-")).toEqual({ value: null, infinite: false });
  });
});

describe("parseDetail", () => {
  it("parses a twinpact into two faces with split names", () => {
    const p = parseDetail("dm26bd1-004", fixtureHtml("dm26bd1-004"));
    expect(p.layout).toBe("twinpact");
    expect(p.name).toBe("ボルメテウス・ホワイト・ドラゴン / ボルメテウス・レジェンド・フレア");
    expect(p.packCode).toBe("DM26BD1");
    expect(p.number).toBe("4/35");
    expect(p.faces.map((f) => [f.name, f.type, f.costText, f.powerText])).toEqual([
      ["ボルメテウス・ホワイト・ドラゴン", "クリーチャー", "7", "7000"],
      ["ボルメテウス・レジェンド・フレア", "呪文", "6", ""],
    ]);
    expect(p.faces[0]!.races).toEqual(["アーマード・ドラゴン"]);
    expect(p.faces[1]!.illustrator).toBe("Shishizaru"); // inherited from the upper half
    expect(p.sameNameProducts.map((s) => s.slug)).toContain("dmex04");
  });

  it("parses a psychic card as a multi-face card with per-face names", () => {
    const p = parseDetail("dm26ex4-016", fixtureHtml("dm26ex4-016"));
    expect(p.layout).toBe("multi");
    expect(p.name).toBe("切札連結 ガイアーセイ・カイザー");
    expect(p.faces.map((f) => f.name)).toEqual(["切札連結 ガイアーセイ・カイザー", "切札電融 リュウセール・カイザー"]);
    expect(p.faces[0]!.civs).toEqual(["水", "闇", "火", "自然"]);
    expect(p.faces[1]!.costText).toBe("15");
  });

  it("parses the oldest format (DM-01) and splits <br> separated abilities", () => {
    const p = parseDetail("dm01-001", fixtureHtml("dm01-001"));
    expect(p.layout).toBe("single");
    expect(p.faces[0]!.abilities).toHaveLength(2);
    expect(p.faces[0]!.abilities[1]).toBe("このクリーチャーは、相手プレイヤーを攻撃できない。");
    expect(p.faces[0]!.flavor).toContain("天空の城");
  });

  it("keeps abilities that share an <li> separate", () => {
    const p = parseDetail("dm26ex5-S003", fixtureHtml("dm26ex5-S003"));
    expect(p.faces[0]!.abilities).toContain("ジャストダイバー");
    expect(p.faces[0]!.abilities).toContain("{3T} T・ブレイカー");
  });

  it("throws on pages without a card", () => {
    expect(() => parseDetail("x", "<html><body>none</body></html>")).toThrow();
  });
});

describe("KeywordExtractor", () => {
  it("printed keyword lines are self / unconditional", () => {
    expect(kw("ブロッカー(相手クリーチャーが攻撃するとき…)")).toEqual([{ k: "ブロッカー", scope: "self", cond: false, v: null, t: null }]);
    expect(kw("W・ブレイカー（このクリーチャーはシールドを２つブレイクする）")[0]).toMatchObject({ k: "W・ブレイカー", scope: "self" });
  });
  it("extracts numeric parameters", () => {
    expect(kw("パワーアタッカー+3000（攻撃中、このクリーチャーのパワーを+3000する）")[0]).toMatchObject({ k: "パワーアタッカー", v: 3000 });
    expect(kw("ササゲール３（自分のディスペクター・クリーチャーの召喚コストを３少なくしてもよい）")[0]).toMatchObject({ k: "ササゲール", v: 3 });
  });
  it("extracts textual parameters after a colon", () => {
    expect(kw("革命チェンジ：多色のコスト５以上のドラゴン")[0]).toMatchObject({ k: "革命チェンジ", t: "多色のコスト5以上のドラゴン" });
  });
  it("prefers the longest keyword", () => {
    expect(kw("スーパー・S・トリガー")[0]!.k).toBe("スーパー・S・トリガー");
    expect(kw("S・トリガー")[0]!.k).toBe("S・トリガー");
  });
  it("strips leading icons", () => {
    expect(kw("{3T} T・ブレイカー")[0]!.k).toBe("T・ブレイカー");
    expect(kw("{S} ブロッカー（…）")[0]!.k).toBe("ブロッカー");
  });
  it("quoted 「…」を得る on this creature is self + conditional", () => {
    expect(kw("自分のマナゾーンに火のカードが５枚以上あれば、このクリーチャーは「スピードアタッカー」を得る。")).toEqual([
      { k: "スピードアタッカー", scope: "self", cond: true, v: null, t: null },
    ]);
    expect(kw("このクリーチャーは「パワーアタッカー+5000」と「W・ブレイカー」を得る。").map((h) => [h.k, h.scope, h.v])).toEqual([
      ["パワーアタッカー", "self", 5000],
      ["W・ブレイカー", "self", null],
    ]);
  });
  it("granting to others is scope=others", () => {
    expect(kw("自分の多色クリーチャーすべてに「スピードアタッカー」を与える。")[0]).toMatchObject({ scope: "others", cond: true });
    expect(kw("自分の他のドラゴンはすべて「ブロッカー」を得る。")[0]).toMatchObject({ scope: "others" });
    expect(
      kw("これを装備したクリーチャーが水なら「ブロッカー」を、火なら「スピードアタッカー」を、自然なら「マッハファイター」を与える。").map((h) => h.scope),
    ).toEqual(["others", "others", "others"]);
  });
  it("self-grants and multi-keyword lines with icons", () => {
    expect(kw("自分のターン中、このクリーチャーのパワーを+5000し、「W・ブレイカー」を与える。")[0]).toMatchObject({
      k: "W・ブレイカー",
      scope: "self",
      cond: true,
    });
    expect(kw("このクリーチャーが出た時、自分のクリーチャーすべてに「スレイヤー」を与える。")[0]).toMatchObject({ scope: "others" });
    expect(kw("ブロッカー　 {2W} W・ブレイカー").map((h) => h.k)).toEqual(["ブロッカー", "W・ブレイカー"]);
    expect(kw("oS ブロッカー（…）")[0]!.k).toBe("ブロッカー");
    expect(kw("GR召喚する。")[0]!.k).toBe("GR召喚");
  });
  it("old civilization slayers", () => {
    expect(kw("自然・光スレイヤー(このクリーチャーとバトルした…)")[0]).toMatchObject({ k: "スレイヤー", t: "自然・光" });
  });
  it("references are scope=ref (not abilities of the card)", () => {
    expect(kw("相手の「ブロッカー」を持つクリーチャーを１体破壊する。")[0]).toMatchObject({ k: "ブロッカー", scope: "ref" });
    expect(kw("このクリーチャーが「革命チェンジ」によって出た時、カードを１枚引く。")[0]).toMatchObject({ scope: "ref" });
  });
  it("keyword actions used as verbs", () => {
    expect(kw("このクリーチャーが出た時、GR召喚を2回する。")[0]).toMatchObject({ k: "GR召喚", scope: "self", cond: false });
    expect(kw("このクリーチャーが攻撃する時、ジョーカーズ・メクレイド5する。")[0]).toMatchObject({ k: "ジョーカーズ・メクレイド", v: 5 });
    expect(kw("このクリーチャーが攻撃する時、相手とガチンコ・ジャッジする。")[0]).toMatchObject({ k: "ガチンコ・ジャッジ" });
    expect(kw("相手とパワー・ガチンコ・ジャッジする。").map((h) => h.k)).toEqual(["パワー・ガチンコ・ジャッジ"]);
  });
  it("tap-trigger icon and old パワーアタッカー wording", () => {
    expect(kw("t自分の山札を見る。")[0]!.k).toBe("タップトリガー");
    expect(kw("{t} 自分の山札を見る。")[0]!.k).toBe("タップトリガー");
    expect(kw("攻撃中、このクリーチャーのパワーを+3000する。")[0]).toMatchObject({ k: "パワーアタッカー", v: 3000, cond: false });
  });
  it("does not treat ordinary sentences as keywords", () => {
    expect(kw("ブロッカーを持つクリーチャーを1体選ぶ。")).toEqual([]);
    expect(kw("このクリーチャーは、相手プレイヤーを攻撃できない。")).toEqual([]);
  });
  it("isSelfSubject handles commas and chained quotes", () => {
    expect(isSelfSubject("このターン、このクリーチャーは")).toBe(true);
    expect(isSelfSubject("このクリーチャーがバトルゾーンにある間、自分のクリーチャーはすべて")).toBe(false);
    expect(isSelfSubject("5枚以上あれば、このクリーチャーはパワーを+3000され、")).toBe(true);
  });
});

describe("tags", () => {
  it("detects common effect templates", () => {
    expect(tagAbilities(["相手のパワー3000以下のクリーチャーをすべて破壊する。"])).toContain("removal_destroy");
    expect(tagAbilities(["カードを１枚引く。"])).toContain("draw");
    expect(tagAbilities(["このクリーチャーが出た時、自分の山札の上から1枚目をマナゾーンに置く。"])).toContain("mana_boost");
    expect(tagAbilities(["相手の手札を見ないで2枚選び、捨てさせる。"])).toContain("hand_disruption");
    expect(tagAbilities(["このクリーチャーはブロックされない。"])).toContain("unblockable");
  });
  it("does not tag self-destruction as removal", () => {
    expect(tagAbilities(["自分のクリーチャーを２体破壊する。"])).not.toContain("removal_destroy");
  });
  it("W・ブレイカー alone is not extra lethal", () => {
    expect(tagAbilities(["W・ブレイカー"])).not.toContain("lethal_extra");
    expect(tagAbilities(["T・ブレイカー"])).toContain("lethal_extra");
  });
});

describe("master / list / regulation pages", () => {
  it("master has the official ability list", () => {
    const m = fixtureMaster();
    expect(m.products.length).toBeGreaterThan(300);
    expect(m.abilities.map((a) => a.label)).toEqual(expect.arrayContaining(["ブロッカー", "ジャストダイバー", "パワーアタッカー", "S・トリガー"]));
  });
  it("parseMaster reads select boxes", () => {
    const html = `<form id="search_cond"><select name="products"><option value="">-</option><option value="26rp1">DM26-RP1 逆札篇</option></select>
      <select name="ability"><option value="1">パワーアタッカー</option></select></form>`;
    expect(parseMaster(html)).toMatchObject({
      products: [{ value: "26rp1", label: "DM26-RP1 逆札篇" }],
      abilities: [{ value: "1", label: "パワーアタッカー" }],
    });
  });
  it("parseListPage reads ids and the last page", () => {
    const html = `<div id="cardlist"><a data-href='/card/detail/?id=dm26rp1-001'><img></a><a data-href='/card/detail/?id=dm26rp1-002'><img></a>
      <a class="page" data-page="2">2</a><a data-page="4">4</a></div>`;
    expect(parseListPage(html)).toEqual({ ids: ["dm26rp1-001", "dm26rp1-002"], lastPage: 4 });
  });
  it("parseRegulation finds each section and resolves links to printing ids", () => {
    const r = parseRegulation(fixtureRegulation());
    expect(r.premium.length).toBeGreaterThan(20);
    expect(r.restricted.length).toBeGreaterThan(50);
    expect(r.premium.map((x) => x.name)).toContain("無双竜機ボルバルザーク");
    expect(r.premiumCombos.length).toBeGreaterThanOrEqual(1);
    expect(r.premiumCombos[0]!.map((x) => x.name)).toEqual(["禁断英雄 モモキングダムX", "未来王龍 モモキングJO"]);
    // commented-out 殿堂解除 section must not leak in
    expect([...r.premium, ...r.restricted].map((x) => x.name)).not.toContain("超次元ガロウズ・ホール");
    expect(r.premium.every((x) => x.printingId)).toBe(true);
  });
});
