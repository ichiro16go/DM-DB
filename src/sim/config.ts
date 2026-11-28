/**
 * Rule parameters of the simulator. Every number of the game lives here so it can be tuned
 * without touching the engine (see docs/sim-design.md).
 */
export interface SimConfig {
  deckSize: number;
  shields: number;
  initialHand: number;
  /** the player going first does not draw on their first turn */
  firstPlayerSkipsFirstDraw: boolean;
  /** cards a player may put into mana per turn */
  chargesPerTurn: number;
  /** multi-colored cards enter the mana zone tapped */
  multicolorManaTapped: boolean;
  /** a player whose deck becomes empty loses (checked whenever the deck shrinks) */
  deckOutLoses: boolean;
  /** shields broken by one attack (Phase 1: no breakers, always 1) */
  breaksPerAttack: number;
  /** the game is a draw after this many turns (both players' turns counted) */
  maxTurns: number;
  /** copies of one card allowed in a deck */
  maxCopies: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  deckSize: 40,
  shields: 5,
  initialHand: 5,
  firstPlayerSkipsFirstDraw: true,
  chargesPerTurn: 1,
  multicolorManaTapped: true,
  deckOutLoses: true,
  breaksPerAttack: 1,
  maxTurns: 100,
  maxCopies: 4,
};
