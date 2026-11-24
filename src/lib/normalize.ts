/**
 * Text normalization shared by the parser, the DB builder and the search engine.
 * Every "*_norm" column in the DB is produced by one of these functions, and the
 * search engine applies the same function to user input, so they always agree.
 */

/** NFKC + trim + collapse whitespace. Full-width digits/letters/punctuation become ASCII. */
export function nfkc(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** Katakana -> Hiragana (so ぼるしゃっく matches ボルシャック). */
export function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/**
 * Loose key for name / illustrator search:
 * NFKC, lowercase, katakana->hiragana, and drop separators (spaces, ・, ･, =, -, quotes…)
 * so that "ボルシャックドラゴン" matches "ボルシャック・ドラゴン".
 */
export function looseKey(s: string): string {
  return toHiragana(nfkc(s).toLowerCase()).replace(/[\s・･·=＝\-‐‑–—―_.,、。'"“”‘’`《》≪≫「」『』()（）\[\]【】/／!！?？~〜～]/g, "");
}

/** Normalization for ability text search: NFKC + lowercase, separators kept. */
export function textKey(s: string): string {
  return nfkc(s).toLowerCase();
}

/** Parse an integer that may be written with full-width digits. Returns null if absent. */
export function parseIntLoose(s: string | null | undefined): number | null {
  if (s == null) return null;
  const m = nfkc(s).match(/-?\d+/);
  return m ? Number(m[0]) : null;
}

/** Normalize a set code: "DM26-RP1" / "dm26rp1" / "DM26RP1" -> "dm26rp1". */
export function setKey(s: string): string {
  return nfkc(s)
    .toLowerCase()
    .replace(/[\s\-_]/g, "");
}

/** Remove reminder text in parentheses: "W・ブレイカー（…）" -> "W・ブレイカー". Handles nesting. */
export function stripReminder(s: string): string {
  let out = "";
  let depth = 0;
  for (const ch of nfkc(s)) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}
