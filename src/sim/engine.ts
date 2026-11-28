/**
 * Duel Masters rules engine, Phase 1 (vanilla creatures). Pure: no I/O, no clock, randomness only
 * from the seeded Rng. A game = newGame() then step(action) until phase "over"; every change is
 * reported as an Event (the game record).
 *
 * Turn: untap → draw → charge (optional) → main (summon) → attack → end.
 */
import { planPayment, validPayment, type Action, canAttack } from "./actions.js";
import type { SimCard } from "./cards.js";
import { DEFAULT_CONFIG, type SimConfig } from "./config.js";
import { Rng } from "./rng.js";
import { cardOf, other, type EndReason, type GameState, type Instance, type PlayerId, type PlayerState } from "./state.js";

export type Event =
  | { t: "start"; first: PlayerId }
  | { t: "turn"; turn: number; player: PlayerId }
  | { t: "draw"; player: PlayerId; iid: number }
  | { t: "charge"; player: PlayerId; iid: number; tapped: boolean }
  | { t: "summon"; player: PlayerId; iid: number; mana: number[] }
  | { t: "attack"; player: PlayerId; attacker: number; target: "player" | number }
  | { t: "battle"; attacker: number; defender: number; attackerPower: number; defenderPower: number; destroyed: number[] }
  | { t: "break"; player: PlayerId; iid: number; index: number; shieldsLeft: number }
  | { t: "pass"; player: PlayerId; phase: "charge" | "main" | "attack" }
  | { t: "end"; winner: PlayerId | null; reason: EndReason };

export class IllegalActionError extends Error {}

export interface NewGameOptions {
  decks: [SimCard[], SimCard[]];
  seed: number;
  config?: Partial<SimConfig>;
  /** force who goes first (default: random from the seed) */
  first?: PlayerId;
}

const emptyPlayer = (): PlayerState => ({ deck: [], hand: [], mana: [], battle: [], shields: [], graveyard: [], chargesThisTurn: 0 });

export class Game {
  readonly state: GameState;
  readonly events: Event[] = [];
  readonly rng: Rng;

  constructor(opts: NewGameOptions) {
    const config = { ...DEFAULT_CONFIG, ...opts.config };
    for (const [i, d] of opts.decks.entries()) if (d.length !== config.deckSize) throw new Error(`deck ${i} has ${d.length} cards (needs ${config.deckSize})`);
    this.rng = new Rng(opts.seed);
    const instances: Instance[] = [];
    const players: [PlayerState, PlayerState] = [emptyPlayer(), emptyPlayer()];
    opts.decks.forEach((deck, p) => {
      for (const card of deck) {
        instances.push({ iid: instances.length, card, owner: p as PlayerId });
        players[p]!.deck.push(instances.length - 1);
      }
      this.rng.shuffle(players[p]!.deck);
    });
    const first: PlayerId = opts.first ?? (this.rng.int(2) as PlayerId);
    this.state = { config, instances, players, first, turn: 0, active: first, phase: "charge", pendingBreak: null, winner: null, endReason: null };
    for (const p of [0, 1] as PlayerId[]) {
      const pl = players[p];
      pl.shields = pl.deck.splice(0, config.shields);
      pl.hand = pl.deck.splice(0, config.initialHand);
    }
    this.emit({ t: "start", first });
    this.beginTurn(first);
  }

  get over() {
    return this.state.phase === "over";
  }

  private emit(e: Event) {
    this.events.push(e);
  }

  private finish(winner: PlayerId | null, reason: EndReason) {
    if (this.over) return;
    this.state.phase = "over";
    this.state.winner = winner;
    this.state.endReason = reason;
    this.emit({ t: "end", winner, reason });
  }

  /** Deck-out: a player whose deck is empty loses (checked after anything that shrinks a deck). */
  private checkDeckOut(p: PlayerId) {
    if (this.state.config.deckOutLoses && this.state.players[p].deck.length === 0) this.finish(other(p), "deckOut");
  }

  private draw(p: PlayerId) {
    const pl = this.state.players[p];
    const iid = pl.deck.shift();
    if (iid === undefined) return;
    pl.hand.push(iid);
    this.emit({ t: "draw", player: p, iid });
    this.checkDeckOut(p);
  }

  private beginTurn(p: PlayerId) {
    const s = this.state;
    s.turn += 1;
    if (s.turn > s.config.maxTurns) return this.finish(null, "turnLimit");
    s.active = p;
    s.phase = "charge";
    s.pendingBreak = null;
    const pl = s.players[p];
    pl.chargesThisTurn = 0;
    this.emit({ t: "turn", turn: s.turn, player: p });
    for (const m of pl.mana) m.tapped = false;
    for (const c of pl.battle) c.tapped = false;
    const skipDraw = s.config.firstPlayerSkipsFirstDraw && s.turn === 1;
    if (!skipDraw) this.draw(p);
    if (!this.over && pl.hand.length === 0) s.phase = "main"; // nothing to charge
  }

  private destroy(iid: number) {
    const owner = this.state.instances[iid]!.owner;
    const pl = this.state.players[owner];
    const i = pl.battle.findIndex((c) => c.iid === iid);
    if (i >= 0) {
      pl.battle.splice(i, 1);
      pl.graveyard.push(iid);
    }
  }

  /** Apply the active player's action. Throws IllegalActionError for anything not allowed now. */
  step(a: Action): void {
    const s = this.state;
    if (this.over) throw new IllegalActionError("game is over");
    const p = s.active;
    const me = s.players[p];
    const opp = s.players[other(p)];
    const bad = (msg: string): never => {
      throw new IllegalActionError(`${msg} (phase ${s.phase}, action ${JSON.stringify(a)})`);
    };

    switch (a.type) {
      case "charge": {
        if (s.phase !== "charge") bad("not in charge phase");
        const i = me.hand.indexOf(a.iid);
        if (i < 0) bad("card not in hand");
        me.hand.splice(i, 1);
        const tapped = s.config.multicolorManaTapped && cardOf(s, a.iid).civs.length > 1;
        me.mana.push({ iid: a.iid, tapped });
        me.chargesThisTurn += 1;
        this.emit({ t: "charge", player: p, iid: a.iid, tapped });
        if (me.chargesThisTurn >= s.config.chargesPerTurn || me.hand.length === 0) s.phase = "main";
        return;
      }
      case "skipCharge":
        if (s.phase !== "charge") bad("not in charge phase");
        this.emit({ t: "pass", player: p, phase: "charge" });
        s.phase = "main";
        return;
      case "summon": {
        if (s.phase !== "main") bad("not in main phase");
        const i = me.hand.indexOf(a.iid);
        if (i < 0) bad("card not in hand");
        const card = cardOf(s, a.iid);
        const mana = a.mana ?? planPayment(s, me.mana, card);
        if (!mana || !validPayment(s, me.mana, card, mana)) bad(`cannot pay for ${card.name}`);
        for (const m of me.mana) if (mana!.includes(m.iid)) m.tapped = true;
        me.hand.splice(i, 1);
        me.battle.push({ iid: a.iid, tapped: false, enteredTurn: s.turn });
        this.emit({ t: "summon", player: p, iid: a.iid, mana: mana! });
        return;
      }
      case "endMain":
        if (s.phase !== "main") bad("not in main phase");
        this.emit({ t: "pass", player: p, phase: "main" });
        s.phase = "attack";
        return;
      case "attack": {
        if (s.phase !== "attack") bad("not in attack phase");
        const atk = me.battle.find((c) => c.iid === a.attacker);
        if (!atk || !canAttack(s, atk.enteredTurn, atk.tapped)) bad("creature cannot attack");
        if (a.target !== "player") {
          const def = opp.battle.find((c) => c.iid === a.target);
          if (!def || !def.tapped) bad("can only attack a tapped creature");
        }
        atk!.tapped = true;
        this.emit({ t: "attack", player: p, attacker: a.attacker, target: a.target });
        if (a.target === "player") {
          if (opp.shields.length === 0) return this.finish(p, "directAttack");
          s.pendingBreak = { attacker: a.attacker, remaining: Math.min(s.config.breaksPerAttack, opp.shields.length) };
          s.phase = "breakShield";
          return;
        }
        // Battle: the lower power is destroyed; equal power destroys both.
        const ap = cardOf(s, a.attacker).power;
        const dp = cardOf(s, a.target).power;
        const destroyed = ap > dp ? [a.target] : ap < dp ? [a.attacker] : [a.attacker, a.target];
        for (const iid of destroyed) this.destroy(iid);
        this.emit({ t: "battle", attacker: a.attacker, defender: a.target, attackerPower: ap, defenderPower: dp, destroyed });
        return;
      }
      case "endAttack":
        if (s.phase !== "attack") bad("not in attack phase");
        this.emit({ t: "pass", player: p, phase: "attack" });
        return this.beginTurn(other(p));
      case "breakShield": {
        if (s.phase !== "breakShield" || !s.pendingBreak) bad("no shield to break");
        if (!Number.isInteger(a.index) || a.index < 0 || a.index >= opp.shields.length) bad("no such shield");
        const [iid] = opp.shields.splice(a.index, 1);
        opp.hand.push(iid!);
        this.emit({ t: "break", player: p, iid: iid!, index: a.index, shieldsLeft: opp.shields.length });
        s.pendingBreak!.remaining -= 1;
        if (s.pendingBreak!.remaining <= 0 || opp.shields.length === 0) {
          s.pendingBreak = null;
          s.phase = "attack";
        }
        return;
      }
    }
  }
}
