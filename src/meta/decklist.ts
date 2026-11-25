import type { Database } from "better-sqlite3";
import { looseKey, nfkc } from "../lib/normalize.js";
import { validateDeck, type DeckReport, type Format } from "../deck/validate.js";

/**
 * Transcribed deck lists (meta/decklists/*.txt). Plain text so they can be reviewed and fixed by hand:
 *
 *   # event: 49034                 supersolenoid post id of the CS result
 *   # placement: 1                 1-based index of the placement in that post
 *   # archetype: フィオナアカシック
 *   # player: 琥珀
 *   # format: original
 *   # image: https://blog-imgs-189.fc2.com/…jpg
 *   # status: complete             complete | partial | unreadable
 *   # transcribed: claude 2026-11-24
 *   # note: free text
 *   4 完全水中要塞 アカシック3
 *   …
 *   超次元                          (zone headings: メイン / 超次元 / GR)
 *   1 …
 *   ? 2                            cards that could not be read (partial lists)
 */
export type Zone = "main" | "hyperspatial" | "gr";

export interface DecklistLine {
  zone: Zone;
  name: string; // as transcribed ("?" = unreadable)
  count: number;
}

export interface DecklistFile {
  file: string;
  meta: Record<string, string>;
  status: "complete" | "partial" | "unreadable";
  lines: DecklistLine[];
}

export function parseDecklistFile(file: string, text: string): DecklistFile {
  const meta: Record<string, string> = {};
  const lines: DecklistLine[] = [];
  let zone: Zone = "main";
  for (const raw of text.split(/\r?\n/)) {
    const line = nfkc(raw).trim();
    if (!line) continue;
    const h = line.match(/^#\s*([^:：]+?)\s*[:：]\s*(.*)$/);
    if (h) {
      meta[h[1]!.toLowerCase()] = h[2]!.trim();
      continue;
    }
    if (line.startsWith("#")) continue;
    if (/^(メイン|main)$/i.test(line)) zone = "main";
    else if (/^(超次元|hyperspatial)$/i.test(line)) zone = "hyperspatial";
    else if (/^(超?GR|gr)$/i.test(line)) zone = "gr";
    else if (/^\?\s*\d+$/.test(line)) lines.push({ zone, name: "?", count: Number(line.slice(1)) }); // "? 3" = 3 unreadable cards
    else {
      const m = line.match(/^(\d+)\s*[x×]?\s+(.+)$/) ?? line.match(/^(.+?)\s*[x×*]\s*(\d+)$/);
      if (!m) throw new Error(`${file}: cannot parse line "${raw}"`);
      const [count, name] = /^\d+$/.test(m[1]!) ? [Number(m[1]), m[2]!.trim()] : [Number(m[2]), m[1]!.trim()];
      lines.push({ zone, name: name.replace(/^[《≪]|[》≫]$/g, ""), count });
    }
  }
  const status = (meta.status ?? "complete") as DecklistFile["status"];
  if (!["complete", "partial", "unreadable"].includes(status)) throw new Error(`${file}: bad status ${status}`);
  return { file, meta, status, lines };
}

export function formatDecklistFile(meta: Record<string, string | number | null | undefined>, lines: DecklistLine[]): string {
  const head = Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `# ${k}: ${v}`);
  const body: string[] = [];
  for (const zone of ["main", "hyperspatial", "gr"] as Zone[]) {
    const ls = lines.filter((l) => l.zone === zone);
    if (!ls.length) continue;
    if (zone !== "main") body.push(zone === "hyperspatial" ? "超次元" : "GR");
    for (const l of ls) body.push(`${l.count} ${l.name}`);
  }
  return [...head, ...body].join("\n") + "\n";
}

// ---------------------------------------------------------------- card name resolution

export type ResolveMethod = "exact" | "loose" | "partial" | "fuzzy";

export interface Resolution {
  cardId: number | null;
  name: string | null;
  method: ResolveMethod | null;
  candidates: string[];
}

interface IndexEntry {
  id: number;
  name: string;
  keys: string[];
}

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]!);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Resolves transcribed card names to DB cards (exact → loose → unique partial → fuzzy). */
export class CardResolver {
  private index: IndexEntry[];
  private exact: Map<string, IndexEntry>;
  private loose = new Map<string, IndexEntry[]>();

  constructor(private db: Database) {
    const rows = db.prepare("SELECT c.id, c.name, c.name_norm, group_concat(f.name, '|') AS faces FROM cards c JOIN faces f ON f.card_id = c.id GROUP BY c.id").all() as {
      id: number;
      name: string;
      name_norm: string;
      faces: string;
    }[];
    this.index = rows.map((r) => ({ id: r.id, name: r.name, keys: [...new Set(r.name_norm.split("|").filter(Boolean))] }));
    this.exact = new Map();
    for (const r of rows) {
      this.exact.set(nfkc(r.name), this.index.find((e) => e.id === r.id)!);
      for (const f of r.faces.split("|")) if (!this.exact.has(nfkc(f))) this.exact.set(nfkc(f), this.index.find((e) => e.id === r.id)!);
    }
    for (const e of this.index) for (const k of e.keys) this.loose.set(k, [...(this.loose.get(k) ?? []), e]);
  }

  resolve(raw: string): Resolution {
    const name = nfkc(raw).replace(/^[《≪]|[》≫]$/g, "").trim();
    const hit = (e: IndexEntry, method: ResolveMethod): Resolution => ({ cardId: e.id, name: e.name, method, candidates: [] });
    const ex = this.exact.get(name);
    if (ex) {
      // A truncated transcription can exactly match a shorter, different card
      // ("流星アーシュ" vs "流星アーシュ＜私が主役⁉＞"): report longer names with the same start.
      const k = looseKey(name);
      const longer = this.index.filter((e) => e.id !== ex.id && e.keys.some((x) => x.startsWith(k) && x.length > k.length));
      return { ...hit(ex, "exact"), candidates: longer.slice(0, 6).map((e) => e.name) };
    }
    const key = looseKey(name);
    const lo = this.loose.get(key);
    if (lo?.length === 1) return hit(lo[0]!, "loose");
    if (key.length >= 3) {
      const part = this.index.filter((e) => e.keys.some((k) => k.includes(key)));
      if (part.length === 1) return hit(part[0]!, "partial");
      if (part.length > 1 && part.length <= 8) return { cardId: null, name: null, method: null, candidates: part.map((p) => p.name) };
    }
    const max = Math.max(1, Math.floor(key.length / 6));
    const scored = this.index
      .map((e) => ({ e, d: Math.min(...e.keys.map((k) => levenshtein(key, k, max))) }))
      .filter((x) => x.d <= max)
      .sort((a, b) => a.d - b.d);
    if (scored.length && (scored.length === 1 || scored[0]!.d < scored[1]!.d)) return hit(scored[0]!.e, "fuzzy");
    return { cardId: null, name: null, method: null, candidates: scored.slice(0, 8).map((s) => s.e.name) };
  }
}

export interface ResolvedDecklist {
  file: DecklistFile;
  cards: (DecklistLine & Resolution & { rawName: string })[];
  unknown: number; // "?" cards
  problems: string[];
  report: DeckReport | null;
}

/** Resolve names and check the list (sizes, legality). Unreadable files are passed through. */
export function checkDecklist(db: Database, resolver: CardResolver, file: DecklistFile): ResolvedDecklist {
  const problems: string[] = [];
  const costOf = new Map(
    (db.prepare("SELECT c.name, MIN(f.cost) AS cost FROM cards c JOIN faces f ON f.card_id = c.id GROUP BY c.id").all() as { name: string; cost: number | null }[]).map((r) => [
      r.name,
      r.cost,
    ]),
  );
  const cards = file.lines.map((l) =>
    l.name === "?" ? { ...l, rawName: "?", cardId: null, name: "?", method: null, candidates: [] } : { ...l, rawName: l.name, ...resolve(l) },
  );
  function resolve(l: DecklistLine) {
    const r = resolver.resolve(l.name);
    const withCost = (n: string) => `${n}(コスト${costOf.get(n) ?? "?"})`;
    if (!r.cardId) problems.push(`「${l.name}」を特定できません${r.candidates.length ? `（候補: ${r.candidates.map(withCost).join(" / ")}）` : ""}`);
    else if (r.method === "exact" && r.candidates.length && !file.meta[`ok-${l.name}`.toLowerCase()])
      problems.push(`《${withCost(r.name!)}》と名前の始まりが同じ別カードがあります: ${r.candidates.map(withCost).join(" / ")}（正しければ "# ok-${l.name}: yes" を追記）`);
    else if (r.method === "fuzzy" || r.method === "partial") problems.push(`「${l.name}」→《${r.name}》（${r.method}）を確認してください`);
    return { ...r, name: r.name ?? l.name };
  }
  const unknown = file.lines.filter((l) => l.name === "?").reduce((s, l) => s + l.count, 0);
  let report: DeckReport | null = null;
  if (file.status !== "unreadable") {
    const format: Format = file.meta.format === "advance" ? "advance" : "original";
    const byZone = (z: Zone) => cards.filter((c) => c.zone === z && c.cardId).map((c) => ({ name: c.name!, count: c.count }));
    report = validateDeck(db, { format, main: byZone("main"), hyperspatial: byZone("hyperspatial"), gr: byZone("gr") });
    const mainTotal = cards.filter((c) => c.zone === "main").reduce((s, c) => s + c.count, 0);
    if (file.status === "complete") {
      if (unknown) problems.push(`status: complete なのに不明カードが ${unknown} 枚あります`);
      for (const p of report.problems) if (p.severity === "error") problems.push(p.message);
    } else if (mainTotal !== 40) problems.push(`メイン ${mainTotal} 枚（不明 ${unknown} 枚を含む）`);
  }
  return { file, cards, unknown, problems, report };
}
