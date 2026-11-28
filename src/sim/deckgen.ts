/**
 * Build a deck from a card pool (normally the DB's vanilla creatures) by civilization and cost curve.
 * Deterministic for a given seed. The resulting card list is stored with each game, so old games
 * replay even after the DB changes.
 */
import type { Civ, SimCard } from "./cards.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { Rng } from "./rng.js";

/** cost → number of cards. Costs not in the pool spill over to the nearest cost that has cards. */
export type Curve = Record<number, number>;
export const DEFAULT_CURVE: Curve = { 2: 8, 3: 10, 4: 8, 5: 8, 6: 6 };

export interface DeckSpec {
  civs: Civ[];
  curve?: Curve;
  size?: number;
  maxCopies?: number;
}

export class DeckGenError extends Error {}

export function generateDeck(pool: SimCard[], spec: DeckSpec, rng: Rng): SimCard[] {
  const size = spec.size ?? DEFAULT_CONFIG.deckSize;
  const maxCopies = spec.maxCopies ?? DEFAULT_CONFIG.maxCopies;
  const curve = spec.curve ?? DEFAULT_CURVE;
  // single-civ cards of the chosen civs (multi-colored only if all its civs are chosen)
  const cands = pool.filter((c) => c.civs.length > 0 && c.civs.every((x) => spec.civs.includes(x)));
  if (cands.length * maxCopies < size) throw new DeckGenError(`カードが足りません（${spec.civs.join("/")}：${cands.length}種）`);
  const byCost = new Map<number, SimCard[]>();
  for (const c of cands) byCost.set(c.cost, [...(byCost.get(c.cost) ?? []), c]);
  const costs = [...byCost.keys()].sort((a, b) => a - b);
  const copies = new Map<string, number>();
  const deck: SimCard[] = [];
  const take = (cost: number): boolean => {
    // nearest cost (ties → cheaper) that still has a card with copies left
    const order = [...costs].sort((a, b) => Math.abs(a - cost) - Math.abs(b - cost) || a - b);
    for (const k of order) {
      const avail = byCost.get(k)!.filter((c) => (copies.get(c.id) ?? 0) < maxCopies);
      if (avail.length === 0) continue;
      // prefer the strongest cards of that cost, with some variety
      avail.sort((a, b) => b.power - a.power || a.id.localeCompare(b.id));
      const top = avail.slice(0, Math.max(1, Math.ceil(avail.length / 2)));
      const card = rng.pick(top);
      copies.set(card.id, (copies.get(card.id) ?? 0) + 1);
      deck.push(card);
      return true;
    }
    return false;
  };
  const wanted = Object.entries(curve).flatMap(([cost, n]) => Array<number>(n).fill(Number(cost)));
  while (wanted.length < size) wanted.push(wanted[wanted.length - 1] ?? 3);
  for (const cost of wanted.slice(0, size)) if (!take(cost)) throw new DeckGenError("デッキを組めません");
  // group copies for readability: by cost, then name
  return deck.sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name, "ja"));
}

/** "火" / "火,自然" / "火自然" → civs */
export function parseCivs(s: string): Civ[] {
  const out: Civ[] = [];
  for (const c of ["自然", "光", "水", "闇", "火"] as Civ[]) if (s.includes(c)) out.push(c);
  if (out.length === 0) throw new DeckGenError(`文明を指定してください（光・水・闇・火・自然）: ${s}`);
  return out;
}
