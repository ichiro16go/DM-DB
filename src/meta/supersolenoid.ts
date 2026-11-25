/**
 * Parsers for 田園補完計画 (supersolenoid.jp):
 *   - weekly "入賞数ランキング" posts (meta share per archetype, オリジナル / アドバンス)
 *   - per-CS "結果" posts (placements + organiser-published deck images)
 *   - list pages (tag pages, daily archives) to discover posts
 *
 * Everything works on a line view of the HTML (images become "[[IMG url]]" lines), which is
 * robust against the blog template and keeps image order relative to the text.
 */
import { nfkc } from "../lib/normalize.js";

export type MetaFormat = "original" | "advance";

export interface RankingEntry {
  rank: number;
  name: string; // archetype as written, e.g. "ザゼゼーン/ウィリデ"
  note: string | null; // e.g. "ウィリデ型3、ザゼゼーン型2"
  count: number;
  share: number; // percent
}

export interface RankingPost {
  url: string;
  title: string;
  format: MetaFormat;
  flash: boolean; // 新弾発売速報版 (a single day, not a full week)
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
  sampleSize: number; // 母数 (top-4 placements counted)
  latestSet: string | null;
  publishedAt: string | null; // YYYY-MM-DD
  entries: RankingEntry[];
  singletons: string[]; // 母数1のデッキ
  singletonShare: number | null;
}

export interface ResultPlacement {
  rank: number; // 1, 2, 3, 4 … (ベスト4 → 3)
  rankLabel: string; // "優勝", "2位", "3位", "ベスト4" …
  archetype: string;
  player: string | null;
  images: string[];
}

export interface ResultPost {
  url: string;
  title: string;
  format: MetaFormat | null;
  eventName: string | null;
  date: string | null; // YYYY-MM-DD
  capacity: number | null; // 定員
  players: number | null; // 参加 N名 (if stated)
  region: string | null;
  store: string | null;
  placements: ResultPlacement[];
}

export interface PostLink {
  id: number;
  url: string;
  title: string;
}

/** HTML → trimmed text lines; <img> become "[[IMG url]]" lines. */
export function htmlToLines(html: string): string[] {
  const s = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, "")
    .replace(/<img[^>]*\ssrc="([^"]+)"[^>]*>/gi, "\n[[IMG $1]]\n")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|dd|dt|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—");
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t　]+/g, " ").trim())
    .filter(Boolean);
}

export function titleOf(html: string): string {
  return (html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").replace(/\s*田園補完計画.*$/, "").trim();
}

/** "2026年11月16日 | 23:00" → 2026-11-16 */
export function publishedDateOf(html: string): string | null {
  const m = html.match(/class="EntryDate">\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  return m ? ymd(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export function formatOf(title: string): MetaFormat | null {
  const t = nfkc(title);
  if (/アドバンス/.test(t)) return "advance";
  if (/オリジナル/.test(t)) return "original";
  return null;
}

/** Parse a weekly 入賞数ランキング post. Throws if it is not one. */
export function parseRankingPost(url: string, html: string): RankingPost {
  const title = titleOf(html);
  const format = formatOf(title);
  if (!format || !/入賞数ランキング/.test(title)) throw new Error(`not a ranking post: ${title}`);
  const lines = htmlToLines(html).map(nfkc);
  const start = lines.findIndex((l) => /^■\s*入賞数ランキング/.test(l));
  if (start < 0) throw new Error(`no ■入賞数ランキング section in ${url}`);
  const published = publishedDateOf(html);
  const pubYear = Number((published ?? "").slice(0, 4)) || new Date().getFullYear();

  let periodStart = "";
  let periodEnd = "";
  let sampleSize = 0;
  let latestSet: string | null = null;
  const entries: RankingEntry[] = [];
  const singletons: string[] = [];
  let singletonShare: number | null = null;
  let current: { rank: number; count: number; share: number } | null = null;
  let currentHasEntry = false;
  let inSingletons = false;
  const pushEntry = (body: string) => {
    // "創世竜(トリーヴァ40、白青黒緑1) ※大半が…" → name "創世竜", note "トリーヴァ40、白青黒緑1 ※大半が…"
    const cut = body.search(/[(※]/);
    const name = (cut >= 0 ? body.slice(0, cut) : body).trim();
    const note =
      cut >= 0
        ? body
            .slice(cut)
            .replace(/^\((.*?)\)/, "$1")
            .trim() || null
        : null;
    entries.push({ ...current!, name, note });
    currentHasEntry = true;
  };

  for (const line of lines.slice(start + 1)) {
    if (/^▲|^今週も|^■/.test(line)) break;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^最新セット[:：]\s*(.+)$/))) latestSet = m[1]!.trim();
    else if ((m = line.match(/^集計期間[:：]\s*(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})\s*[~～〜-]\s*(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})/))) {
      const y1 = m[1] ? Number(m[1]) : pubYear;
      const y2 = m[4] ? Number(m[4]) : y1 + (Number(m[5]) < Number(m[2]) ? 1 : 0);
      periodStart = ymd(y1, Number(m[2]), Number(m[3]));
      periodEnd = ymd(y2, Number(m[5]), Number(m[6]));
    } else if ((m = line.match(/^集計期間[:：]\s*(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})\s*$/))) {
      periodStart = periodEnd = ymd(m[1] ? Number(m[1]) : pubYear, Number(m[2]), Number(m[3]));
    } else if ((m = line.match(/^母数[:：]\s*(\d+)/))) sampleSize = Number(m[1]);
    else if ((m = line.match(/^入賞数\s*(\d+)\s*位\s*\(\s*(\d+)\s*件\s*[、,]\s*([\d.]+)\s*%\s*\)/))) {
      current = { rank: Number(m[1]), count: Number(m[2]), share: Number(m[3]) };
      currentHasEntry = false;
      inSingletons = false;
    } else if ((m = line.match(/^母数\s*1\s*のデッキ\s*(?:\(\s*([\d.]+)\s*%\s*\))?/))) {
      inSingletons = true;
      current = null;
      singletonShare = m[1] ? Number(m[1]) : null;
    } else if (line.startsWith("・")) {
      const body = line.slice(1).trim();
      if (inSingletons) singletons.push(body);
      else if (current) pushEntry(body);
    } else if (current && !currentHasEntry && !inSingletons && !/^\[\[IMG/.test(line)) {
      pushEntry(line); // the blog occasionally forgets the "・" bullet
    }
  }
  if (!periodStart || !sampleSize || entries.length === 0)
    throw new Error(`incomplete ranking post ${url}: period=${periodStart} n=${sampleSize} entries=${entries.length}`);
  return {
    url,
    title,
    format,
    flash: /速報/.test(title) || periodStart === periodEnd,
    periodStart,
    periodEnd,
    sampleSize,
    latestSet,
    publishedAt: published,
    entries,
    singletons,
    singletonShare,
  };
}

const RANK_LABEL = /^(優勝|準優勝|\d+位|ベスト\s*\d+|TOP\s*\d+)\s*[:：]\s*(.+)$/i;

function rankNumber(label: string): number {
  if (label === "優勝") return 1;
  if (label === "準優勝") return 2;
  const n = Number(label.match(/\d+/)?.[0] ?? 0);
  if (/ベスト|TOP/i.test(label)) return n <= 4 ? 3 : n <= 8 ? 5 : n;
  return n;
}

/** Split "フィオナアカシック＠琥珀さん" into archetype and player. */
function splitArchetypePlayer(s: string): { archetype: string; player: string | null } {
  const t = s.replace(/@?\s*さん\s*$/, "").trim(); // "…@ゆか@さん" / "…@琥珀さん"
  const i = t.lastIndexOf("@");
  if (i < 0) return { archetype: t, player: null };
  return { archetype: t.slice(0, i).trim(), player: t.slice(i + 1).trim() || null };
}

/** Parse a CS 結果 post (大会概要 + デッキレシピ with images per placement). */
export function parseResultPost(url: string, html: string): ResultPost {
  const title = titleOf(html);
  const lines = htmlToLines(html).map(nfkc);
  const get = (key: string) => {
    const l = lines.find((x) => x.startsWith(`${key}:`) || x.startsWith(`${key}：`));
    return l ? l.slice(l.indexOf(":") >= 0 ? l.indexOf(":") + 1 : l.indexOf("：") + 1).trim() || null : null;
  };
  const fmt = get("フォーマット");
  const dateRaw = get("開催日");
  let date: string | null = null;
  const dm = dateRaw?.match(/(\d{2,4})\/(\d{1,2})\/(\d{1,2})/);
  if (dm) date = ymd(dm[1]!.length === 2 ? 2000 + Number(dm[1]) : Number(dm[1]), Number(dm[2]), Number(dm[3]));
  const players = Number(lines.join("\n").match(/[（(](\d+)名参加[）)]/)?.[1] ?? NaN);

  // Placements: prefer the ■デッキレシピ section (labels followed by their images).
  const placements: ResultPlacement[] = [];
  const recipeStart = lines.findIndex((l) => /^■\s*デッキレシピ/.test(l));
  const resultStart = lines.findIndex((l) => /^■\s*大会結果/.test(l));
  const section = (from: number) => {
    const out: string[] = [];
    for (const l of lines.slice(from + 1)) {
      if (/^■|^関連$|^関連記事/.test(l)) break;
      out.push(l);
    }
    return out;
  };
  if (recipeStart >= 0) {
    let cur: ResultPlacement | null = null;
    for (const l of section(recipeStart)) {
      const m = l.match(RANK_LABEL);
      if (m) {
        cur = { rankLabel: m[1]!.replace(/\s+/g, ""), rank: rankNumber(m[1]!), ...splitArchetypePlayer(m[2]!), images: [] };
        placements.push(cur);
        continue;
      }
      const img = l.match(/^\[\[IMG (.+)\]\]$/);
      if (!img) {
        cur = null; // any other heading/text ends the current placement's images
        continue;
      }
      if (cur && /blog-imgs-\d+\.fc2\.com/.test(img[1]!) && !/blogthumbnail/.test(img[1]!)) {
        if (!cur.images.includes(img[1]!)) cur.images.push(img[1]!);
      }
    }
  }
  if (placements.length === 0 && resultStart >= 0) {
    for (const l of section(resultStart)) {
      const m = l.match(RANK_LABEL);
      if (m) placements.push({ rankLabel: m[1]!.replace(/\s+/g, ""), rank: rankNumber(m[1]!), ...splitArchetypePlayer(m[2]!), images: [] });
    }
  }
  return {
    url,
    title,
    format: fmt ? formatOf(fmt) : formatOf(title),
    eventName: get("大会名") ?? title.match(/「(.+?)」/)?.[1] ?? null,
    date,
    capacity: Number(get("定員")) || null,
    players: Number.isFinite(players) ? players : null,
    region: get("開催地"),
    store: get("店舗/団体"),
    placements,
  };
}

/** Entry links on a list page (tag page, daily archive). */
export function parsePostLinks(html: string): PostLink[] {
  const out = new Map<number, PostLink>();
  for (const m of html.matchAll(/<a href="(?:https:\/\/supersolenoid\.jp)?\/blog-entry-(\d+)\.html"[^>]*>([^<]{6,})<\/a>/g)) {
    const id = Number(m[1]);
    const title = nfkc(m[2]!).trim();
    if (!out.has(id) || out.get(id)!.title.length < title.length) out.set(id, { id, url: `https://supersolenoid.jp/blog-entry-${id}.html`, title });
  }
  return [...out.values()].sort((a, b) => b.id - a.id);
}

export const isRankingTitle = (t: string) => /入賞数ランキング/.test(t) && !!formatOf(t);
export const isResultTitle = (t: string) =>
  /結果/.test(t) && /(デュエマ\s*(オリジナル|アドバンス)CS|DMGP|デュエルマスターズ)/.test(t) && !/入賞数ランキング/.test(t);
