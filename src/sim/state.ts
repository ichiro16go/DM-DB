import type { SimCard } from "./cards.js";
import type { SimConfig } from "./config.js";

export type PlayerId = 0 | 1;
export const other = (p: PlayerId): PlayerId => (p === 0 ? 1 : 0);

/** One physical card in this game (four copies of a card are four instances). */
export interface Instance {
  iid: number;
  card: SimCard;
  owner: PlayerId;
}

export interface ManaSlot {
  iid: number;
  tapped: boolean;
}

export interface Creature {
  iid: number;
  tapped: boolean;
  /** game turn it entered the battle zone (summoning sickness while it equals the current turn) */
  enteredTurn: number;
}

export interface PlayerState {
  deck: number[]; // iids, index 0 = top
  hand: number[];
  mana: ManaSlot[];
  battle: Creature[];
  shields: number[]; // face down; index = position
  graveyard: number[];
  chargesThisTurn: number;
}

export type Phase = "charge" | "main" | "attack" | "breakShield" | "over";
export type EndReason = "directAttack" | "deckOut" | "turnLimit";

export interface GameState {
  config: SimConfig;
  instances: Instance[]; // by iid
  players: [PlayerState, PlayerState];
  first: PlayerId;
  turn: number; // 1 = first player's first turn
  active: PlayerId;
  phase: Phase;
  /** set while the attacking player chooses which shield(s) to break */
  pendingBreak: { attacker: number; remaining: number } | null;
  winner: PlayerId | null; // null with phase "over" = draw
  endReason: EndReason | null;
}

export const cardOf = (s: GameState, iid: number): SimCard => s.instances[iid]!.card;
export const activePlayer = (s: GameState) => s.players[s.active];

export const cloneState = (s: GameState): GameState => structuredClone(s);

/** Total cards a player owns across all zones (invariant: always the deck size). */
export const cardCount = (p: PlayerState) => p.deck.length + p.hand.length + p.mana.length + p.battle.length + p.shields.length + p.graveyard.length;
