/**
 * Run AI vs AI games and write the records.
 *
 *   npm run sim -- [--games=100] [--seed=1] [--deck-a=火] [--deck-b=水] [--agent-a=greedy] [--agent-b=random]
 *                  [--out=data/sim/<time>] [--max-records=20] [--quiet]
 *
 * --deck-a / --deck-b:
 *   火 / 火自然          auto-generated from the DB's vanilla creatures of those civilizations
 *   deck:<id>            a deck saved in the deck editor (only vanilla creatures are allowed in Phase 1)
 * --agent-a / --agent-b: greedy | random
 *
 * Output: summary.json / summary.txt, and game-NNNN.json (replayable) + game-NNNN.txt (棋譜) for
 * the first --max-records games.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { argv } from "node:process";
import { DEFAULT_DB_PATH, DEFAULT_STORE, DATA_DIR } from "../lib/raw.js";
import { openDb, SearchEngine } from "../search/engine.js";
import { CardResolver } from "../meta/decklist.js";
import { DeckStore } from "../decks/store.js";
import { openStore } from "../storage/object-store.js";
import type { Agent } from "./agents/agent.js";
import { greedyAgent } from "./agents/greedy.js";
import { randomAgent } from "./agents/random.js";
import { fromCardItem, type SimCard } from "./cards.js";
import { generateDeck, parseCivs } from "./deckgen.js";
import { recordToText, summaryToText } from "./log.js";
import { Rng, seedOf } from "./rng.js";
import { playGame, summarize, type GameRecord } from "./runner.js";

const arg = (n: string) =>
  argv
    .find((a) => a.startsWith(`--${n}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const flag = (n: string) => argv.includes(`--${n}`);

function agentOf(name: string): Agent {
  if (name === "greedy") return greedyAgent();
  if (name === "random") return randomAgent;
  throw new Error(`unknown agent "${name}" (greedy | random)`);
}

async function main() {
  const games = Number(arg("games") ?? 100);
  const seed = seedOf(arg("seed") ?? String(Date.now() % 1_000_000));
  const maxRecords = Number(arg("max-records") ?? 20);
  const db = openDb(arg("db") ?? DEFAULT_DB_PATH);
  const engine = new SearchEngine(db);

  // Card pool: vanilla creatures legal in オリジナル.
  const pool = engine.search("is:vanilla type=クリーチャー f:original", { pageSize: 1000, unique: "cards" }).items.flatMap((c) => {
    try {
      return [fromCardItem(c)];
    } catch {
      return [];
    }
  });

  const deckRng = new Rng(seed).fork(99);
  const deckOf = async (spec: string): Promise<SimCard[]> => {
    if (spec.startsWith("deck:")) {
      const { deck } = await new DeckStore(openStore(arg("store") ?? DEFAULT_STORE)).get(spec.slice(5));
      const resolver = new CardResolver(db);
      const out: SimCard[] = [];
      for (const c of deck.cards.filter((x) => x.zone === "main")) {
        const r = resolver.resolve(c.name);
        if (!r.cardId) throw new Error(`「${c.name}」を特定できません`);
        const item = engine.card(r.cardId);
        if (!item) throw new Error(`card ${r.cardId} not found`);
        for (let i = 0; i < c.count; i++) out.push(fromCardItem(item));
      }
      return out;
    }
    return generateDeck(pool, { civs: parseCivs(spec) }, deckRng);
  };
  const decks: [SimCard[], SimCard[]] = [await deckOf(arg("deck-a") ?? "火"), await deckOf(arg("deck-b") ?? "水")];
  const agents: [Agent, Agent] = [agentOf(arg("agent-a") ?? "greedy"), agentOf(arg("agent-b") ?? "greedy")];

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = arg("out") ?? join(DATA_DIR, "sim", stamp);
  mkdirSync(out, { recursive: true });

  const records: GameRecord[] = [];
  const gameRng = new Rng(seed);
  for (let i = 0; i < games; i++) {
    const r = playGame({ decks, agents, seed: gameRng.int(2 ** 31) });
    records.push(r);
    if (i < maxRecords) {
      const n = String(i + 1).padStart(4, "0");
      writeFileSync(join(out, `game-${n}.json`), JSON.stringify(r));
      writeFileSync(join(out, `game-${n}.txt`), recordToText(r));
    }
  }
  const summary = summarize(records);
  writeFileSync(join(out, "summary.json"), JSON.stringify({ seed, decks: decks.map((d) => d.map((c) => c.name)), ...summary }, null, 1));
  const text = summaryToText(summary);
  writeFileSync(join(out, "summary.txt"), `seed=${seed}\n${text}\n`);
  if (!flag("quiet")) console.log(`${text}\n\n棋譜: ${relative(process.cwd(), out) || out}/game-0001.txt …（最初の${Math.min(games, maxRecords)}局）`);
}

if (/[\\/]sim[\\/]cli\.(ts|js)$/.test(argv[1] ?? "")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
