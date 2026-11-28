/**
 * Card definition used by the simulator. Independent of the card DB: one conversion function
 * (fromCardItem) connects them, so the engine can also run with made-up cards in tests.
 * Phase 1 supports vanilla creatures only (`abilities` is empty).
 */
export type Civ = "光" | "水" | "闇" | "火" | "自然";
export const CIVS: Civ[] = ["光", "水", "闇", "火", "自然"];

export interface SimCard {
  id: string; // stable id (DB card id, or a test id)
  name: string;
  civs: Civ[]; // empty = 無色 (no civ needed to pay)
  cost: number;
  power: number;
  type: "creature";
  abilities: string[]; // Phase 1: always empty (the abilities text, kept for later phases)
}

export const isCiv = (c: string): c is Civ => (CIVS as string[]).includes(c);

/** Minimal shape of a search result / card DB item needed here. */
export interface CardItemLike {
  id: number;
  name: string;
  civs: string[];
  minCost: number | null;
  faces: { type: string; power: number | null; abilities: string[] }[];
}

export class UnsupportedCardError extends Error {}

/** DB card → SimCard. Throws for cards Phase 1 cannot play (non-creatures, cards with abilities unless allowed). */
export function fromCardItem(c: CardItemLike, opts: { ignoreAbilities?: boolean } = {}): SimCard {
  const f = c.faces[0];
  if (!f || c.faces.length !== 1 || !/クリーチャー/.test(f.type) || /進化/.test(f.type))
    throw new UnsupportedCardError(`《${c.name}》は Phase 1 では使えません（通常のクリーチャーのみ）`);
  if (f.abilities.length > 0 && !opts.ignoreAbilities) throw new UnsupportedCardError(`《${c.name}》は能力を持つため Phase 1 では使えません`);
  if (c.minCost === null || f.power === null) throw new UnsupportedCardError(`《${c.name}》はコストかパワーが不明です`);
  return {
    id: String(c.id),
    name: c.name,
    civs: c.civs.filter(isCiv),
    cost: c.minCost,
    power: f.power,
    type: "creature",
    abilities: opts.ignoreAbilities ? [] : f.abilities,
  };
}
