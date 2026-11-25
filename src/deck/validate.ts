import type { Database } from "better-sqlite3";
import { looseKey, nfkc } from "../lib/normalize.js";

/**
 * Deck legality check for オリジナル / アドバンス.
 *
 * オリジナル: main deck 40, no 超次元/超GR, no cards that start the game in the battle zone.
 * アドバンス: main deck 40, 超次元 ≤ 8 (psychic / dragheart / デュエルメイト), 超GR 0 or exactly 12 (≤ 2 per name).
 * Both: same-name ≤ 4 (unless the card says 何枚でも), 殿堂 ≤ 1, プレミアム殿堂 0, プレミアム殿堂コンビ not together.
 */
export type Format = "original" | "advance";

export interface DeckEntry {
  name: string;
  count: number;
}

export interface DeckInput {
  format: Format;
  main: DeckEntry[];
  hyperspatial?: DeckEntry[];
  gr?: DeckEntry[];
}

export interface DeckProblem {
  severity: "error" | "warning";
  message: string;
  card?: string;
}

export interface DeckReport {
  valid: boolean;
  format: Format;
  counts: { main: number; hyperspatial: number; gr: number };
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

  const zones = {
    main: deck.main.map((e) => ({ e, row: lookup("main", e) })),
    hyperspatial: (deck.hyperspatial ?? []).map((e) => ({ e, row: lookup("hyperspatial", e) })),
    gr: (deck.gr ?? []).map((e) => ({ e, row: lookup("gr", e) })),
  };
  const sum = (xs: { e: DeckEntry }[]) => xs.reduce((s, x) => s + x.e.count, 0);
  const counts = { main: sum(zones.main), hyperspatial: sum(zones.hyperspatial), gr: sum(zones.gr) };

  // Zone sizes
  if (counts.main !== 40) problems.push({ severity: "error", message: `メインデッキは40枚ちょうどです（現在 ${counts.main} 枚）` });
  if (deck.format === "original") {
    if (counts.hyperspatial > 0) problems.push({ severity: "error", message: "オリジナルでは超次元ゾーンを使用できません" });
    if (counts.gr > 0) problems.push({ severity: "error", message: "オリジナルでは超GRゾーンを使用できません" });
  } else {
    if (counts.hyperspatial > 8) problems.push({ severity: "error", message: `超次元ゾーンは8枚までです（現在 ${counts.hyperspatial} 枚）` });
    if (counts.gr !== 0 && counts.gr !== 12) problems.push({ severity: "error", message: `超GRゾーンは0枚か12枚ちょうどです（現在 ${counts.gr} 枚）` });
  }

  // Card placement
  for (const { e, row } of zones.main) {
    if (!row) continue;
    if (row.zone !== "main")
      problems.push({
        severity: "error",
        message: `《${row.name}》はメインデッキに入れられません（${row.zone === "gr" ? "超GR" : "超次元"}ゾーンのカード）`,
        card: row.name,
      });
    if (deck.format === "original" && row.starts_in_battle_zone)
      problems.push({
        severity: "error",
        message: `《${row.name}》はゲーム開始時にバトルゾーンに置くカードのため、オリジナルでは使用できません`,
        card: row.name,
      });
    void e;
  }
  for (const { row } of zones.hyperspatial)
    if (row && row.zone !== "hyperspatial") problems.push({ severity: "error", message: `《${row.name}》は超次元ゾーンに入れられません`, card: row.name });
  for (const { row } of zones.gr)
    if (row && row.zone !== "gr") problems.push({ severity: "error", message: `《${row.name}》は超GRゾーンに入れられません`, card: row.name });

  // Per-name limits (across all zones)
  const byCard = new Map<number, { row: CardRow; count: number; zone: string }>();
  for (const [zone, list] of Object.entries(zones))
    for (const { e, row } of list) {
      if (!row) continue;
      const cur = byCard.get(row.id) ?? { row, count: 0, zone };
      cur.count += e.count;
      byCard.set(row.id, cur);
    }
  for (const { row, count, zone } of byCard.values()) {
    if (row.regulation === "premium") problems.push({ severity: "error", message: `《${row.name}》はプレミアム殿堂です（0枚）`, card: row.name });
    else if (row.regulation === "restricted" && count > 1)
      problems.push({ severity: "error", message: `《${row.name}》は殿堂入りです（1枚まで、現在 ${count} 枚）`, card: row.name });
    else if (zone === "gr" && count > 2)
      problems.push({ severity: "error", message: `超GRゾーンの同名カードは2枚までです: 《${row.name}》×${count}`, card: row.name });
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
  const deck: DeckInput = { format, main: [], hyperspatial: [], gr: [] };
  let zone: "main" | "hyperspatial" | "gr" = "main";
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
