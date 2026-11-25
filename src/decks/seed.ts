import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Format } from "../deck/validate.js";
import { parseDecklistFile } from "../meta/decklist.js";
import type { StoredEvent } from "../meta/repo.js";
import type { DeckStore } from "./store.js";

/**
 * Seed meta decks from the transcribed lists bundled in the repo (meta/decklists/*.txt).
 * Create-only: a deck that already exists in the store is never overwritten, because users may
 * have corrected it since. Unreadable photos (no cards) are skipped.
 * Deck id: m-<eventPostId>-<placementIndex>.
 */
export async function seedDecks(decks: DeckStore, dir: string, events: StoredEvent[], log: (m: string) => void = () => {}) {
  if (!existsSync(dir)) return { created: 0, skipped: 0 };
  const existing = new Set((await decks.list(true)).map((d) => d.id));
  const byId = new Map(events.map((e) => [e.id, e]));
  let created = 0;
  let skipped = 0;
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".txt"))
    .sort()) {
    const file = parseDecklistFile(f, readFileSync(join(dir, f), "utf8"));
    const eventId = Number(file.meta.event);
    const idx = Number(file.meta.placement);
    const id = `m-${eventId}-${idx}`;
    if (file.status === "unreadable" || existing.has(id)) {
      skipped++;
      continue;
    }
    const ev = byId.get(eventId);
    const pl = ev?.placements[idx - 1];
    const archetype = file.meta["meta-archetype"] ?? file.meta.archetype ?? null;
    await decks.create(
      {
        kind: "meta",
        name: `${file.meta.archetype ?? archetype ?? "デッキ"}（${file.meta["event-name"] ?? ev?.eventName ?? ""} ${file.meta.rank ?? ""}）`.slice(0, 80),
        format: (file.meta.format === "advance" ? "advance" : "original") as Format,
        archetype,
        status: file.status,
        note: [file.meta.note, file.meta.confirmed].filter(Boolean).join(" / "),
        cards: file.lines.map((l) => ({ zone: l.zone, name: l.name, count: l.count })),
        source: {
          eventId,
          placementIdx: idx,
          url: file.meta.source ?? ev?.url ?? "",
          image: file.meta.image ?? pl?.images[0] ?? null,
          eventName: file.meta["event-name"] ?? ev?.eventName ?? null,
          date: file.meta.date ?? ev?.date ?? null,
          rank: file.meta.rank ?? pl?.rankLabel ?? "",
          player: file.meta.player ?? pl?.player ?? null,
          archetype: file.meta.archetype ?? pl?.archetype ?? "",
        },
      },
      file.meta.transcribed ? `seed (${file.meta.transcribed})` : "seed",
      id,
    );
    created++;
    log(`seeded ${id}`);
  }
  return { created, skipped };
}
