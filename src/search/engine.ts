import Database, { type Database as DB } from "better-sqlite3";
import { existsSync } from "node:fs";
import { DEFAULT_DB_PATH } from "../lib/raw.js";
import { nfkc } from "../lib/normalize.js";
import { canonicalField, Compiler, type Mode } from "./compile.js";
import { formatQuery, parseQuery, QueryError, type Node } from "./query.js";

export function openDb(path = DEFAULT_DB_PATH): DB {
  if (path !== ":memory:" && !existsSync(path)) throw new Error(`DB not found: ${path} — run \`npm run build:db\``);
  const db = new Database(path, { readonly: path !== ":memory:", fileMustExist: path !== ":memory:" });
  registerFunctions(db);
  return db;
}

export function registerFunctions(db: DB): void {
  const cache = new Map<string, RegExp>();
  db.function("regexp", { deterministic: true }, (pattern: unknown, value: unknown) => {
    if (typeof pattern !== "string" || typeof value !== "string") return 0;
    let re = cache.get(pattern);
    if (!re) {
      re = new RegExp(pattern.normalize("NFKC"), "u");
      cache.set(pattern, re);
    }
    return re.test(value.normalize("NFKC")) ? 1 : 0;
  });
}

export type Order = "release" | "first" | "name" | "cost" | "power" | "printings" | "set";

export interface SearchOptions {
  page?: number;
  pageSize?: number;
  unique?: Mode;
  order?: Order;
  dir?: "asc" | "desc";
}

export interface FaceSummary {
  name: string;
  type: string;
  civs: string[];
  cost: number | null;
  costText: string;
  power: number | null;
  powerText: string;
  races: string[];
  abilities: string[];
}

export interface CardSummary {
  id: number;
  name: string;
  layout: string;
  zone: string;
  /** 禁断・零無 …: placed in the battle zone at game start (deck builder puts it in 特殊枠). */
  startsInBattleZone: boolean;
  civs: string[];
  races: string[];
  minCost: number | null;
  regulation: string;
  deckLimit: number | null;
  legalOriginal: boolean;
  legalAdvance: boolean;
  printingCount: number;
  image: string | null;
  faces: FaceSummary[];
  keywords: { keyword: string; scope: string; conditional: boolean; value: number | null; valueText: string | null }[];
  tags: string[];
  /** In "prints" mode: the printing this row represents. */
  printing?: PrintingSummary;
}

export interface PrintingSummary {
  id: string;
  setCode: string | null;
  setLabel: string | null;
  releaseYear: number | null;
  releaseEstimated: boolean;
  number: string | null;
  rarity: string | null;
  illustrator: string | null;
  image: string | null;
  flavor: string | null;
}

export interface SearchResult {
  query: string;
  normalizedQuery: string;
  total: number;
  page: number;
  pageSize: number;
  unique: Mode;
  items: CardSummary[];
  warnings: string[];
}

/** Pull directive terms (order:, dir:, unique:) out of the top-level AND. */
function extractDirectives(ast: Node): { ast: Node; order?: Order; dir?: "asc" | "desc"; unique?: Mode } {
  const out: { order?: Order; dir?: "asc" | "desc"; unique?: Mode } = {};
  const isDirective = (n: Node) => n.type === "term" && n.field !== null && ["order", "sort", "dir", "unique"].includes(n.field);
  const apply = (n: Node) => {
    if (n.type !== "term") return;
    const v = nfkc(n.value).toLowerCase();
    if (n.field === "order" || n.field === "sort") {
      const allowed: Order[] = ["release", "first", "name", "cost", "power", "printings", "set"];
      if (!allowed.includes(v as Order)) throw new QueryError(`order: は ${allowed.join(" / ")} のいずれか`);
      out.order = v as Order;
    } else if (n.field === "dir") {
      if (v !== "asc" && v !== "desc") throw new QueryError("dir: は asc / desc");
      out.dir = v;
    } else if (n.field === "unique") {
      if (v === "prints" || v === "art" || v === "printings") out.unique = "prints";
      else if (v === "cards") out.unique = "cards";
      else throw new QueryError("unique: は cards / prints");
    }
  };
  if (isDirective(ast)) {
    apply(ast);
    return { ast: { type: "and", children: [] }, ...out };
  }
  if (ast.type === "and") {
    const rest = ast.children.filter((c) => {
      if (isDirective(c)) {
        apply(c);
        return false;
      }
      return true;
    });
    return { ast: { type: "and", children: rest }, ...out };
  }
  return { ast, ...out };
}

function orderSql(order: Order, dir: "asc" | "desc", mode: Mode): string {
  const d = dir === "asc" ? "ASC" : "DESC";
  const rank = mode === "prints" ? "p.set_rank" : "c.latest_rank";
  switch (order) {
    case "name":
      return `c.name ${d}`;
    case "cost":
      return `c.min_cost IS NULL, c.min_cost ${d}, c.name ASC`;
    case "power":
      return `(SELECT MAX(power) FROM faces f WHERE f.card_id = c.id) IS NULL, (SELECT MAX(power) FROM faces f WHERE f.card_id = c.id) ${d}, c.name ASC`;
    case "printings":
      return `c.printing_count ${d}, c.name ASC`;
    case "first":
      return `c.first_rank ${d}, c.name ASC`;
    case "set":
      return mode === "prints" ? `p.set_rank ${d}, p.site_order ASC` : `c.latest_rank ${d}, c.name ASC`;
    case "release":
    default:
      return mode === "prints" ? `${rank} ${d}, p.site_order ASC, p.id ASC` : `${rank} ${d}, c.id ASC`;
  }
}

export class SearchEngine {
  constructor(public readonly db: DB) {}

  search(query: string, opts: SearchOptions = {}): SearchResult {
    const parsed = parseQuery(query);
    const { ast, ...directives } = extractDirectives(parsed);
    const mode: Mode = directives.unique ?? opts.unique ?? "cards";
    const order: Order = directives.order ?? opts.order ?? "release";
    const dir = directives.dir ?? opts.dir ?? (order === "name" || order === "cost" ? "asc" : "desc");
    const pageSize = Math.min(Math.max(opts.pageSize ?? 60, 1), 500);
    const page = Math.max(opts.page ?? 1, 1);

    const compiled = new Compiler(this.db, mode).compile(ast);
    const from = mode === "prints" ? "printings p JOIN cards c ON c.id = p.card_id" : "cards c";
    const total = this.db
      .prepare(`SELECT COUNT(*) FROM ${from} WHERE ${compiled.sql}`)
      .pluck()
      .get(...compiled.params) as number;
    const rows = this.db
      .prepare(
        `SELECT c.id AS card_id${mode === "prints" ? ", p.id AS printing_id" : ""} FROM ${from} WHERE ${compiled.sql}
         ORDER BY ${orderSql(order, dir, mode)} LIMIT ? OFFSET ?`,
      )
      .all(...compiled.params, pageSize, (page - 1) * pageSize) as { card_id: number; printing_id?: string }[];

    const cards = this.cardSummaries(rows.map((r) => r.card_id));
    const items = rows.map((r) => {
      const card = cards.get(r.card_id)!;
      if (!r.printing_id) return card;
      const pr = this.printing(r.printing_id);
      return { ...card, image: pr?.image ?? card.image, printing: pr ?? undefined };
    });
    return {
      query,
      normalizedQuery: formatQuery(ast),
      total,
      page,
      pageSize,
      unique: mode,
      items,
      warnings: compiled.warnings,
    };
  }

  printing(id: string): PrintingSummary | null {
    const r = this.db
      .prepare(
        `SELECT p.id, p.set_code, s.label AS set_label, s.release_year, s.release_estimated, p.number, p.rarity, p.illustrator, p.image_url, p.flavor
         FROM printings p LEFT JOIN sets s ON s.code = p.set_code WHERE p.id = ?`,
      )
      .get(id) as Record<string, string | number | null> | undefined;
    if (!r) return null;
    const str = (v: string | number | null | undefined) => (v == null ? null : String(v));
    return {
      id: String(r.id),
      setCode: str(r.set_code),
      setLabel: str(r.set_label),
      releaseYear: r.release_year == null ? null : Math.floor(Number(r.release_year)),
      releaseEstimated: !!r.release_estimated,
      number: str(r.number),
      rarity: str(r.rarity),
      illustrator: str(r.illustrator),
      image: str(r.image_url),
      flavor: str(r.flavor),
    };
  }

  cardSummaries(ids: number[]): Map<number, CardSummary> {
    const out = new Map<number, CardSummary>();
    if (!ids.length) return out;
    const ph = ids.map(() => "?").join(",");
    const cards = this.db
      .prepare(
        `SELECT c.*, (SELECT image_url FROM printings p WHERE p.id = c.canonical_printing_id) AS image
         FROM cards c WHERE c.id IN (${ph})`,
      )
      .all(...ids) as Record<string, any>[];
    const faces = this.db.prepare(`SELECT * FROM faces WHERE card_id IN (${ph}) ORDER BY card_id, face_index`).all(...ids) as Record<string, any>[];
    const kws = this.db
      .prepare(`SELECT card_id, keyword, scope, conditional, value, value_text FROM face_keywords WHERE card_id IN (${ph}) AND scope != 'ref'`)
      .all(...ids) as Record<string, any>[];
    const tags = this.db.prepare(`SELECT DISTINCT card_id, tag FROM face_tags WHERE card_id IN (${ph})`).all(...ids) as { card_id: number; tag: string }[];
    for (const c of cards) {
      out.set(c.id, {
        id: c.id,
        name: c.name,
        layout: c.layout,
        zone: c.zone,
        startsInBattleZone: !!c.starts_in_battle_zone,
        civs: JSON.parse(c.civs),
        races: JSON.parse(c.races),
        minCost: c.min_cost,
        regulation: c.regulation,
        deckLimit: c.deck_limit,
        legalOriginal: !!c.legal_original,
        legalAdvance: !!c.legal_advance,
        printingCount: c.printing_count,
        image: c.image,
        faces: [],
        keywords: [],
        tags: [],
      });
    }
    for (const f of faces)
      out.get(f.card_id)?.faces.push({
        name: f.name,
        type: f.type,
        civs: JSON.parse(f.civs),
        cost: f.cost,
        costText: f.cost_text,
        power: f.power,
        powerText: f.power_text,
        races: JSON.parse(f.races),
        abilities: f.text ? String(f.text).split("\n") : [],
      });
    for (const k of kws)
      out.get(k.card_id)?.keywords.push({
        keyword: k.keyword,
        scope: k.scope,
        conditional: !!k.conditional,
        value: k.value === 1e9 ? Infinity : k.value,
        valueText: k.value_text,
      });
    for (const t of tags) out.get(t.card_id)?.tags.push(t.tag);
    return out;
  }

  /** Full card detail including every printing (絵柄違い一覧). */
  card(
    idOrName: number | string,
  ): (CardSummary & { printings: PrintingSummary[]; qaUrl: string | null; firstSet: string | null; officialKeywords: string[] }) | null {
    const row = (
      typeof idOrName === "number"
        ? this.db.prepare("SELECT id, qa_url, first_set FROM cards WHERE id = ?").get(idOrName)
        : this.db
            .prepare(
              `SELECT id, qa_url, first_set FROM cards WHERE name = ? OR id IN (SELECT card_id FROM faces WHERE name = ?)
               ORDER BY (name = ?) DESC LIMIT 1`,
            )
            .get(nfkc(idOrName), nfkc(idOrName), nfkc(idOrName))
    ) as { id: number; qa_url: string | null; first_set: string | null } | undefined;
    if (!row) return null;
    const summary = this.cardSummaries([row.id]).get(row.id)!;
    const printings = (this.db.prepare("SELECT id FROM printings WHERE card_id = ? ORDER BY set_rank DESC, id").pluck().all(row.id) as string[]).map((id) =>
      this.printing(id)!,
    );
    const officialKeywords = this.db.prepare("SELECT keyword FROM card_official_keywords WHERE card_id = ? ORDER BY keyword").pluck().all(row.id) as string[];
    return { ...summary, printings, qaUrl: row.qa_url, firstSet: row.first_set, officialKeywords };
  }
}

export { QueryError, canonicalField };
