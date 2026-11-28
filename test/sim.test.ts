import { describe, expect, it } from "vitest";
import { legalActions, planPayment, type Action } from "../src/sim/actions.js";
import { greedyAgent } from "../src/sim/agents/greedy.js";
import { randomAgent } from "../src/sim/agents/random.js";
import { fromCardItem, UnsupportedCardError, type Civ, type SimCard } from "../src/sim/cards.js";
import { generateDeck } from "../src/sim/deckgen.js";
import { Game, IllegalActionError } from "../src/sim/engine.js";
import { recordToText } from "../src/sim/log.js";
import { Rng, seedOf } from "../src/sim/rng.js";
import { playGame, replay, summarize } from "../src/sim/runner.js";
import { cardCount, type PlayerId } from "../src/sim/state.js";

const card = (id: string, civs: Civ[], cost: number, power: number): SimCard => ({
  id,
  name: `カード${id}`,
  civs,
  cost,
  power,
  type: "creature",
  abilities: [],
});
const deckOf = (c: SimCard, n = 40) => Array.from({ length: n }, () => c);
const FIRE2 = card("f2", ["火"], 2, 2000);

/** A game where both players hold only `c`, player 0 first. */
const newGame = (c = FIRE2, opts: { first?: PlayerId; config?: object; d1?: SimCard[] } = {}) =>
  new Game({ decks: [deckOf(c), opts.d1 ?? deckOf(c)], seed: 1, first: opts.first ?? 0, config: opts.config });

const types = (as: Action[]) => as.map((a) => a.type);

describe("setup and turn structure", () => {
  it("deals 5 shields and 5 cards; the first player does not draw on turn 1", () => {
    const g = newGame();
    const [a, b] = g.state.players;
    expect([a.shields.length, a.hand.length, a.deck.length]).toEqual([5, 5, 30]);
    expect([b.shields.length, b.hand.length, b.deck.length]).toEqual([5, 5, 30]);
    expect(g.events.some((e) => e.t === "draw")).toBe(false);
    g.step({ type: "skipCharge" });
    g.step({ type: "endMain" });
    g.step({ type: "endAttack" });
    expect(g.state.active).toBe(1);
    expect(b.hand.length).toBe(6); // the second player draws on their first turn
  });

  it("allows one mana charge per turn and untaps at the start of the turn", () => {
    const g = newGame();
    const me = g.state.players[0];
    g.step({ type: "charge", iid: me.hand[0]! });
    expect(g.state.phase).toBe("main");
    expect(types(legalActions(g.state))).not.toContain("charge");
    me.mana[0]!.tapped = true;
    g.step({ type: "endMain" });
    g.step({ type: "endAttack" });
    g.step({ type: "skipCharge" });
    g.step({ type: "endMain" });
    g.step({ type: "endAttack" });
    expect(me.mana[0]!.tapped).toBe(false);
  });

  it("puts multi-colored cards into mana tapped", () => {
    const multi = card("m", ["火", "自然"], 3, 3000);
    const g = newGame(multi);
    g.step({ type: "charge", iid: g.state.players[0].hand[0]! });
    expect(g.state.players[0].mana[0]!.tapped).toBe(true);
  });

  it("rejects illegal actions", () => {
    const g = newGame();
    expect(() => g.step({ type: "endAttack" })).toThrow(IllegalActionError);
    expect(() => g.step({ type: "charge", iid: 9999 })).toThrow(IllegalActionError);
  });
});

describe("mana payment", () => {
  it("needs the card's civilization among the tapped mana", () => {
    const water = card("w", ["水"], 2, 2000);
    const g = newGame(FIRE2, { d1: deckOf(water) });
    const s = g.state;
    // player 0 has two water cards in mana (taken from player 1's instances)
    s.players[0].mana = s.players[1].deck.splice(0, 2).map((iid) => ({ iid, tapped: false }));
    expect(planPayment(s, s.players[0].mana, FIRE2)).toBeNull();
    s.players[0].mana.push({ iid: s.players[0].deck.shift()!, tapped: false });
    const pay = planPayment(s, s.players[0].mana, FIRE2)!;
    expect(pay).toHaveLength(2);
    expect(pay.some((iid) => s.instances[iid]!.card.civs.includes("火"))).toBe(true);
  });

  it("matches multi-colored requirements with multi-colored mana", () => {
    const fn = card("fn", ["火", "自然"], 2, 2000);
    const g = newGame(fn);
    const s = g.state;
    s.players[0].mana = s.players[0].deck.splice(0, 2).map((iid) => ({ iid, tapped: false }));
    expect(planPayment(s, s.players[0].mana, fn)).toHaveLength(2);
    expect(planPayment(s, s.players[0].mana.slice(0, 1), fn)).toBeNull();
  });
});

describe("summoning, attacking and battle", () => {
  /** Player 0 to move in the attack phase with the given creatures on each side. */
  const board = (mine: SimCard[], theirs: { c: SimCard; tapped: boolean }[]) => {
    const all = [...mine, ...theirs.map((t) => t.c)];
    const g = new Game({ decks: [deckOf(all[0]!), deckOf(all[0]!)], seed: 3, first: 0 });
    const s = g.state;
    const put = (p: PlayerId, c: SimCard, tapped: boolean) => {
      const iid = s.players[p].deck.shift()!;
      s.instances[iid]!.card = c;
      s.players[p].battle.push({ iid, tapped, enteredTurn: 0 });
      return iid;
    };
    const m = mine.map((c) => put(0, c, false));
    const t = theirs.map((x) => put(1, x.c, x.tapped));
    g.step({ type: "skipCharge" });
    g.step({ type: "endMain" });
    return { g, s, m, t };
  };

  it("summoned creatures cannot attack that turn", () => {
    const g = newGame();
    const s = g.state;
    s.players[0].mana = s.players[0].deck.splice(0, 2).map((iid) => ({ iid, tapped: false }));
    g.step({ type: "skipCharge" });
    g.step({ type: "summon", iid: s.players[0].hand[0]! });
    expect(s.players[0].battle).toHaveLength(1);
    g.step({ type: "endMain" });
    expect(types(legalActions(s))).toEqual(["endAttack"]);
  });

  it("can attack only tapped creatures", () => {
    const { s, m, t } = board(
      [FIRE2],
      [
        { c: FIRE2, tapped: false },
        { c: FIRE2, tapped: true },
      ],
    );
    const targets = legalActions(s).flatMap((a) => (a.type === "attack" ? [a.target] : []));
    expect(targets).toEqual(["player", t[1]]);
    expect(m).toHaveLength(1);
  });

  it("destroys the weaker creature, and both on equal power", () => {
    const big = card("b", ["火"], 3, 3000);
    const { g, s, m, t } = board(
      [big, FIRE2],
      [
        { c: FIRE2, tapped: true },
        { c: FIRE2, tapped: true },
      ],
    );
    g.step({ type: "attack", attacker: m[0]!, target: t[0]! });
    expect(s.players[1].battle.map((c) => c.iid)).toEqual([t[1]]);
    expect(s.players[0].battle).toHaveLength(2);
    g.step({ type: "attack", attacker: m[1]!, target: t[1]! });
    expect(s.players[0].battle.map((c) => c.iid)).toEqual([m[0]]);
    expect(s.players[1].battle).toHaveLength(0);
    expect(s.players[1].graveyard).toHaveLength(2);
  });

  it("breaks a shield into its owner's hand, then wins with a direct attack", () => {
    const { g, s, m } = board([FIRE2, FIRE2], []);
    const opp = s.players[1];
    opp.hand.push(...opp.shields.splice(0, 4)); // one shield left
    const hand = opp.hand.length;
    g.step({ type: "attack", attacker: m[0]!, target: "player" });
    expect(s.phase).toBe("breakShield");
    g.step({ type: "breakShield", index: 0 });
    expect([opp.shields.length, opp.hand.length]).toEqual([0, hand + 1]);
    g.step({ type: "attack", attacker: m[1]!, target: "player" });
    expect([s.phase, s.winner, s.endReason]).toEqual(["over", 0, "directAttack"]);
  });

  it("a player whose deck becomes empty loses", () => {
    const g = new Game({ decks: [deckOf(FIRE2, 12), deckOf(FIRE2, 12)], seed: 1, first: 0, config: { deckSize: 12 } });
    // decks: 2 cards each after 5 shields + 5 hand
    const pass = () => (g.step({ type: "skipCharge" }), g.step({ type: "endMain" }), g.step({ type: "endAttack" }));
    pass(); // T1 player 0 (no draw) → T2 player 1 draws (1 left)
    pass(); // → T3 player 0 draws (1 left)
    pass(); // → T4 player 1 draws the last card → loses
    expect([g.state.winner, g.state.endReason]).toEqual([0, "deckOut"]);
  });

  it("ends in a draw at the turn limit", () => {
    const g = newGame(FIRE2, { config: { maxTurns: 3 } });
    for (let i = 0; i < 3; i++) (g.step({ type: "skipCharge" }), g.step({ type: "endMain" }), g.step({ type: "endAttack" }));
    expect([g.state.phase, g.state.winner, g.state.endReason]).toEqual(["over", null, "turnLimit"]);
  });
});

describe("runner, agents and records", () => {
  // 12 kinds per civ (costs 2–7, two of each): water is a bit weaker so results are not symmetric
  const pool = (["火", "水"] as Civ[]).flatMap((civ) =>
    Array.from({ length: 12 }, (_, i) => {
      const cost = 2 + Math.floor(i / 2);
      return card(`${civ}${i}`, [civ], cost, cost * 1000 + (civ === "火" ? 500 : 0) + (i % 2) * 500);
    }),
  );
  const decks = (rng: Rng): [SimCard[], SimCard[]] => [generateDeck(pool, { civs: ["火"] }, rng), generateDeck(pool, { civs: ["水"] }, rng)];

  it("generates 40-card decks within the copy limit", () => {
    const [d] = decks(new Rng(1));
    expect(d).toHaveLength(40);
    expect(d.every((c) => c.civs[0] === "火")).toBe(true);
    const counts = new Map<string, number>();
    for (const c of d) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(4);
  });

  it("is reproducible: same seed → same game; the record replays to the same events", () => {
    const d = decks(new Rng(5));
    const a = playGame({ decks: d, agents: [greedyAgent(), randomAgent], seed: 42, check: true });
    const b = playGame({ decks: d, agents: [greedyAgent(), randomAgent], seed: 42 });
    expect(b).toEqual(a);
    expect(replay(a)).toEqual(a.events);
    expect(seedOf("abc")).toBe(seedOf("abc"));
  });

  it("random games always finish and keep every card (fuzz)", () => {
    const rng = new Rng(9);
    for (let i = 0; i < 150; i++) {
      const r = playGame({ decks: decks(rng), agents: [randomAgent, randomAgent], seed: rng.int(2 ** 31), check: true });
      expect(r.reason).toBeDefined();
    }
  });

  it("the rule-based agent clearly beats the random agent", () => {
    const rng = new Rng(11);
    const recs = Array.from({ length: 200 }, (_, i) => {
      const [fire, water] = decks(rng);
      // swap decks and seats so neither side has a built-in edge
      const swap = i % 2 === 1;
      return playGame({ decks: swap ? [water, fire] : [fire, water], agents: [greedyAgent(), randomAgent], seed: rng.int(2 ** 31) });
    });
    const s = summarize(recs);
    expect(s.wins[0] / s.games).toBeGreaterThan(0.8);
  });

  it("writes a readable record", () => {
    const r = playGame({ decks: decks(new Rng(2)), agents: [greedyAgent(), greedyAgent()], seed: 7 });
    const text = recordToText(r);
    expect(text).toMatch(/結果: .*(の勝ち|引き分け)/);
    expect(text).toMatch(/T1 [AB]（マナ0・手札5・シールド5・山札30/);
    expect(text).toMatch(/召喚 《カード/);
    for (const pl of [0, 1]) expect(cardCount(new Game({ decks: r.decks, seed: r.seed, first: r.first }).state.players[pl as PlayerId])).toBe(40);
  });

  it("converts DB cards and refuses unsupported ones", () => {
    const base = { id: 1, name: "X", civs: ["火"], minCost: 3, faces: [{ type: "クリーチャー", power: 3000, abilities: [] as string[] }] };
    expect(fromCardItem(base)).toMatchObject({ id: "1", civs: ["火"], cost: 3, power: 3000 });
    expect(() => fromCardItem({ ...base, faces: [{ type: "呪文", power: null, abilities: [] }] })).toThrow(UnsupportedCardError);
    expect(() => fromCardItem({ ...base, faces: [{ type: "クリーチャー", power: 3000, abilities: ["ブロッカー"] }] })).toThrow(UnsupportedCardError);
  });
});
