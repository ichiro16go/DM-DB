import { cardOf, other, type GameState, type ManaSlot } from "./state.js";
import type { SimCard } from "./cards.js";

/** Everything a player can decide. `target` "player" = attack the opponent directly. */
export type Action =
  | { type: "charge"; iid: number }
  | { type: "skipCharge" }
  | { type: "summon"; iid: number; mana?: number[] }
  | { type: "endMain" }
  | { type: "attack"; attacker: number; target: "player" | number }
  | { type: "endAttack" }
  | { type: "breakShield"; index: number };

/**
 * Choose untapped mana to pay for `card`: `cost` cards, with at least one card of each of the
 * card's civilizations. Returns the mana iids, or null if it cannot be paid.
 * Civ requirements are matched with backtracking (a multi-colored mana card covers one civ);
 * the rest is filled with the cards least useful for paying other civs later.
 */
export function planPayment(s: GameState, mana: ManaSlot[], card: SimCard): number[] | null {
  const free = mana.filter((m) => !m.tapped).map((m) => ({ iid: m.iid, civs: cardOf(s, m.iid).civs as string[] }));
  if (free.length < card.cost) return null;
  const need = [...new Set(card.civs)];
  const used = new Set<number>();
  // Prefer mana cards with fewer civilizations for requirements (keep flexible ones).
  const byFlex = [...free].sort((a, b) => a.civs.length - b.civs.length);
  const assign = (i: number): boolean => {
    if (i === need.length) return true;
    for (const m of byFlex) {
      if (used.has(m.iid) || !m.civs.includes(need[i]!)) continue;
      used.add(m.iid);
      if (assign(i + 1)) return true;
      used.delete(m.iid);
    }
    return false;
  };
  if (need.length > card.cost || !assign(0)) return null;
  // Fill the remaining cost: tap the civs we have most of first.
  const civCount = new Map<string, number>();
  for (const m of free) for (const c of m.civs) civCount.set(c, (civCount.get(c) ?? 0) + 1);
  const score = (civs: string[]) => (civs.length === 0 ? Infinity : Math.min(...civs.map((c) => civCount.get(c) ?? 0)));
  const rest = free.filter((m) => !used.has(m.iid)).sort((a, b) => score(b.civs) - score(a.civs) || a.iid - b.iid);
  for (const m of rest) {
    if (used.size >= card.cost) break;
    used.add(m.iid);
  }
  return used.size === card.cost ? [...used] : null;
}

/** Is `mana` (explicit iids) a valid payment for `card`? */
export function validPayment(s: GameState, slots: ManaSlot[], card: SimCard, mana: number[]): boolean {
  if (new Set(mana).size !== mana.length || mana.length !== card.cost) return false;
  const chosen = mana.map((iid) => slots.find((m) => m.iid === iid));
  if (chosen.some((m) => !m || m.tapped)) return false;
  return planPayment(s, chosen as ManaSlot[], card) !== null;
}

export const canAttack = (s: GameState, enteredTurn: number, tapped: boolean) => !tapped && enteredTurn < s.turn;

/**
 * Legal actions for the active player. Never empty while the game is running (every phase has a
 * way to move on). Identical cards in hand are listed once (same card id → same outcome).
 */
export function legalActions(s: GameState): Action[] {
  const me = s.players[s.active];
  const opp = s.players[other(s.active)];
  const sameCardOnce = (iids: number[]) => {
    const seen = new Set<string>();
    return iids.filter((iid) => {
      const id = cardOf(s, iid).id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };
  switch (s.phase) {
    case "charge":
      return [...sameCardOnce(me.hand).map((iid): Action => ({ type: "charge", iid })), { type: "skipCharge" }];
    case "main":
      return [
        ...sameCardOnce(me.hand)
          .filter((iid) => planPayment(s, me.mana, cardOf(s, iid)) !== null)
          .map((iid): Action => ({ type: "summon", iid })),
        { type: "endMain" },
      ];
    case "attack": {
      const out: Action[] = [];
      for (const c of me.battle) {
        if (!canAttack(s, c.enteredTurn, c.tapped)) continue;
        out.push({ type: "attack", attacker: c.iid, target: "player" });
        for (const t of opp.battle) if (t.tapped) out.push({ type: "attack", attacker: c.iid, target: t.iid });
      }
      out.push({ type: "endAttack" });
      return out;
    }
    case "breakShield":
      return opp.shields.map((_, index): Action => ({ type: "breakShield", index }));
    case "over":
      return [];
  }
}

export const sameAction = (a: Action, b: Action) => JSON.stringify(a) === JSON.stringify(b);
