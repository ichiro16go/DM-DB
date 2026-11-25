import { looseKey, nfkc } from "../lib/normalize.js";

/**
 * Matching archetype names between a weekly ranking (core names: "生徒会組", "ザゼゼーン/ウィリデ",
 * "白青黒緑ドギラゴン逆") and CS placements (full names: "アナカラー生徒会組", "白緑ウィリデ",
 * "白青黒緑ニバイケンドギラゴン逆").
 *
 * Tiers, best first:
 *   exact     the placement name equals an alias
 *   contains  an alias is contained in the placement name
 *   core      after stripping color words / color nicknames from both, the alias core is
 *             contained in the placement core
 * Within a tier the longest alias wins (so "ドギラゴン逆" beats "ドギラゴン").
 */

/** Color words and DM color nicknames that prefix archetype names. */
const COLOR_WORDS = [
  "アナカラー",
  "トリーヴァ",
  "デアリ",
  "リース",
  "ドロマー",
  "クローシス",
  "ラッカ",
  "シータ",
  "ジャンカラー",
  "ガイアッシュ",
  "ミラダンテ",
  "自然",
  "単色",
  "5c",
  "4c",
  "3c",
  "5色",
  "4色",
  "白",
  "青",
  "黒",
  "赤",
  "緑",
  "光",
  "水",
  "闇",
  "火",
  "零",
  "単",
];
const COLOR_KEYS = COLOR_WORDS.map((w) => archKey(w)).sort((a, b) => b.length - a.length);

/** Matching key: looseKey + 龍→竜 + drop "系" ("アナカラー系生徒会組" ≈ "アナカラー生徒会組"). */
export function archKey(name: string): string {
  return looseKey(name).replace(/龍/g, "竜").replace(/系/g, "");
}

/**
 * Clean the archetype field of a placement, which sometimes carries the player:
 * "ふねみかん【光水自然創世竜】" → "光水自然創世竜", "マツ.選手(火光自然レッドゾーン)" → "火光自然レッドゾーン",
 * "アナカラー生徒会組@ぷく" → "アナカラー生徒会組".
 */
export function cleanPlacementArchetype(s: string): string {
  const t = nfkc(s);
  const bracket = t.match(/【([^】]+)】/);
  if (bracket) return bracket[1]!.trim();
  const sensyu = t.match(/選手\s*\(([^)]+)\)/);
  if (sensyu) return sensyu[1]!.trim();
  return t.replace(/@.*$/, "").trim();
}

/** Strip leading color words: "白青黒緑ドギラゴン逆" → "ドギラゴン逆" (as archKey). */
export function coreKey(name: string): string {
  let k = archKey(name);
  for (let changed = true; changed;) {
    changed = false;
    for (const c of COLOR_KEYS) {
      if (k.startsWith(c) && k.length > c.length + 1) {
        k = k.slice(c.length);
        changed = true;
        break;
      }
    }
  }
  return k;
}

export function aliasesOf(name: string): string[] {
  return nfkc(name)
    .split(/[/／＆&・]|\s+or\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 1);
}

export type MatchMethod = "exact" | "contains" | "core" | "core-reverse";

export interface ArchetypeMatch<T> {
  target: T;
  method: MatchMethod;
  alias: string;
}

export function matchArchetype<T extends { name: string }>(placementName: string, candidates: T[]): ArchetypeMatch<T> | null {
  const cleaned = cleanPlacementArchetype(placementName);
  const p = archKey(cleaned);
  const pCore = coreKey(cleaned);
  let best: (ArchetypeMatch<T> & { tier: number; len: number }) | null = null;
  for (const t of candidates) {
    for (const alias of [t.name, ...aliasesOf(t.name)]) {
      const a = archKey(alias);
      const aCore = coreKey(alias);
      let tier = 0;
      let method: MatchMethod | null = null;
      if (a && a === p) [tier, method] = [4, "exact"];
      else if ((a.length >= 2 && p.includes(a)) || (a.length === 1 && p.endsWith(a))) [tier, method] = [3, "contains"];
      else if (aCore.length >= 2 && pCore.includes(aCore)) [tier, method] = [2, "core"];
      // The placement name is the shorter one: "デアリアトム" (core アトム) ↔ "アトム革命チェンジ".
      else if (pCore.length >= 3 && aCore.includes(pCore)) [tier, method] = [1, "core-reverse"];
      if (!method) continue;
      const len = method === "core" ? aCore.length : a.length;
      if (!best || tier > best.tier || (tier === best.tier && len > best.len)) best = { target: t, method, alias, tier, len };
    }
  }
  return best ? { target: best.target, method: best.method, alias: best.alias } : null;
}
