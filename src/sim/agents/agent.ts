import type { Action } from "../actions.js";
import type { Rng } from "../rng.js";
import type { PlayerView } from "../view.js";

/**
 * A player. Gets only its own view of the game and the legal actions, returns one of them.
 * New agents (search-based, Claude …) implement this same interface.
 */
export interface Agent {
  readonly name: string;
  choose(view: PlayerView, legal: Action[], rng: Rng): Action;
}
