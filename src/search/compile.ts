import type { Database } from "better-sqlite3";
import { looseKey, nfkc, setKey, textKey } from "../lib/normalize.js";
import { QueryError, type Node, type Op } from "./query.js";

/**
 * Compile a query AST into a SQL boolean expression.
 *
 * Mode "cards": rows are cards (alias c); printing-level conditions become EXISTS over printings.
 * Mode "prints": rows are printings (alias p) joined to cards (alias c); printing-level
 * conditions apply to that printing.
 *
 * Card-level conditions on stats are "any face" (a twinpact matches cost<=3 if either half does).
 */
export type Mode = "cards" | "prints";

export interface Compiled {
  sql: string;
  params: unknown[];
  warnings: string[];
}

interface FieldDef {
  names: string[];
  description: string;
  example: string;
}

/** Field reference (also rendered as help in the UI and the MCP tool description). */
export const FIELDS: Record<string, FieldDef> = {
  name: { names: ["name", "n", "名前"], description: "カード名（部分一致・ひらがな/カタカナ/記号の違いを無視）。= で完全一致", example: "name:ボルシャック" },
  text: { names: ["text", "t", "o", "テキスト"], description: "能力テキスト（部分一致）。/正規表現/ も可", example: "text:カードを1枚引く" },
  kw: {
    names: ["kw", "k", "keyword", "キーワード"],
    description: "キーワード能力（自身が持つ。条件付きで得るものも含む）。系統名でまとめ検索可（kw:ブレイカー）、kw= で系統を展開しない完全一致。数値比較可",
    example: "kw:パワーアタッカー>=2000",
  },
  kwa: { names: ["kwa"], description: "キーワード能力（条件なしで常に持つものだけ）", example: "kwa:ブロッカー" },
  grant: { names: ["grant", "付与"], description: "他のカードにキーワード能力を与える", example: "grant:スピードアタッカー" },
  okw: { names: ["okw"], description: "公式サイトの「特殊能力」検索で該当するカード", example: "okw:ジャストダイバー" },
  civ: {
    names: ["civ", "c", "文明"],
    description: "文明。: / >= は「含む」、= は「ちょうど」、<= は「その文明だけで組める（無色含む）」。多色/単色/無色も可",
    example: "c<=光水",
  },
  cost: { names: ["cost", "コスト"], description: "コスト（数値比較、3-5 の範囲指定可）", example: "cost<=3" },
  pow: { names: ["pow", "power", "パワー"], description: "パワー（9000+ は 9000 として比較）", example: "pow>=6000" },
  mana: { names: ["mana", "マナ"], description: "マナ数", example: "mana=0" },
  breaks: { names: ["breaks", "br", "ブレイク"], description: "常時のブレイク数（W・ブレイカー=2, T=3, ワールド=99）", example: "breaks>=3" },
  type: { names: ["type", "ty", "種類", "タイプ"], description: "カードの種類（部分一致）。= で完全一致", example: "type:呪文" },
  race: { names: ["race", "r", "種族"], description: "種族（部分一致）。= で完全一致", example: "race:ドラゴン" },
  set: { names: ["set", "s", "e", "弾"], description: "収録弾（DM26-RP1 / 26rp1 / dm26rp1）。末尾 * で前方一致", example: "set:dm26*" },
  first: { names: ["first", "初出", "初登場"], description: "その弾で初登場したカード（再録を除く）。set: と同じ書式", example: "first:DM26-RP1" },
  rarity: { names: ["rarity", "rar", "レアリティ"], description: "レアリティ（SR, VR, R, U, C, …）", example: "rarity:SR" },
  illust: { names: ["illust", "a", "artist", "イラスト"], description: "イラストレーター（部分一致）", example: "illust:Shishizaru" },
  flavor: { names: ["flavor", "ft", "フレーバー"], description: "フレーバーテキスト（部分一致）", example: "flavor:ボルメテウス" },
  tag: { names: ["tag", "役割"], description: "効果タグ（ルール推定）: draw, removal_destroy, mana_boost, hand_disruption …", example: "tag:draw" },
  format: { names: ["format", "f", "フォーマット"], description: "フォーマットで使用可能（original / advance。プレミアム殿堂は除外）", example: "f:original" },
  reg: { names: ["reg", "殿堂"], description: "殿堂区分: none / restricted(殿堂) / premium(プレミアム殿堂)", example: "reg:殿堂" },
  is: {
    names: ["is"],
    description: "twinpact, psychic(超次元), gr, creature, spell, evolution, multicolor, mono, colorless, vanilla, reprint, strigger, blocker",
    example: "is:twinpact",
  },
  zone: { names: ["zone"], description: "デッキの置き場所: main / hyperspatial / gr", example: "zone:hyperspatial" },
};

const ALIAS = new Map<string, string>();
for (const [key, def] of Object.entries(FIELDS)) for (const n of def.names) ALIAS.set(n.toLowerCase(), key);

const PRINT_FIELDS = new Set(["set", "rarity", "illust", "flavor"]);

const CIV_WORDS: [RegExp, number][] = [
  [/^(光|light|l|w)/, 1],
  [/^(水|water|u)/, 2],
  [/^(闇|darkness|dark|d)/, 4],
  [/^(火|fire|f)/, 8],
  [/^(自然|nature|n|g)/, 16],
];

function parseCivs(raw: string): number {
  let s = nfkc(raw)
    .toLowerCase()
    .replace(/[/,・+と]/g, "");
  let mask = 0;
  while (s.length) {
    const hit = CIV_WORDS.find(([re]) => re.test(s));
    if (!hit) throw new QueryError(`文明 "${raw}" を解釈できません（光/水/闇/火/自然/多色/単色/無色）`);
    mask |= hit[1];
    s = s.replace(hit[0], "");
  }
  return mask;
}

const SQL_OP: Record<Op, string> = { ":": "=", "=": "=", "!=": "!=", "<": "<", "<=": "<=", ">": ">", ">=": ">=" };

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
const like = (s: string) => `%${escapeLike(s)}%`;

export class Compiler {
  private params: unknown[] = [];
  private warnings: string[] = [];
  private sets: { code: string; display: string | null }[] | null = null;
  private keywordNames: Set<string> | null = null;
  private familyNames: Set<string> | null = null;
  private tagNames: Map<string, string> | null = null;

  constructor(
    private db: Database,
    private mode: Mode,
  ) {}

  compile(node: Node): Compiled {
    this.params = [];
    this.warnings = [];
    const sql = this.node(node);
    return { sql, params: this.params, warnings: this.warnings };
  }

  private p(v: unknown): string {
    this.params.push(v);
    return "?";
  }

  private node(n: Node): string {
    switch (n.type) {
      case "and":
        return n.children.length ? `(${n.children.map((c) => this.node(c)).join(" AND ")})` : "1";
      case "or":
        return `(${n.children.map((c) => this.node(c)).join(" OR ")})`;
      case "not":
        return `(NOT ${this.node(n.child)})`;
      case "term":
        return this.term(n);
    }
  }

  /** Wrap a condition on printings (alias pp) according to the mode. */
  private printCond(cond: (alias: string) => string): string {
    if (this.mode === "prints") return cond("p");
    return `EXISTS (SELECT 1 FROM printings pp WHERE pp.card_id = c.id AND ${cond("pp")})`;
  }

  private faceCond(cond: string): string {
    return `EXISTS (SELECT 1 FROM faces f WHERE f.card_id = c.id AND ${cond})`;
  }

  private numeric(column: string, op: Op, raw: string, label: string): string {
    const v = nfkc(raw);
    const range = v.match(/^(\d+)-(\d+)$/);
    if (range && (op === ":" || op === "=")) return `${column} BETWEEN ${this.p(Number(range[1]))} AND ${this.p(Number(range[2]))}`;
    if (!/^\d+$/.test(v)) throw new QueryError(`${label} には数値を指定してください: "${raw}"`);
    return `${column} ${SQL_OP[op]} ${this.p(Number(v))}`;
  }

  private term(t: Extract<Node, { type: "term" }>): string {
    const field = t.field === null ? "name" : ALIAS.get(t.field);
    if (!field) throw new QueryError(`不明なフィールド "${t.field}:"（使えるフィールド: ${Object.keys(FIELDS).join(", ")}）`);
    const v = t.value;
    if (v === "" && !t.quoted) throw new QueryError(`${t.field ?? "name"}${t.op} の値が空です`);
    const exact = t.op === "=";
    const neg = t.op === "!=";
    const wrapNeg = (s: string) => (neg ? `(NOT ${s})` : s);

    switch (field) {
      case "name": {
        if (t.regex) return wrapNeg(`regexp(${this.p(t.value)}, c.name)`);
        if (exact) return `(c.name = ${this.p(nfkc(v))} OR EXISTS (SELECT 1 FROM faces f WHERE f.card_id = c.id AND f.name = ${this.p(nfkc(v))}))`;
        return wrapNeg(`c.name_norm LIKE ${this.p(like(looseKey(v)))} ESCAPE '\\'`);
      }
      case "text": {
        if (t.regex) return wrapNeg(`regexp(${this.p(t.value)}, c.text)`);
        return wrapNeg(`c.text_norm LIKE ${this.p(like(textKey(v)))} ESCAPE '\\'`);
      }
      case "flavor":
        return wrapNeg(this.printCond((a) => `${a}.flavor LIKE ${this.p(like(nfkc(v)))} ESCAPE '\\'`));
      case "kw":
      case "kwa":
      case "grant":
        return wrapNeg(this.keyword(field, v, exact));
      case "okw": {
        const names = this.resolveKeyword(v.replace(/(>=|<=|=|>|<|\+).*$/, "")).sql;
        return wrapNeg(`EXISTS (SELECT 1 FROM card_official_keywords ok WHERE ok.card_id = c.id AND ok.keyword IN ${names})`);
      }
      case "civ":
        return this.civ(t.op, v);
      case "cost":
        return this.faceCond(this.numeric("f.cost", t.op, v, "コスト"));
      case "pow":
        return this.faceCond(this.numeric("f.power", t.op, v, "パワー"));
      case "mana":
        return this.faceCond(this.numeric("f.mana", t.op, v, "マナ"));
      case "breaks":
        return this.faceCond(this.numeric("f.breaks", t.op, v, "ブレイク数"));
      case "type": {
        const ty = nfkc(this.typeAlias(v));
        return wrapNeg(this.faceCond(exact ? `f.type = ${this.p(ty)}` : `f.type LIKE ${this.p(like(ty))} ESCAPE '\\'`));
      }
      case "race": {
        if (exact) return wrapNeg(this.faceCond(`EXISTS (SELECT 1 FROM face_races fr WHERE fr.face_id = f.id AND fr.race = ${this.p(nfkc(v))})`));
        return wrapNeg(
          `EXISTS (SELECT 1 FROM faces f JOIN face_races fr ON fr.face_id = f.id WHERE f.card_id = c.id AND fr.race_norm LIKE ${this.p(like(looseKey(v)))} ESCAPE '\\')`,
        );
      }
      case "set": {
        const codes = this.resolveSet(v);
        return wrapNeg(this.printCond((a) => `${a}.set_code IN (${codes.map((x) => this.p(x)).join(", ")})`));
      }
      case "first": {
        const codes = this.resolveSet(v);
        return wrapNeg(`c.first_set IN (${codes.map((x) => this.p(x)).join(", ")})`);
      }
      case "rarity":
        return wrapNeg(this.printCond((a) => `UPPER(${a}.rarity) = ${this.p(nfkc(v).toUpperCase())}`));
      case "illust": {
        const key = looseKey(v);
        if (exact) return wrapNeg(this.printCond((a) => `${a}.illustrator = ${this.p(v)}`));
        return wrapNeg(this.printCond((a) => `${a}.illustrator_norm LIKE ${this.p(like(key))} ESCAPE '\\'`));
      }
      case "tag": {
        const tag = this.resolveTag(v);
        return wrapNeg(`EXISTS (SELECT 1 FROM face_tags ft WHERE ft.card_id = c.id AND ft.tag = ${this.p(tag)})`);
      }
      case "format": {
        const f = nfkc(v).toLowerCase();
        if (/^(original|orig|o|オリジナル)$/.test(f)) return wrapNeg(`(c.legal_original = 1 AND c.regulation != 'premium')`);
        if (/^(advance|adv|a|アドバンス)$/.test(f)) return wrapNeg(`(c.legal_advance = 1 AND c.regulation != 'premium')`);
        throw new QueryError(`不明なフォーマット "${v}"（original / advance）`);
      }
      case "reg": {
        const r = nfkc(v).toLowerCase();
        const status = /^(none|無制限|なし|free)$/.test(r)
          ? "none"
          : /^(premium|プレミアム殿堂|プレ殿|banned)$/.test(r)
            ? "premium"
            : /^(restricted|殿堂|殿堂入り|1)$/.test(r)
              ? "restricted"
              : null;
        if (!status) throw new QueryError(`不明な殿堂区分 "${v}"（none / restricted(殿堂) / premium(プレ殿)）`);
        return wrapNeg(`c.regulation = ${this.p(status)}`);
      }
      case "zone": {
        const z = nfkc(v).toLowerCase();
        const zone = /^(main|メイン)/.test(z) ? "main" : /^(hyper|超次元|psychic)/.test(z) ? "hyperspatial" : /^(gr|超gr)/.test(z) ? "gr" : null;
        if (!zone) throw new QueryError(`不明なゾーン "${v}"（main / hyperspatial / gr）`);
        return wrapNeg(`c.zone = ${this.p(zone)}`);
      }
      case "is":
        return wrapNeg(this.is(v));
    }
    throw new QueryError(`未対応のフィールド ${field}`);
  }

  private typeAlias(v: string): string {
    const m: Record<string, string> = {
      creature: "クリーチャー",
      spell: "呪文",
      evo: "進化",
      evolution: "進化",
      psychic: "サイキック",
      dragheart: "ドラグハート",
      field: "フィールド",
      castle: "城",
      crossgear: "クロスギア",
      tamaseed: "タマシード",
      aura: "オーラ",
    };
    return m[v.toLowerCase()] ?? v;
  }

  private is(v: string): string {
    const k = nfkc(v).toLowerCase();
    switch (k) {
      case "twinpact":
      case "ツインパクト":
        return `c.layout = 'twinpact'`;
      case "multi":
      case "flip":
      case "両面":
        return `c.layout = 'multi'`;
      case "psychic":
      case "hyperspatial":
      case "超次元":
        return `c.zone = 'hyperspatial'`;
      case "gr":
        return `c.zone = 'gr'`;
      case "creature":
      case "クリーチャー":
        return this.faceCond("f.is_creature = 1");
      case "spell":
      case "呪文":
        return this.faceCond("f.is_spell = 1");
      case "evolution":
      case "evo":
      case "進化":
        return this.faceCond("f.is_evolution = 1");
      case "multicolor":
      case "多色":
        return `c.civ_count >= 2`;
      case "mono":
      case "monocolor":
      case "単色":
        return `c.civ_count = 1`;
      case "colorless":
      case "無色":
      case "ゼロ":
        return `c.civ_mask = 0`;
      case "vanilla":
      case "バニラ":
        return `c.text = ''`;
      case "reprint":
      case "再録":
        return `c.printing_count > 1`;
      case "strigger":
      case "トリガー":
        return this.keyword("kw", "S・トリガー");
      case "blocker":
      case "ブロッカー":
        return this.keyword("kw", "ブロッカー");
      case "battlezone":
        return `c.starts_in_battle_zone = 1`;
    }
    throw new QueryError(`不明な is:${v}（${FIELDS.is!.description}）`);
  }

  private civ(op: Op, raw: string): string {
    const v = nfkc(raw).toLowerCase();
    if (/^(多色|multi|multicolor|gold)$/.test(v)) return op === "!=" ? `c.civ_count < 2` : `c.civ_count >= 2`;
    if (/^(単色|mono)$/.test(v)) return op === "!=" ? `c.civ_count != 1` : `c.civ_count = 1`;
    if (/^(無色|ゼロ|colorless|zero|c)$/.test(v)) return op === "!=" ? `c.civ_mask != 0` : `c.civ_mask = 0`;
    const m = parseCivs(v);
    const q = this.p(m);
    switch (op) {
      case ":":
      case ">=":
        return `(c.civ_mask & ${q}) = ${this.p(m)}`;
      case "=":
        return `c.civ_mask = ${q}`;
      case "!=":
        return `c.civ_mask != ${q}`;
      case "<=":
        return `(c.civ_mask & ~${q}) = 0`;
      case "<":
        return `((c.civ_mask & ~${q}) = 0 AND c.civ_mask != ${this.p(m)})`;
      case ">":
        return `((c.civ_mask & ${q}) = ${this.p(m)} AND c.civ_mask != ${this.p(m)})`;
    }
  }

  private loadKeywords() {
    if (!this.keywordNames) {
      this.keywordNames = new Set(this.db.prepare("SELECT name FROM keywords").pluck().all() as string[]);
      this.familyNames = new Set(this.db.prepare("SELECT DISTINCT family FROM keyword_families").pluck().all() as string[]);
    }
  }

  /** Returns an SQL list "(…)" of keyword names covered by `raw` (exact name or family). */
  private resolveKeyword(raw: string, exact = false): { sql: string; name: string } {
    this.loadKeywords();
    const name = nfkc(raw);
    const candidates = [name, name.replace(/ /g, ""), raw];
    const hit = candidates.find((c) => this.keywordNames!.has(c) || this.familyNames!.has(c));
    if (!hit) {
      // Loose fallback: match ignoring separators (ジャストダイバー ≈ ジャスト・ダイバー).
      const key = looseKey(name);
      const loose = [...this.keywordNames!, ...this.familyNames!].filter((k) => looseKey(k) === key);
      if (loose.length) return this.resolveKeyword(loose[0]!, exact);
      const similar = [...this.keywordNames!].filter((k) => looseKey(k).includes(key) || key.includes(looseKey(k))).slice(0, 8);
      throw new QueryError(`不明なキーワード能力 "${raw}"${similar.length ? `（候補: ${similar.join(", ")}）` : ""}`);
    }
    const sql = exact ? `(${this.p(hit)})` : `(SELECT ${this.p(hit)} UNION SELECT keyword FROM keyword_families WHERE family = ${this.p(hit)})`;
    return { sql, name: hit };
  }

  /** exact=true (kw=…) matches only that keyword; otherwise the keyword's family is included. */
  private keyword(field: "kw" | "kwa" | "grant", raw: string, exact = false): string {
    // "パワーアタッカー>=2000", "パワーアタッカー+1000" and "パワーアタッカー1000" all carry a value,
    // unless the whole string is itself a keyword ("ジョラゴン・ビッグ1").
    this.loadKeywords();
    const whole = nfkc(raw);
    const isName = this.keywordNames!.has(whole) || this.familyNames!.has(whole);
    const m = isName ? null : whole.match(/^(.+?)(>=|<=|!=|=|>|<|\+)?\s*(\d+|∞)$/);
    const name = m ? m[1]! : raw;
    const { sql } = this.resolveKeyword(name, exact);
    const conds = [`fk.card_id = c.id`, `fk.keyword IN ${sql}`];
    conds.push(field === "grant" ? `fk.scope = 'others'` : `fk.scope = 'self'`);
    if (field === "kwa") conds.push(`fk.conditional = 0`);
    if (m) {
      const op = !m[2] || m[2] === "+" ? "=" : m[2];
      const value = m[3] === "∞" ? 1e9 : Number(m[3]);
      conds.push(`fk.value ${op === "!=" ? "!=" : op} ${this.p(value)}`);
    }
    return `EXISTS (SELECT 1 FROM face_keywords fk WHERE ${conds.join(" AND ")})`;
  }

  private resolveSet(raw: string): string[] {
    this.sets ??= this.db.prepare("SELECT code, display_code AS display FROM sets").all() as { code: string; display: string | null }[];
    const key = setKey(raw);
    const prefix = key.endsWith("*");
    const k = key.replace(/\*$/, "");
    const forms = (s: { code: string; display: string | null }) => [s.code, `dm${s.code}`, s.display ? setKey(s.display) : ""].filter(Boolean);
    const hits = this.sets.filter((s) => forms(s).some((f) => (prefix ? f.startsWith(k) : f === k))).map((s) => s.code);
    if (!hits.length) throw new QueryError(`収録弾 "${raw}" が見つかりません（例: set:DM26-RP1, set:dm26*）`);
    return hits;
  }

  private resolveTag(raw: string): string {
    this.tagNames ??= new Map(
      (this.db.prepare("SELECT tag, label FROM tags").all() as { tag: string; label: string }[]).flatMap((r) => [
        [r.tag, r.tag],
        [nfkc(r.label), r.tag],
      ]),
    );
    const hit = this.tagNames.get(raw) ?? this.tagNames.get(nfkc(raw));
    if (!hit) throw new QueryError(`不明なタグ "${raw}"（候補: ${[...new Set(this.tagNames.values())].join(", ")}）`);
    return hit;
  }
}

export function isPrintField(field: string | null): boolean {
  return !!field && PRINT_FIELDS.has(ALIAS.get(field) ?? "");
}

export function canonicalField(field: string): string | undefined {
  return ALIAS.get(field.toLowerCase());
}
