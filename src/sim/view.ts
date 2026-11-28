/**
 * What one player can see — the same information a human player has: own hand, both battle
 * zones, both mana zones and graveyards; for hidden zones only the number of cards.
 * Agents receive only this, so their strength can be compared fairly.
 */
import type { SimCard } from "./cards.js";
import { cardOf, other, type GameState, type Phase, type PlayerId } from "./state.js";

export interface SeenCard {
  iid: number;
  card: SimCard;
}
export interface SeenCreature extends SeenCard {
  tapped: boolean;
  sick: boolean; // entered this turn (cannot attack yet)
}
export interface SeenMana extends SeenCard {
  tapped: boolean;
}
export interface SidePublic {
  battle: SeenCreature[];
  mana: SeenMana[];
  graveyard: SeenCard[];
  handCount: number;
  deckCount: number;
  shieldCount: number;
}
export interface PlayerView {
  me: PlayerId;
  turn: number;
  myTurn: boolean;
  phase: Phase;
  hand: SeenCard[];
  self: SidePublic;
  opponent: SidePublic;
  chargesLeft: number;
}

export function observe(s: GameState, me: PlayerId): PlayerView {
  const side = (p: PlayerId): SidePublic => {
    const pl = s.players[p];
    return {
      battle: pl.battle.map((c) => ({ iid: c.iid, card: cardOf(s, c.iid), tapped: c.tapped, sick: c.enteredTurn >= s.turn })),
      mana: pl.mana.map((m) => ({ iid: m.iid, card: cardOf(s, m.iid), tapped: m.tapped })),
      graveyard: pl.graveyard.map((iid) => ({ iid, card: cardOf(s, iid) })),
      handCount: pl.hand.length,
      deckCount: pl.deck.length,
      shieldCount: pl.shields.length,
    };
  };
  return {
    me,
    turn: s.turn,
    myTurn: s.active === me,
    phase: s.phase,
    hand: s.players[me].hand.map((iid) => ({ iid, card: cardOf(s, iid) })),
    self: side(me),
    opponent: side(other(me)),
    chargesLeft: s.active === me ? Math.max(0, s.config.chargesPerTurn - s.players[me].chargesThisTurn) : 0,
  };
}
