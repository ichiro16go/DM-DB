/**
 * Play games between agents and collect the records. A record holds everything needed to replay
 * the game exactly: config, seed, both decks, who went first and the list of actions.
 */
import { legalActions, sameAction, type Action } from "./actions.js";
import type { Agent } from "./agents/agent.js";
import type { SimCard } from "./cards.js";
import { DEFAULT_CONFIG, type SimConfig } from "./config.js";
import { Game, type Event } from "./engine.js";
import { Rng } from "./rng.js";
import { cardCount, type EndReason, type PlayerId } from "./state.js";
import { observe } from "./view.js";

export interface GameRecord {
  version: 1;
  config: SimConfig;
  seed: number;
  decks: [SimCard[], SimCard[]];
  agents: [string, string];
  first: PlayerId;
  winner: PlayerId | null;
  reason: EndReason;
  turns: number;
  actions: { player: PlayerId; action: Action }[];
  events: Event[];
}

export class SimError extends Error {}

/** Guard against an agent that never ends its turn. */
const MAX_ACTIONS = 20_000;

export function playGame(opts: {
  decks: [SimCard[], SimCard[]];
  agents: [Agent, Agent];
  seed: number;
  config?: Partial<SimConfig>;
  first?: PlayerId;
  check?: boolean;
}): GameRecord {
  const config = { ...DEFAULT_CONFIG, ...opts.config };
  const game = new Game({ decks: opts.decks, seed: opts.seed, config, first: opts.first });
  const agentRng: [Rng, Rng] = [new Rng(opts.seed).fork(1), new Rng(opts.seed).fork(2)];
  const actions: GameRecord["actions"] = [];
  while (!game.over) {
    if (actions.length >= MAX_ACTIONS) throw new SimError(`too many actions (> ${MAX_ACTIONS})`);
    const p = game.state.active;
    const legal = legalActions(game.state);
    if (legal.length === 0) throw new SimError(`no legal action in phase ${game.state.phase}`);
    const action = opts.agents[p].choose(observe(game.state, p), legal, agentRng[p]);
    if (!legal.some((a) => sameAction(a, action)) && !(action.type === "charge" || action.type === "summon"))
      throw new SimError(`agent ${opts.agents[p].name} chose an illegal action ${JSON.stringify(action)}`);
    game.step(action);
    actions.push({ player: p, action });
    if (opts.check) for (const pl of game.state.players) if (cardCount(pl) !== config.deckSize) throw new SimError("card count changed");
  }
  return {
    version: 1,
    config,
    seed: opts.seed,
    decks: opts.decks,
    agents: [opts.agents[0].name, opts.agents[1].name],
    first: game.state.first,
    winner: game.state.winner,
    reason: game.state.endReason!,
    turns: game.state.turn,
    actions,
    events: game.events,
  };
}

/** Re-run a record's actions through the engine; returns the events (equal to record.events for a valid record). */
export function replay(r: GameRecord): Event[] {
  const game = new Game({ decks: r.decks, seed: r.seed, config: r.config, first: r.first });
  for (const { action } of r.actions) game.step(action);
  return game.events;
}

export interface Summary {
  games: number;
  agents: [string, string];
  wins: [number, number];
  draws: number;
  firstPlayerWins: number;
  secondPlayerWins: number;
  avgTurns: number;
  reasons: Record<EndReason, number>;
}

export function summarize(records: GameRecord[]): Summary {
  const s: Summary = {
    games: records.length,
    agents: records[0]?.agents ?? ["", ""],
    wins: [0, 0],
    draws: 0,
    firstPlayerWins: 0,
    secondPlayerWins: 0,
    avgTurns: 0,
    reasons: { directAttack: 0, deckOut: 0, turnLimit: 0 },
  };
  for (const r of records) {
    s.reasons[r.reason] += 1;
    s.avgTurns += r.turns / Math.max(1, records.length);
    if (r.winner === null) s.draws += 1;
    else {
      s.wins[r.winner] += 1;
      if (r.winner === r.first) s.firstPlayerWins += 1;
      else s.secondPlayerWins += 1;
    }
  }
  s.avgTurns = Math.round(s.avgTurns * 10) / 10;
  return s;
}
