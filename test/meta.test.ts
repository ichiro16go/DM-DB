import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchArchetype } from "../src/meta/archetypes.js";
import { parseDecklistFile } from "../src/meta/decklist.js";
import { MetaRepo } from "../src/meta/repo.js";
import { MetaService } from "../src/meta/service.js";
import { isRankingTitle, isResultTitle, parsePostLinks, parseRankingPost, parseResultPost } from "../src/meta/supersolenoid.js";
import { DeckStore } from "../src/decks/store.js";
import { openStore } from "../src/storage/object-store.js";

// Synthetic posts in the blog's structure (not copies of real posts).
const page = (title: string, body: string, date = "2026年11月24日") =>
  `<html><head><title>${title} 田園補完計画</title></head><body><div class="EntryDate">${date} | 23:00</div><div class="EntryBody">${body}</div></body></html>`;

const RANKING = page(
  "【デュエマ オリジナルCS】「入賞数ランキング(11/16～11/22)」 テスト",
  `<p>前置き</p>
<h3>■入賞数ランキング</h3>
最新セット：テスト弾<br>集計期間：11/16～11/22<br>母数：100<br>
<b>入賞数 1位 (20件、20.0%)</b><br>・赤零ジョーカーズ<br>
<b>入賞数 2位 (15件、15.0%)</b><br>・創世竜(トリーヴァ10、白青黒緑5) ※補足<br>
<b>入賞数 3位 (10件、10.0%)</b><br>アナカラー系生徒会組<br>
<b>入賞数 4位 (5件、5.0%)</b><br>・ザゼゼーン/ウィリデ<br>
母数1のデッキ (2.0%)<br>・単発デッキA<br>・単発デッキB<br>
<h3>■関連</h3>・無関係`,
);

const RESULT = page(
  "【デュエマ オリジナルCS】「第1回テストCS」 結果",
  `大会名：第1回テストCS<br>開催日：26/11/22(日)<br>フォーマット：オリジナル<br>開催地：東京<br>店舗/団体：テスト店<br>定員：32<br>（30名参加）<br>
<h3>■大会結果</h3>優勝：赤零ジョーカーズ@ゆかさん<br>準優勝：創世竜@たろう@さん<br>
<h3>■デッキレシピ</h3>
優勝：赤零ジョーカーズ@ゆかさん<br><img src="https://blog-imgs-1.fc2.com/s/u/p/x/a.jpg"><img src="https://blog-imgs-1.fc2.com/s/u/p/x/a.jpg">
準優勝：創世竜@たろう@さん<br><img src="https://blog-imgs-1.fc2.com/s/u/p/x/b.jpg">
ベスト4：生徒会組@じろうさん<br><img src="https://example.com/ad.png">
<h3>■関連記事</h3>`,
);

describe("supersolenoid parsers", () => {
  it("parses a weekly ranking post", () => {
    const r = parseRankingPost("https://supersolenoid.jp/blog-entry-1.html", RANKING);
    expect(r).toMatchObject({ format: "original", flash: false, periodStart: "2026-11-16", periodEnd: "2026-11-22", sampleSize: 100, latestSet: "テスト弾" });
    expect(r.entries.map((e) => [e.rank, e.name, e.count, e.share])).toEqual([
      [1, "赤零ジョーカーズ", 20, 20],
      [2, "創世竜", 15, 15],
      [3, "アナカラー系生徒会組", 10, 10], // bullet missing in the post
      [4, "ザゼゼーン/ウィリデ", 5, 5],
    ]);
    expect(r.entries[1]!.note).toBe("トリーヴァ10、白青黒緑5 ※補足");
    expect(r.singletons).toEqual(["単発デッキA", "単発デッキB"]);
    expect(r.singletonShare).toBe(2);
  });

  it("rejects posts that are not rankings", () => {
    expect(() => parseRankingPost("u", page("ただの記事", "本文"))).toThrow(/not a ranking/);
  });

  it("parses a CS result post with players and deck images", () => {
    const r = parseResultPost("https://supersolenoid.jp/blog-entry-2.html", RESULT);
    expect(r).toMatchObject({
      format: "original",
      eventName: "第1回テストCS",
      date: "2026-11-22",
      capacity: 32,
      players: 30,
      region: "東京",
      store: "テスト店",
    });
    expect(r.placements).toEqual([
      { rank: 1, rankLabel: "優勝", archetype: "赤零ジョーカーズ", player: "ゆか", images: ["https://blog-imgs-1.fc2.com/s/u/p/x/a.jpg"] },
      { rank: 2, rankLabel: "準優勝", archetype: "創世竜", player: "たろう", images: ["https://blog-imgs-1.fc2.com/s/u/p/x/b.jpg"] },
      { rank: 3, rankLabel: "ベスト4", archetype: "生徒会組", player: "じろう", images: [] }, // non-blog image ignored
    ]);
  });

  it("finds post links and classifies titles", () => {
    const html = `<a href="/blog-entry-10.html">【デュエマ オリジナルCS】「入賞数ランキング(1/1～1/7)」</a>
      <a href="https://supersolenoid.jp/blog-entry-11.html">【デュエマ アドバンスCS】「テストCS」 結果</a><a href="/blog-entry-12.html">短い</a>`;
    const links = parsePostLinks(html);
    expect(links.map((l) => l.id)).toEqual([11, 10]);
    expect(isRankingTitle(links[1]!.title)).toBe(true);
    expect(isResultTitle(links[0]!.title)).toBe(true);
    expect(isResultTitle(links[1]!.title)).toBe(false);
  });
});

describe("archetype matching", () => {
  const entries = [
    { name: "赤零ジョーカーズ" },
    { name: "アナカラー系生徒会組" },
    { name: "創世竜" },
    { name: "ザゼゼーン/ウィリデ" },
    { name: "アトム革命チェンジ" },
  ];
  const m = (s: string) => matchArchetype(s, entries)?.target.name ?? null;
  it("matches exact names and spelling variants", () => {
    expect(m("赤零ジョーカーズ")).toBe("赤零ジョーカーズ");
    expect(m("アナカラー生徒会組")).toBe("アナカラー系生徒会組");
  });
  it("matches by contained name, core name and the reverse", () => {
    expect(m("新型創世竜")).toBe("創世竜");
    expect(m("生徒会組")).toBe("アナカラー系生徒会組");
    expect(m("ウィリデ")).toBe("ザゼゼーン/ウィリデ");
    expect(m("デアリアトム")).toBe("アトム革命チェンジ");
  });
  it("returns null for unrelated decks", () => {
    expect(m("まったく別のデッキ")).toBeNull();
  });
});

describe("deck list files", () => {
  it("parses header keys, zones and unreadable lines", () => {
    const f = parseDecklistFile(
      "49036-1.txt",
      `# event: 49036\n# placement: 1\n# archetype: 赤零ジョーカーズ\n# status: partial\n4 ジョジョジョ・ジョーカーズ\n? 2\n\n超次元\n1 テスト超次元`,
    );
    expect(f.meta).toMatchObject({ event: "49036", placement: "1", archetype: "赤零ジョーカーズ" });
    expect(f.status).toBe("partial");
    expect(f.lines).toEqual([
      expect.objectContaining({ zone: "main", name: "ジョジョジョ・ジョーカーズ", count: 4 }),
      expect.objectContaining({ zone: "main", name: "?", count: 2 }),
      expect.objectContaining({ zone: "hyperspatial", name: "テスト超次元", count: 1 }),
    ]);
  });
});

describe("MetaService", () => {
  it("ranks a week with deltas, placements and associated decks, and reloads on new data", async () => {
    const store = openStore(mkdtempSync(join(tmpdir(), "dm-meta-")));
    const repo = new MetaRepo(store);
    const decks = new DeckStore(store, "decks/", 0);
    const week = parseRankingPost("https://supersolenoid.jp/blog-entry-1.html", RANKING);
    const prev = { ...week, periodStart: "2026-11-09", periodEnd: "2026-11-15", entries: [{ rank: 1, name: "生徒会組", note: null, count: 9, share: 30 }] };
    await repo.saveSnapshot(week);
    await repo.saveSnapshot(prev);
    await repo.saveEvent({ id: 2, ...parseResultPost("https://supersolenoid.jp/blog-entry-2.html", RESULT) });
    await repo.writeIndex([week, prev], 1);
    await decks.create(
      {
        kind: "meta",
        name: "赤零",
        format: "original",
        archetype: "赤零ジョーカーズ",
        cards: [],
        source: {
          eventId: 2,
          placementIdx: 1,
          url: "https://x",
          image: null,
          eventName: "t",
          date: "2026-11-22",
          rank: "優勝",
          player: null,
          archetype: "赤零ジョーカーズ",
        },
      },
      null,
      "m-2-1",
    );

    const svc = new MetaService(repo, decks, 0);
    await svc.init();
    const r = (await svc.ranking("original"))!;
    expect(r.snapshot.periodStart).toBe("2026-11-16");
    expect(r.weeks).toEqual(["2026-11-16", "2026-11-09"]);
    const row = (n: string) => r.rows.find((x) => x.name === n)!;
    expect(row("赤零ジョーカーズ")).toMatchObject({ prev: null, placements: 1, withImages: 1 });
    expect(row("赤零ジョーカーズ").decks.map((d) => d.id)).toEqual(["m-2-1"]);
    expect(row("アナカラー系生徒会組").prev).toEqual({ rank: 1, share: 30, count: 9 }); // renamed week to week
    expect(row("アナカラー系生徒会組").placements).toBe(1); // "生徒会組" ベスト4

    const e = (await svc.entry("original", "創世竜"))!;
    expect(e.placements).toEqual([expect.objectContaining({ eventId: 2, idx: 2, rankLabel: "準優勝", player: "たろう", deckId: null })]);
    expect((await svc.entry("original", "赤零ジョーカーズ"))!.placements[0]!.deckId).toBe("m-2-1");
    expect(await svc.ranking("advance")).toBeNull();

    // the update job publishes a new week → picked up on the next request
    await repo.saveSnapshot({ ...week, periodStart: "2026-11-23", periodEnd: "2026-11-29" });
    await new Promise((res) => setTimeout(res, 5));
    await repo.writeIndex([week, prev], 1);
    await svc.ensureFresh();
    await new Promise((res) => setTimeout(res, 50));
    expect((await svc.ranking("original"))!.snapshot.periodStart).toBe("2026-11-23");
  });
});
