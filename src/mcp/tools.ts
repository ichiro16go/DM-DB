/**
 * MCP tool definitions (search_cards / get_card / validate_deck / list_keywords).
 * Wired to stdio in server.ts; tests connect through an in-memory transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FIELDS } from "../search/compile.js";
import type { Database } from "better-sqlite3";
import type { MetaService } from "../meta/service.js";
import type { DeckStore } from "../decks/store.js";
import { QueryError, SearchEngine, type CardSummary } from "../search/engine.js";
import { parseDeckText, validateDeck } from "../deck/validate.js";

const fieldHelp = Object.values(FIELDS)
  .map((f) => `- ${f.names.join("/")}: ${f.description} (例 ${f.example})`)
  .join("\n");

/** Compact text rendering of a card for LLM consumption. */
function renderCard(c: CardSummary): string {
  const reg = c.regulation === "premium" ? " [プレミアム殿堂]" : c.regulation === "restricted" ? " [殿堂]" : "";
  const faces = c.faces
    .map((f) => {
      const stats = [
        f.type,
        `文明:${f.civs.join("/") || "無色"}`,
        `コスト:${f.costText || "-"}`,
        f.powerText ? `パワー:${f.powerText}` : null,
        f.races.length ? `種族:${f.races.join("/")}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
      return `  ${c.faces.length > 1 ? `[${f.name}] ` : ""}${stats}\n${f.abilities.map((a) => `    ・${a}`).join("\n")}`;
    })
    .join("\n");
  const pr = c.printing
    ? `\n  収録: ${c.printing.setLabel ?? c.printing.setCode} ${c.printing.number ?? ""} ${c.printing.rarity ?? ""} illust.${c.printing.illustrator ?? "-"}`
    : "";
  return `《${c.name}》${reg} (id:${c.id}, zone:${c.zone}${c.legalOriginal ? "" : ", オリジナル不可"})\n${faces}${pr}`;
}

export interface McpExtras {
  meta?: MetaService;
  decks?: DeckStore;
}

export function createMcpServer(db: Database, extras: McpExtras = {}): McpServer {
  const engine = new SearchEngine(db);
  const server = new McpServer({ name: "dm-card-db", version: "0.1.0" });

  if (extras.meta) {
    const meta = extras.meta;
    server.registerTool(
      "get_meta",
      {
        title: "環境デッキ（週次の入賞数ランキング）",
        description: "公認CSのベスト4入賞数から集計した週次の環境デッキ分布（出典: 田園補完計画）と、登録済みの代表デッキリストを返す。week 省略時は最新週。",
        inputSchema: {
          format: z.enum(["original", "advance"]).default("original"),
          week: z.string().optional().describe("集計期間の開始日 YYYY-MM-DD"),
          lists: z.number().int().min(0).max(20).default(5).describe("上位何デッキ分の代表リストを含めるか"),
        },
      },
      async ({ format, week, lists }) => {
        await meta.ensureFresh();
        const r = await meta.ranking(format, week ?? null);
        if (!r) return { content: [{ type: "text", text: "週次データがありません" }], isError: true };
        const lines = [
          `${format === "original" ? "オリジナル" : "アドバンス"} ${r.snapshot.periodStart}〜${r.snapshot.periodEnd}（母数 ${r.snapshot.sampleSize}、最新セット: ${r.snapshot.latestSet ?? "-"}）出典: ${r.snapshot.url}`,
          ...r.rows.map((x) => {
            const d = x.prev ? ` 前週${x.prev.share}%` : " 前週なし";
            return `${x.rank}位 ${x.name} ${x.count}件 ${x.share}%${d}${x.note ? `（${x.note}）` : ""}${x.decks.length ? ` [リスト${x.decks.length}件]` : ""}`;
          }),
          r.singletons.length ? `母数1: ${r.singletons.join("、")}` : "",
        ];
        if (extras.decks && lists > 0) {
          for (const row of r.rows.slice(0, lists)) {
            const best = row.decks.find((d) => d.status === "complete") ?? row.decks[0];
            if (!best) continue;
            const { deck } = await extras.decks.get(best.id);
            lines.push(
              "",
              `■ ${row.name} 代表リスト: ${deck.name}（${deck.status}${deck.source ? `、${deck.source.eventName} ${deck.source.rank} ${deck.source.date}` : ""}）`,
              ...deck.cards.map((c) => `${c.zone === "main" ? "" : c.zone === "hyperspatial" ? "[超次元] " : "[GR] "}${c.count} ${c.name}`),
            );
          }
        }
        return { content: [{ type: "text", text: lines.filter((l) => l !== undefined).join("\n") }] };
      },
    );
  }

  server.registerTool(
    "search_cards",
    {
      title: "デュエル・マスターズのカード検索",
      description: `カードDBをクエリ言語で検索する。スペース区切りはAND、or でOR、-で否定、()でグループ。\nフィールド:\n${fieldHelp}\n並び: order:release|first|cost|power|name|printings, dir:asc|desc, unique:cards|prints`,
      inputSchema: {
        query: z.string().describe("例: kw:ブロッカー (c:光 or c:水) cost<=3 pow>=2000"),
        limit: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).default(1),
      },
    },
    async ({ query, limit, page }) => {
      try {
        const r = engine.search(query, { pageSize: limit, page });
        const body = r.items.map(renderCard).join("\n\n");
        return {
          content: [{ type: "text", text: `${r.total}件ヒット（${(page - 1) * limit + 1}〜${(page - 1) * limit + r.items.length}件目を表示）\n\n${body}` }],
        };
      } catch (e) {
        if (e instanceof QueryError) return { content: [{ type: "text", text: `クエリエラー: ${e.message}` }], isError: true };
        throw e;
      }
    },
  );

  server.registerTool(
    "get_card",
    {
      title: "カード詳細",
      description: "カード名（ツインパクトは「A / B」または片面名）か id で、全面の能力・全収録（絵柄違い）・殿堂状況を返す",
      inputSchema: { name: z.string().optional(), id: z.number().int().optional() },
    },
    async ({ name, id }) => {
      const c = id !== undefined ? engine.card(id) : name ? engine.card(name) : null;
      if (!c) return { content: [{ type: "text", text: "見つかりませんでした" }], isError: true };
      const prints = c.printings.map((p) => `  - ${p.setLabel ?? p.setCode} ${p.number ?? ""} ${p.rarity ?? ""} illust.${p.illustrator ?? "-"}`).join("\n");
      const kws = c.keywords
        .map((k) => `${k.keyword}${k.value != null ? `(${k.value})` : ""}${k.scope === "others" ? "[付与]" : k.conditional ? "[条件付き]" : ""}`)
        .join(", ");
      return {
        content: [
          {
            type: "text",
            text: `${renderCard(c)}\n  キーワード: ${kws || "-"}\n  効果タグ: ${c.tags.join(", ") || "-"}\n  デッキ枚数上限: ${c.deckLimit ?? "制限なし"}\n  収録(${c.printings.length}):\n${prints}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "validate_deck",
    {
      title: "デッキの構築ルール検証",
      description: "デッキリスト（1行に「枚数 カード名」、'超次元' / 'GR' 見出し行以降はそのゾーン）をオリジナル/アドバンスの構築ルールと殿堂で検証する",
      inputSchema: {
        format: z.enum(["original", "advance"]).default("original"),
        decklist: z.string().describe("例:\n4 カードA\n4 カードB\n...\n超次元\n1 サイキックX"),
      },
    },
    async ({ format, decklist }) => {
      const r = validateDeck(db, parseDeckText(decklist, format));
      const lines = [
        r.valid ? "✓ 構築ルールOK" : "✗ 構築ルール違反あり",
        `メイン ${r.counts.main} / 超次元 ${r.counts.hyperspatial} / 超GR ${r.counts.gr}`,
        ...r.problems.map((p) => `${p.severity === "error" ? "ERROR" : "WARN"}: ${p.message}`),
        `文明: ${Object.entries(r.civs)
          .map(([c, n]) => `${c}${n}`)
          .join(" ")}`,
        `コスト分布: ${Object.entries(r.costCurve)
          .map(([c, n]) => `${c}:${n}`)
          .join(" ")}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "list_keywords",
    {
      title: "キーワード能力・タグ一覧",
      description: "検索に使えるキーワード能力名（収録カード数つき）、系統名、効果タグを返す",
      inputSchema: { contains: z.string().optional().describe("部分一致で絞り込み") },
    },
    async ({ contains }) => {
      const kws = db.prepare("SELECT name, card_count FROM keywords WHERE card_count > 0 ORDER BY card_count DESC").all() as {
        name: string;
        card_count: number;
      }[];
      const fams = db.prepare("SELECT DISTINCT family FROM keyword_families").pluck().all() as string[];
      const tags = db.prepare("SELECT tag, label, description FROM tags").all() as { tag: string; label: string; description: string }[];
      const f = (s: string) => !contains || s.includes(contains);
      return {
        content: [
          {
            type: "text",
            text: [
              `キーワード: ${kws
                .filter((k) => f(k.name))
                .map((k) => `${k.name}(${k.card_count})`)
                .join(", ")}`,
              `系統（kw:系統名で一括検索）: ${fams.filter(f).join(", ")}`,
              `効果タグ（tag:）: ${tags.map((t) => `${t.tag}=${t.label}`).join(", ")}`,
            ].join("\n\n"),
          },
        ],
      };
    },
  );

  return server;
}
