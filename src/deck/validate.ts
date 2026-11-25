import type { Database } from "better-sqlite3";
import { looseKey, nfkc } from "../lib/normalize.js";
import { FORMAT_ZONES, ZONES, type Format, type Zone } from "./rules.js";

/**
 * Deck legality check for オリジナル / アドバンス.
 *
 * Zone sizes and per-zone copy limits come from ./rules.ts:
 * オリジナル: main deck 40, no 超次元/超GR/特殊枠, no cards that start the game in the battle zone.
 * アドバンス: main deck 40, 超次元 ≤ 8, 超GR 0 or exactly 12 (≤ 2 per name), 特殊枠 (禁断・零無 …).
 * Both: same-name ≤ 4 (unless the card says 何枚でも), 殿堂 ≤ 1, プレミアム殿堂 0, プレミアム殿堂コンビ not together.
 */
export type { Format, Zone } from "./rules.js";

export interface DeckEntry {
  name: string;
  count: number;
}

export interface DeckInput {
  format: Format;
  main: DeckEntry[];
  hyperspatial?: DeckEntry[];
  gr?: DeckEntry[];
  special?: DeckEntry[];
}

export interface DeckProblem {
  severity: "error" | "warning";
  message: string;
  card?: string;
}

export interface DeckReport {
  valid: boolean;
  format: Format;
  counts: Record<Zone, number>;
  problems: DeckProblem[];
  resolved: { zone: string; input: string; name: string | null }[];
  civs: Record<string, number>;
  costCurve: Record<string, number>;
}

interface CardRow {
  id: number;
  name: string;
  zone: string;
  starts_in_battle_zone: number;
  regulation: string;
  deck_limit: number | null;
  civs: string;
  min_cost: number | null;
}

/** Zone names as used in messages. */
const ZONE_NAME: Record<Zone, string> = { main: "メインデッキ", hyperspatial: "超次元ゾーン", gr: "超GRゾーン", special: "特殊枠" };

export function validateDeck(db: Database, deck: DeckInput): DeckReport {
  const problems: DeckProblem[] = [];
  const resolved: DeckReport["resolved"] = [];
  const find = db.prepare(
    `SELECT id, name, zone, starts_in_battle_zone, regulation, deck_limit, civs, min_cost FROM cards
     WHERE name = ? OR id IN (SELECT card_id FROM faces WHERE name = ?) ORDER BY (name = ?) DESC LIMIT 1`,
  );
  const findLoose = db.prepare(
    `SELECT id, name, zone, starts_in_battle_zone, regulation, deck_limit, civs, min_cost FROM cards WHERE name_norm LIKE ? LIMIT 2`,
  );

  const lookup = (zone: string, e: DeckEntry): CardRow | null => {
    const raw = e.name.trim().replace(/^[《≪]|[》≫]$/g, "");
    const n = nfkc(raw);
    // Card names are stored as printed (full-width ＆ ～ ７ …): try the raw spelling, then NFKC.
    let row = (find.get(raw, raw, raw) ?? find.get(n, n, n)) as CardRow | undefined;
    if (!row) {
      const loose = findLoose.all(`%${looseKey(n)}%`) as CardRow[];
      if (loose.length === 1) {
        row = loose[0];
        problems.push({ severity: "warning", message: `「${e.name}」を《${row!.name}》として扱いました`, card: row!.name });
      }
    }
    resolved.push({ zone, input: e.name, name: row?.name ?? null });
    if (!row) problems.push({ severity: "error", message: `カードが見つかりません: 「${e.name}」`, card: e.name });
    if (!Number.isInteger(e.count) || e.count <= 0) problems.push({ severity: "error", message: `枚数が不正です: 「${e.name}」×${e.count}` });
    return row ?? null;
  };

  const zones = Object.fromEntries(ZONES.map((z) => [z, (deck[z] ?? []).map((e) => ({ e, row: lookup(z, e) }))])) as Record<
    Zone,
    { e: DeckEntry; row: CardRow | null }[]
  >;
  const sum = (xs: { e: DeckEntry }[]) => xs.reduce((s, x) => s + x.e.count, 0);
  const counts = Object.fromEntries(ZONES.map((z) => [z, sum(zones[z])])) as Record<Zone, number>;
  const rules = FORMAT_ZONES[deck.format];
  const fmtName = deck.format === "original" ? "オリジナル" : "アドバンス";

  // Zone sizes
  for (const z of ZONES) {
    const rule = rules[z];
    const n = counts[z];
    if (!rule) {
      if (n > 0) problems.push({ severity: "error", message: `${fmtName}では${ZONE_NAME[z]}を使用できません` });
      continue;
    }
    if (rule.exact !== null && n !== rule.exact) problems.push({ severity: "error", message: `${ZONE_NAME[z]}は${rule.exact}枚ちょうどです（現在 ${n} 枚）` });
    else if (rule.allowed && !rule.allowed.includes(n))
      problems.push({ severity: "error", message: `${ZONE_NAME[z]}は${rule.allowed.join("枚か")}枚ちょうどです（現在 ${n} 枚）` });
    else if (rule.max !== null && n > rule.max) problems.push({ severity: "error", message: `${ZONE_NAME[z]}は${rule.max}枚までです（現在 ${n} 枚）` });
  }

  // Card placement
  for (const { row } of zones.main) {
    if (!row) continue;
    if (row.zone !== "main")
      problems.push({
        severity: "error",
        message: `《${row.name}》はメインデッキに入れられません（${row.zone === "gr" ? "超GR" : "超次元"}ゾーンのカード）`,
        card: row.name,
      });
    else if (row.starts_in_battle_zone)
      problems.push({
        severity: "error",
        message:
          deck.format === "original"
            ? `《${row.name}》はゲーム開始時にバトルゾーンに置くカードのため、オリジナルでは使用できません`
            : `《${row.name}》はゲーム開始時にバトルゾーンに置くカードです。特殊枠に入れてください`,
        card: row.name,
      });
  }
  for (const { row } of zones.hyperspatial)
    if (row && row.zone !== "hyperspatial") problems.push({ severity: "error", message: `《${row.name}》は超次元ゾーンに入れられません`, card: row.name });
  for (const { row } of zones.gr)
    if (row && row.zone !== "gr") problems.push({ severity: "error", message: `《${row.name}》は超GRゾーンに入れられません`, card: row.name });
  for (const { row } of zones.special)
    if (row && !row.starts_in_battle_zone)
      problems.push({ severity: "error", message: `《${row.name}》は特殊枠に入れられません（ゲーム開始時にバトルゾーンに置くカードだけ）`, card: row.name });

  // Per-name limits (across all zones)
  const byCard = new Map<number, { row: CardRow; count: number; zone: Zone }>();
  for (const [zone, list] of Object.entries(zones))
    for (const { e, row } of list) {
      if (!row) continue;
      const cur = byCard.get(row.id) ?? { row, count: 0, zone: zone as Zone };
      cur.count += e.count;
      byCard.set(row.id, cur);
    }
  for (const { row, count, zone } of byCard.values()) {
    if (row.regulation === "premium") problems.push({ severity: "error", message: `《${row.name}》はプレミアム殿堂です（0枚）`, card: row.name });
    else if (row.regulation === "restricted" && count > 1)
      problems.push({ severity: "error", message: `《${row.name}》は殿堂入りです（1枚まで、現在 ${count} 枚）`, card: row.name });
    else if (rules[zone]?.perName != null && count > rules[zone]!.perName!)
      problems.push({
        severity: "error",
        message: `${ZONE_NAME[zone]}の同名カードは${rules[zone]!.perName}枚までです: 《${row.name}》×${count}`,
        card: row.name,
      });
    else if (row.deck_limit !== null && count > row.deck_limit)
      problems.push({ severity: "error", message: `同名カードは${row.deck_limit}枚までです: 《${row.name}》×${count}`, card: row.name });
  }

  // Premium combos
  const combos = db.prepare("SELECT combo_id, kind, card_id FROM regulation_combos").all() as { combo_id: number; kind: string; card_id: number }[];
  const comboMap = new Map<number, number[]>();
  for (const c of combos) comboMap.set(c.combo_id, [...(comboMap.get(c.combo_id) ?? []), c.card_id]);
  for (const ids of comboMap.values()) {
    if (ids.length >= 2 && ids.every((id) => byCard.has(id))) {
      problems.push({
        severity: "error",
        message: `プレミアム殿堂コンビ: ${ids.map((id) => `《${byCard.get(id)!.row.name}》`).join(" + ")} は同時に使用できません`,
      });
    }
  }

  // Stats (main deck)
  const civs: Record<string, number> = {};
  const costCurve: Record<string, number> = {};
  for (const { e, row } of zones.main) {
    if (!row) continue;
    for (const c of JSON.parse(row.civs) as string[]) civs[c] = (civs[c] ?? 0) + e.count;
    const k = row.min_cost === null ? "-" : row.min_cost >= 10 ? "10+" : String(row.min_cost);
    costCurve[k] = (costCurve[k] ?? 0) + e.count;
  }

  return {
    valid: !problems.some((p) => p.severity === "error"),
    format: deck.format,
    counts,
    problems,
    resolved,
    civs,
    costCurve,
  };
}

/** Parse a plain-text deck list: "4 ボルシャック・ドラゴン" / "ボルシャック・ドラゴン x4" / section headers 超次元 / GR. */
export function parseDeckText(text: string, format: Format = "original"): DeckInput {
  const deck: DeckInput = { format, main: [], hyperspatial: [], gr: [], special: [] };
  let zone: Zone = "main";
  for (const raw of text.split(/\r?\n/)) {
    const line = nfkc(raw).trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    if (/^(超次元|hyperspatial|psychic)/i.test(line)) {
      zone = "hyperspatial";
      continue;
    }
    if (/^(超GR|GR|gr)\b/i.test(line) || /^超GRゾーン/.test(line)) {
      zone = "gr";
      continue;
    }
    if (/^(特殊枠?|special)\s*[:：]?$/i.test(line)) {
      zone = "special";
      continue;
    }
    if (/^(メイン|main)/i.test(line)) {
      zone = "main";
      continue;
    }
    const m = line.match(/^(\d+)\s*[x×]?\s+(.+)$/) ?? line.match(/^(.+?)\s*[x×*]\s*(\d+)$/);
    if (!m) {
      deck[zone]!.push({ name: line, count: 1 });
      continue;
    }
    const [count, name] = /^\d+$/.test(m[1]!) ? [Number(m[1]), m[2]!] : [Number(m[2]), m[1]!];
    deck[zone]!.push({ name: name.trim(), count });
  }
  return deck;
}
