/**
 * Deck construction rules and display constants, shared by the server (validator) and the web UI.
 * Change numbers here when the official rules change; nothing else should hard-code them.
 * Keep this file free of imports so both the Node build and the Vite build can use it.
 */

export type Format = "original" | "advance";
export type Zone = "main" | "hyperspatial" | "gr" | "special";

export const ZONES: Zone[] = ["main", "hyperspatial", "gr", "special"];

export const ZONE_LABEL: Record<Zone, string> = { main: "メイン", hyperspatial: "超次元", gr: "超GR", special: "特殊枠" };
export const ZONE_LONG_LABEL: Record<Zone, string> = {
  main: "メインデッキ",
  hyperspatial: "超次元ゾーン",
  gr: "超GRゾーン",
  special: "特殊枠（ゲーム開始時にバトルゾーンに置くカード）",
};

export interface ZoneRule {
  /** exact size required (null = any size within min/max) */
  exact: number | null;
  /** allowed sizes when not exact; `allowed` lists every legal size if only some are legal (GR: 0 or 12) */
  max: number | null;
  allowed?: number[];
  /** copies of one card name allowed in this zone (null = the card's own limit, normally 4) */
  perName: number | null;
}

/** Which zones a format uses and their sizes. A zone missing from a format is not allowed there. */
export const FORMAT_ZONES: Record<Format, Partial<Record<Zone, ZoneRule>>> = {
  original: {
    main: { exact: 40, max: 40, perName: null },
  },
  advance: {
    main: { exact: 40, max: 40, perName: null },
    hyperspatial: { exact: null, max: 8, perName: null },
    gr: { exact: null, max: 12, allowed: [0, 12], perName: 2 },
    // Cards placed in the battle zone at the start of the game (禁断, 零無 …). The limit is a
    // parameter on purpose: adjust it here if the official rule differs.
    special: { exact: null, max: 1, perName: 1 },
  },
};

export const DEFAULT_COPY_LIMIT = 4;

export const zonesOf = (format: Format): Zone[] => ZONES.filter((z) => FORMAT_ZONES[format][z]);

/** Zone a card belongs to, from its DB zone and whether it starts the game in the battle zone. */
export const homeZone = (dbZone: string, startsInBattleZone: boolean): Zone =>
  startsInBattleZone ? "special" : dbZone === "hyperspatial" || dbZone === "gr" ? dbZone : "main";

/** Civilization colors (UI). 多色 uses a diagonal gradient of its colors. */
export const CIV_COLOR: Record<string, string> = {
  光: "#E2B714",
  水: "#2F7FD8",
  闇: "#6B4C9A",
  火: "#D8443A",
  自然: "#3C9A4B",
  ゼロ: "#9AA0AA",
  無色: "#9AA0AA",
};
export const CIV_ORDER = ["光", "水", "闇", "火", "自然", "ゼロ", "無色"];

export const civFill = (civs: string[]): string => {
  const list = civs.length ? civs : ["無色"];
  if (list.length === 1) return CIV_COLOR[list[0]!] ?? CIV_COLOR["無色"]!;
  return `linear-gradient(135deg, ${list.map((c) => CIV_COLOR[c] ?? CIV_COLOR["無色"]).join(", ")})`;
};
