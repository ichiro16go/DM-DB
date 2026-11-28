/**
 * Rule-based ("定石") agent for vanilla games. Each decision is a short rule list; the thresholds
 * are parameters (GreedyParams) so the play style can be tuned without changing code.
 */
import type { Action } from "../actions.js";
import type { SimCard } from "../cards.js";
import type { PlayerView, SeenCard, SeenCreature } from "../view.js";
import type { Agent } from "./agent.js";

export interface GreedyParams {
  /** keep charging every turn until this many mana cards */
  chargeUntil: number;
  /** above chargeUntil, still charge when the hand has at least this many cards */
  chargeIfHandAtLeast: number;
  /** trade (equal power, both destroyed) only if the target costs at least this much more */
  tradeCostMargin: number;
  /** attack the player even if the attacker can then be destroyed, when the opponent has at most this many shields */
  aggressiveAtShields: number;
}

export const DEFAULT_GREEDY: GreedyParams = { chargeUntil: 6, chargeIfHandAtLeast: 4, tradeCostMargin: 1, aggressiveAtShields: 2 };

const civsIn = (cards: SimCard[]) => new Set(cards.flatMap((c) => c.civs));

/** Which hand card to put into mana: one whose civ the mana lacks (and the hand needs), else the least castable soon. */
function chooseCharge(view: PlayerView, candidates: SeenCard[]): SeenCard {
  const manaCivs = civsIn(view.self.mana.map((m) => m.card));
  const manaSize = view.self.mana.length + 1;
  const missing = candidates.filter((c) => c.card.civs.some((x) => !manaCivs.has(x)));
  if (missing.length > 0 && view.self.mana.length < 3) return missing.sort((a, b) => b.card.cost - a.card.cost)[0]!;
  // furthest from castable first; then the weakest
  return [...candidates].sort((a, b) => b.card.cost - manaSize - (a.card.cost - manaSize) || a.card.power - b.card.power || a.iid - b.iid)[0]!;
}

/** Creatures that may attack `mine` on the opponent's next turn (all of theirs untap). */
const threats = (view: PlayerView) => view.opponent.battle;

export function greedyAgent(params: Partial<GreedyParams> = {}): Agent {
  const p = { ...DEFAULT_GREEDY, ...params };
  return {
    name: "greedy",
    choose(view, legal) {
      const has = (t: Action["type"]) => legal.find((a) => a.type === t);
      switch (view.phase) {
        case "charge": {
          const charges = legal.filter((a): a is Extract<Action, { type: "charge" }> => a.type === "charge");
          const want = view.self.mana.length < p.chargeUntil || view.hand.length >= p.chargeIfHandAtLeast;
          if (!want || charges.length === 0) return has("skipCharge")!;
          const cands = view.hand.filter((h) => charges.some((c) => c.iid === h.iid));
          const pick = chooseCharge(view, cands);
          return { type: "charge", iid: pick.iid };
        }
        case "main": {
          const summons = legal.filter((a): a is Extract<Action, { type: "summon" }> => a.type === "summon");
          if (summons.length === 0) return has("endMain")!;
          const card = (iid: number) => view.hand.find((h) => h.iid === iid)!.card;
          // the most expensive castable creature, then the strongest
          return summons.sort((a, b) => card(b.iid).cost - card(a.iid).cost || card(b.iid).power - card(a.iid).power)[0]!;
        }
        case "attack": {
          const attacks = legal.filter((a): a is Extract<Action, { type: "attack" }> => a.type === "attack");
          if (attacks.length === 0) return has("endAttack")!;
          const mine = (iid: number) => view.self.battle.find((c) => c.iid === iid)!;
          const theirs = (iid: number) => view.opponent.battle.find((c) => c.iid === iid)!;
          // 1. finish the game
          if (view.opponent.shieldCount === 0) {
            const lethal = attacks.find((a) => a.target === "player");
            if (lethal) return lethal;
          }
          // 2. destroy a tapped creature we beat outright (most valuable first)
          const kills = attacks
            .filter((a) => a.target !== "player" && mine(a.attacker).card.power > theirs(a.target as number).card.power)
            .sort((a, b) => theirs(b.target as number).card.cost - theirs(a.target as number).card.cost);
          if (kills.length > 0) {
            // use the weakest attacker that still wins
            const target = kills[0]!.target;
            return kills.filter((a) => a.target === target).sort((a, b) => mine(a.attacker).card.power - mine(b.attacker).card.power)[0]!;
          }
          // 3. trade into a clearly more expensive creature
          const trade = attacks.find((a) => {
            if (a.target === "player") return false;
            const t = theirs(a.target);
            return mine(a.attacker).card.power === t.card.power && t.card.cost - mine(a.attacker).card.cost >= p.tradeCostMargin;
          });
          if (trade) return trade;
          // 4. break shields with attackers that are safe from a counter-attack (or when racing)
          const safe = (c: SeenCreature) => threats(view).every((t) => t.card.power <= c.card.power);
          const face = attacks
            .filter((a) => a.target === "player")
            .filter((a) => safe(mine(a.attacker)) || view.opponent.shieldCount <= p.aggressiveAtShields)
            .sort((a, b) => mine(b.attacker).card.power - mine(a.attacker).card.power);
          if (face.length > 0) return face[0]!;
          return has("endAttack")!;
        }
        case "breakShield":
          return legal[0]!;
        default:
          return legal[0]!;
      }
    },
  };
}
