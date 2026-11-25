/**
 * Meta (環境) update job: weekly archetype ranking + CS results from 田園補完計画.
 * Cheap and idempotent, so it can run daily: a new weekly ranking (published on Monday night)
 * appears on the next run; CS results posted during the week are added as they come.
 * Deck lists are NOT updated automatically (they are edited by users); bundled transcriptions in
 * meta/decklists are only added when a deck with that id does not exist yet.
 *
 *   tsx src/jobs/meta-update.ts --store=gs://bucket/prefix [--weeks=6]
 */
import { env } from "node:process";
import { join } from "node:path";
import { DeckStore } from "../decks/store.js";
import { seedDecks } from "../decks/seed.js";
import { DEFAULT_STORE, ROOT } from "../lib/raw.js";
import { fetchMeta } from "../meta/fetch.js";
import { MetaRepo } from "../meta/repo.js";
import { openStore } from "../storage/object-store.js";

const log = (message: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity: "INFO", message, ...extra }));

export async function runMetaUpdate(opts: { store: string; weeks?: number }) {
  const repo = new MetaRepo(openStore(opts.store));
  const res = await fetchMeta(repo, { weeks: opts.weeks ?? 6, log: (m) => log(m) });
  const all = await repo.loadAll();
  const seeded = await seedDecks(new DeckStore(repo.store), join(ROOT, "meta", "decklists"), all.events);
  const index = await repo.writeIndex(all.snapshots, all.events.length);
  log("meta updated", { newWeeks: res.newSnapshots, eventsSaved: res.eventsSaved, failed: res.failed, decksSeeded: seeded.created, latest: index.latest });
  return { ...res, seeded: seeded.created };
}

if (/meta-update\.(ts|js)$/.test(process.argv[1] ?? "")) {
  const arg = (n: string) =>
    process.argv
      .find((a) => a.startsWith(`--${n}=`))
      ?.split("=")
      .slice(1)
      .join("=");
  runMetaUpdate({ store: arg("store") ?? env.DM_DATA_STORE ?? DEFAULT_STORE, weeks: Number(arg("weeks") ?? 6) })
    .then((r) => process.exit(r.failed > 0 && r.eventsSaved === 0 ? 1 : 0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
