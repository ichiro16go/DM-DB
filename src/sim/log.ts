/**
 * Human-readable game record (日本語の棋譜). Written from the spectator's view: every card is
 * shown, including draws and broken shields. Built by replaying the record, so each turn header
 * can show the board as it was.
 */
import { Game, type Event } from "./engine.js";
import type { GameRecord } from "./runner.js";
import { cardOf, other, type GameState, type PlayerId } from "./state.js";

const REASON = { directAttack: "とどめ（ダイレクトアタック）", deckOut: "山札切れ", turnLimit: "上限ターン数" } as const;

export function playerLabel(r: GameRecord, p: PlayerId) {
  return `${p === 0 ? "A" : "B"}（${r.agents[p]}・${p === r.first ? "先攻" : "後攻"}）`;
}

function deckLines(r: GameRecord, p: PlayerId): string[] {
  const counts = new Map<string, { name: string; cost: number; power: number; civs: string; n: number }>();
  for (const c of r.decks[p]) {
    const e = counts.get(c.id) ?? { name: c.name, cost: c.cost, power: c.power, civs: c.civs.join("/") || "無色", n: 0 };
    e.n += 1;
    counts.set(c.id, e);
  }
  return [...counts.values()].map((c) => `  ${c.n} 《${c.name}》 ${c.civs} コスト${c.cost} パワー${c.power}`);
}

const civLabel = (civs: string[]) => civs.join("/") || "無色";

/** "火2・水1" — civilizations of the tapped mana cards (a multi-colored card counts for each of its civs). */
function manaLabel(s: GameState, iids: number[]) {
  const n = new Map<string, number>();
  for (const iid of iids) for (const c of cardOf(s, iid).civs.length ? cardOf(s, iid).civs : ["無色"]) n.set(c, (n.get(c) ?? 0) + 1);
  return [...n].map(([c, k]) => `${c}${k}`).join("・");
}

export function recordToText(r: GameRecord): string {
  const out: string[] = [];
  const name = (s: GameState, iid: number) => `《${cardOf(s, iid).name}》`;
  const who = (p: PlayerId) => (p === 0 ? "A" : "B");
  const result = r.winner === null ? `引き分け（${REASON[r.reason]}）` : `${playerLabel(r, r.winner)} の勝ち（${REASON[r.reason]}、${r.turns}ターン）`;
  out.push(`# 対戦記録  seed=${r.seed}`, "", `結果: ${result}`, "");
  for (const p of [0, 1] as PlayerId[]) out.push(`デッキ ${playerLabel(r, p)}`, ...deckLines(r, p), "");
  out.push("## 進行", "");

  const render = (s: GameState, e: Event) => {
    switch (e.t) {
      case "start":
        out.push(`先攻: ${who(e.first)}`);
        return;
      case "turn": {
        const me = s.players[e.player];
        const op = s.players[other(e.player)];
        out.push(
          "",
          `T${e.turn} ${who(e.player)}（マナ${me.mana.length}・手札${me.hand.length}・シールド${me.shields.length}・山札${me.deck.length}／相手 シールド${op.shields.length}・場${op.battle.length}）`,
        );
        return;
      }
      case "draw":
        out.push(`  ドロー ${name(s, e.iid)}`);
        return;
      case "charge":
        out.push(`  マナチャージ ${name(s, e.iid)}${e.tapped ? "（多色のためタップ）" : ""}`);
        return;
      case "summon": {
        const c = cardOf(s, e.iid);
        out.push(`  召喚 ${name(s, e.iid)}（${civLabel(c.civs)}・コスト${c.cost}・パワー${c.power}）← マナ ${manaLabel(s, e.mana)} をタップ`);
        return;
      }
      case "attack":
        out.push(`  攻撃 ${name(s, e.attacker)} → ${e.target === "player" ? "プレイヤー" : name(s, e.target)}`);
        return;
      case "battle": {
        const d = e.destroyed.map((iid) => name(s, iid)).join("と");
        out.push(`    バトル ${e.attackerPower} 対 ${e.defenderPower}：${d} を破壊`);
        return;
      }
      case "break":
        out.push(`    シールドをブレイク：${name(s, e.iid)} が手札へ（残り${e.shieldsLeft}）`);
        return;
      case "pass":
        // Say explicitly when a player chose not to charge (otherwise a quiet turn looks like a bug).
        if (e.phase === "charge") out.push("  マナチャージしない");
        return;
      case "end":
        out.push("", e.winner === null ? `引き分け（${REASON[e.reason]}）` : `${who(e.winner)} の勝ち（${REASON[e.reason]}）`);
        return;
    }
  };

  // Replay, rendering each event with the state right after it happened (turn headers: after untap/draw).
  const game = new Game({ decks: r.decks, seed: r.seed, config: r.config, first: r.first });
  let seen = 0;
  const flush = () => {
    for (; seen < game.events.length; seen++) render(game.state, game.events[seen]!);
  };
  flush();
  for (const { action } of r.actions) {
    game.step(action);
    flush();
  }
  return out.join("\n") + "\n";
}

export function summaryToText(s: import("./runner.js").Summary): string {
  const pct = (n: number) => `${((n / Math.max(1, s.games)) * 100).toFixed(1)}%`;
  return [
    `対戦数: ${s.games}`,
    `A（${s.agents[0]}）勝ち: ${s.wins[0]}（${pct(s.wins[0])}）`,
    `B（${s.agents[1]}）勝ち: ${s.wins[1]}（${pct(s.wins[1])}）`,
    `引き分け: ${s.draws}`,
    `先攻の勝ち: ${s.firstPlayerWins}（${pct(s.firstPlayerWins)}） / 後攻の勝ち: ${s.secondPlayerWins}（${pct(s.secondPlayerWins)}）`,
    `平均ターン数: ${s.avgTurns}`,
    `決着: とどめ ${s.reasons.directAttack} / 山札切れ ${s.reasons.deckOut} / 上限ターン ${s.reasons.turnLimit}`,
  ].join("\n");
}
