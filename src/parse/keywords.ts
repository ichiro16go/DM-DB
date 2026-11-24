import { nfkc, stripReminder } from "../lib/normalize.js";

/**
 * Keyword-ability extraction from ability text.
 *
 * The dictionary is the official site's "特殊能力" filter list (+ a few extras),
 * so names match the official spelling. For each occurrence we record:
 *   - scope:  "self"   the card itself has it
 *             "others" the card gives it to other cards (「…」を与える / 自分の～は「…」を得る)
 *             "ref"    only referenced (「ブロッカー」を持つクリーチャー…) – not an ability of the card
 *   - conditional: true if the card only gets it under a condition (「…」を得る), false if printed as a keyword line
 *   - value:  numeric parameter (パワーアタッカー+1000 → 1000, マナ武装5 → 5, ササゲール3 → 3)
 *   - valueText: textual parameter (革命チェンジ：火または自然のコスト5以上のドラゴン → that condition)
 */

export type KeywordScope = "self" | "others" | "ref";

export interface KeywordHit {
  keyword: string;
  scope: KeywordScope;
  conditional: boolean;
  value: number | null;
  valueText: string | null;
  abilityIndex: number;
}

/** Keywords not in the official filter list but useful to search for. */
export const EXTRA_KEYWORDS = ["シールド・トリガー", "パワーアタッカー∞"];

/** Ambiguous one-word "keywords" that only count when printed as their own line with a separator. */
const STRICT_KEYWORDS = new Set([
  "城",
  "進化",
  "覚醒",
  "解除",
  "革命",
  "連鎖",
  "飛行",
  "クロスギア",
  "返霊",
  "キズナ",
  "チャージャー",
  "デュエリスト",
  "リサイクル",
  "サイクロン",
  "ダイナモ",
  "アクセル",
  "フリーズ",
]);

/**
 * Family roots: searching kw:<root> also matches every keyword in that family
 * (kw:ブレイカー → W/T/Q/ワールド…・ブレイカー). A keyword belongs to a root's family
 * when the root is a substring of it.
 */
export const FAMILY_ROOTS = [
  "ブレイカー",
  "S・トリガー",
  "進化",
  "侵略",
  "革命チェンジ",
  "メクレイド",
  "シンパシー",
  "G・リンク",
  "ステルス",
  "ドロン・ゴー",
  "フレンド・バースト",
  "無月の門",
  "パワーアタッカー",
  "セイバー",
  "ガードマン",
  "ブロッカー",
  "シールド・プラス",
  "マナ武装",
  "ヨビニオン",
  "マッハファイター",
  "メテオバーン",
  "覚醒リンク",
  "龍解",
  "アクセル",
  "ニンジャ・ストライク",
  "EXライフ",
  "ハイパー化",
  "ジェネレート",
  "エスケープ",
  "ラスト・バースト",
  "チャージャー",
  "スレイヤー",
  "G・ゼロ",
];

/** Breaker keywords → number of shields broken (Infinity for ワールド/∞). Used for the "breaks" column. */
export const BREAKER_COUNT: Record<string, number> = {
  "W・ブレイカー": 2,
  "T・ブレイカー": 3,
  "Q・ブレイカー": 4,
  "G・ブレイカー": 5,
  "ドラゴン・W・ブレイカー": 2,
  "ドラゴン・T・ブレイカー": 3,
  "マスター・W・ブレイカー": 2,
  "マスター・T・ブレイカー": 3,
  "マスター・G・ブレイカー": 5,
  "ワールド・ブレイカー": Infinity,
  "∞ ブレイカー": Infinity,
};

export function familiesOf(keyword: string): string[] {
  return FAMILY_ROOTS.filter((r) => r !== keyword && keyword.includes(r));
}

const isWordChar = (ch: string | undefined) => !!ch && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}A-Za-zー]/u.test(ch);

export class KeywordExtractor {
  /** normalized keyword -> canonical (official) spelling, longest first */
  private readonly entries: { norm: string; name: string }[];
  private readonly names: Set<string>;

  constructor(officialNames: string[]) {
    const seen = new Map<string, string>();
    for (const name of [...officialNames, ...EXTRA_KEYWORDS]) {
      const norm = nfkc(name);
      if (!seen.has(norm)) seen.set(norm, name);
      // Also accept the spelling without the space (∞ ブレイカー / ∞ブレイカー).
      const ns = norm.replace(/ /g, "");
      if (!seen.has(ns)) seen.set(ns, name);
    }
    this.entries = [...seen.entries()].map(([norm, name]) => ({ norm, name })).sort((a, b) => b.norm.length - a.norm.length);
    this.names = new Set(this.entries.map((e) => e.name));
  }

  /** Longest keyword that `s` starts with (respecting a word boundary after it). */
  private matchPrefix(s: string): { name: string; len: number } | null {
    for (const e of this.entries) {
      if (!s.startsWith(e.norm)) continue;
      const next = s[e.norm.length];
      if (isWordChar(next) && !/^[\d∞]/.test(next ?? "")) {
        // "ブロッカーを持つ…" etc. – not a keyword line.
        continue;
      }
      if (STRICT_KEYWORDS.has(e.name) && next !== undefined && !/[:：\s(（\d+\-―ー—]/.test(next)) continue;
      return { name: e.name, len: e.norm.length };
    }
    return null;
  }

  /**
   * Keywords used as actions anywhere in a sentence (outside 「」): the keyword must start a word and
   * be followed by an optional number and a verb (する / して / を2回… / を行う).
   */
  private actions(text: string): { keyword: string; value: number | null }[] {
    const masked = text.replace(/「[^」]*」/g, (m) => "□".repeat(m.length));
    const out: { keyword: string; value: number | null }[] = [];
    for (let i = 0; i < masked.length; i++) {
      const prev = i > 0 ? masked[i - 1]! : "";
      // Must not continue a katakana / latin word ("ジョーカーズ・メクレイド" is matched from its start).
      // Particles and kanji before it are fine: "相手とガチンコ・ジャッジする", "3回ガチンコ・ジャッジ".
      if (prev && /[\p{Script=Katakana}ー・A-Za-z]/u.test(prev)) continue;
      const tail = masked.slice(i);
      const e = this.entries.find((x) => tail.startsWith(x.norm) && !STRICT_KEYWORDS.has(x.name));
      if (!e) continue;
      const after = tail.slice(e.norm.length).match(/^\s*(\d+)?\s*(する|して|した|しても|を\d+回|を行)/);
      if (after) out.push({ keyword: e.name, value: after[1] ? Number(after[1]) : null });
      i += e.norm.length - 1;
    }
    return out;
  }

  /** Extract keyword hits from the ability lines of one face. */
  extract(abilities: string[]): KeywordHit[] {
    const hits: KeywordHit[] = [];
    abilities.forEach((raw, abilityIndex) => {
      const full = nfkc(raw);
      // Tap-trigger abilities are printed with a "t" icon ("{t} 自分の山札を見る…" / "t 自分の…").
      if (/^(\{t\}|t)\s?(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}《])/u.test(stripReminder(full)) && this.names.has("タップトリガー"))
        hits.push({ keyword: "タップトリガー", scope: "self", conditional: false, value: null, valueText: null, abilityIndex });
      // Leading icons like "{S}" / "{3T}" and bullets.
      let body = stripReminder(full)
        .replace(/^(\{[^}]*\}\s*\|?\s*)+/, "")
        .replace(/^[■▪●◆・]\s*/, "");

      // Some old pages render icons as stray ASCII letters ("oSスピードアタッカー"). Drop them only
      // when that turns the line into a keyword line (keeps real keywords like "Dスイッチ").
      if (!this.matchPrefix(body)) {
        const stripped = body.replace(/^[A-Za-z]{1,2}\s?(?=[\p{Script=Katakana}\p{Script=Han}])/u, "");
        if (stripped !== body && this.matchPrefix(stripped)) body = stripped;
      }

      // Old civilization-limited slayers: "自然・光スレイヤー" → スレイヤー (自然・光)
      const civSlayer = body.match(/^((?:光|水|闇|火|自然)(?:・(?:光|水|闇|火|自然))*)スレイヤー/);
      if (civSlayer) {
        hits.push({ keyword: "スレイヤー", scope: "self", conditional: false, value: null, valueText: civSlayer[1]!, abilityIndex });
        body = body.slice(civSlayer[0].length).replace(/^\s+/, "");
      }

      // 1) Keyword lines: "W・ブレイカー", "パワーアタッカー+1000", "革命チェンジ:…", "ブロッカー、スレイヤー"
      let leading = 0;
      for (;;) {
        const m = this.matchPrefix(body);
        if (!m) break;
        let rest = body.slice(m.len);
        let value: number | null = null;
        let valueText: string | null = null;
        const num = rest.match(/^\s*([+-])?\s*(\d+|∞)/);
        if (num) {
          value = num[2] === "∞" ? Infinity : Number(num[2]);
          rest = rest.slice(num[0].length);
        }
        const bracket = rest.match(/^\s*\[([^\]]+)\]/);
        if (bracket) {
          valueText = bracket[1]!.trim();
          rest = rest.slice(bracket[0].length);
        }
        const colon = rest.match(/^\s*[:：]\s*(.*)$/);
        if (colon) {
          valueText = valueText ? `${valueText} ${colon[1]!.trim()}` : colon[1]!.trim();
          rest = "";
        }
        // 「マスターG・G・G」-style names that embed the cost after a dash: keep the remainder as text.
        const dash = rest.match(/^\s*[-―ー—]\s*(.*)$/);
        if (dash && !valueText) {
          valueText = dash[1]!.trim() || null;
          rest = "";
        }
        hits.push({ keyword: m.name, scope: "self", conditional: false, value, valueText: valueText || null, abilityIndex });
        leading++;
        const sep = rest.match(/^\s*[、,/／]\s*|^\s+(?=\S)/);
        if (!sep) break;
        body = rest.slice(sep[0].length).replace(/^(\{[^}]*\}\s*)+/, "");
      }
      // 3) Keyword actions used as verbs: "GR召喚を2回する", "ジョーカーズ・メクレイド5する", "相手とガチンコ・ジャッジする"
      const already = new Set(hits.filter((h) => h.abilityIndex === abilityIndex).map((h) => h.keyword));
      for (const a of this.actions(stripReminder(full))) {
        if (already.has(a.keyword)) continue;
        already.add(a.keyword);
        hits.push({ ...a, scope: "self", conditional: false, valueText: null, abilityIndex });
      }

      // 4) Old wording of パワーアタッカー: "攻撃中、このクリーチャーのパワーを+3000する"
      const pa = stripReminder(full).match(/攻撃中、このクリーチャーのパワー(?:を|は)[^。]*?\+(\d+)/);
      if (pa && !already.has("パワーアタッカー") && this.names.has("パワーアタッカー")) {
        hits.push({
          keyword: "パワーアタッカー",
          scope: "self",
          conditional: !/^攻撃中/.test(stripReminder(full)),
          value: Number(pa[1]),
          valueText: null,
          abilityIndex,
        });
      }

      if (leading > 0 && !full.includes("「")) return;

      // 2) Quoted mentions: このクリーチャーは「スピードアタッカー」を得る / 自分のクリーチャーに「ブロッカー」を与える
      const text = stripReminder(full);
      const quoteRe = /「([^」]+)」/g;
      for (const q of text.matchAll(quoteRe)) {
        const inner = q[1]!.trim();
        const m = this.matchPrefix(inner);
        if (!m) continue;
        // First verb after the quote within the same sentence decides the role:
        //   「X」を得る → has it (self or team), 「X」を与える → grants, 「X」を持つ… → reference.
        // Text between the quote and the verb is allowed ("水なら「ブロッカー」を、火なら「…」を与える").
        const rest = text.slice(q.index! + q[0].length);
        const sentence = rest.slice(0, rest.indexOf("。") >= 0 ? rest.indexOf("。") : undefined);
        const verb = sentence
          .replace(/「[^」]*」/g, "")
          .match(/(得る|得て|得た|得ても|持つ|持って|持た|与える|与えて|与え|失う|失って|無視|使え|によって|による)/);
        const v = verb?.[1] ?? "";
        if (v.startsWith("失")) continue;
        let scope: KeywordScope;
        if (v.startsWith("与え")) scope = isSelfTarget(text.slice(0, q.index)) ? "self" : "others";
        else if (v.startsWith("得")) scope = isSelfSubject(text.slice(0, q.index)) ? "self" : "others";
        else scope = "ref";
        const params = inner.slice(m.len);
        const num = params.match(/^\s*[+-]?\s*(\d+|∞)/);
        const colon = params.match(/[:：]\s*(.*)$/);
        hits.push({
          keyword: m.name,
          scope,
          conditional: scope !== "ref",
          value: num ? (num[1] === "∞" ? Infinity : Number(num[1])) : null,
          valueText: colon?.[1]?.trim() || null,
          abilityIndex,
        });
      }
    });
    return dedupe(hits);
  }
}

/**
 * Decide whether the grammatical subject right before a quoted keyword is the card itself.
 * We look at the clause after the last "、" / "。" (skipping chained 「…」と) and check that it
 * starts with "この…" (このクリーチャー / このカード / このドラグハート…) and is not "この…の他の".
 */
export function isSelfSubject(before: string): boolean {
  const s = before.replace(/(「[^」]*」\s*(と|や|、|,)\s*)+$/, "");
  const sentence = s.slice(s.lastIndexOf("。") + 1);
  const segments = sentence
    .split(/[、,]/)
    .map((x) => x.trim())
    .filter(Boolean);
  // Nearest preceding segment that carries a topic/subject marker.
  let clause = segments[segments.length - 1] ?? "";
  for (let i = segments.length - 1; i >= 0; i--) {
    if (/(は|が)/.test(segments[i]!)) {
      clause = segments[i]!;
      break;
    }
  }
  if (/他の/.test(clause)) return false;
  return /^(この|これ自身|自身)/.test(clause) && !/^これを装備/.test(clause);
}

/**
 * For 「…」を与える: the recipient is the clause right before the quote. "このクリーチャーに「X」を与える" /
 * "このクリーチャーのパワーを+5000し、「X」を与える" give it to the card itself.
 */
export function isSelfTarget(before: string): boolean {
  const s = before.replace(/(「[^」]*」\s*(と|や|、|,)\s*)+$/, "");
  const sentence = s.slice(s.lastIndexOf("。") + 1);
  const segments = sentence
    .split(/[、,]/)
    .map((x) => x.trim())
    .filter(Boolean);
  const clause = segments[segments.length - 1] ?? "";
  return /^この(クリーチャー|カード)/.test(clause) && !/他の/.test(clause);
}

function dedupe(hits: KeywordHit[]): KeywordHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.keyword}|${h.scope}|${h.conditional}|${h.value}|${h.valueText}|${h.abilityIndex}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
