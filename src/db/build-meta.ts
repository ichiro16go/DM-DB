import type { Database } from "better-sqlite3";
import { matchArchetype } from "../meta/archetypes.js";
import { CardResolver, checkDecklist, type DecklistFile } from "../meta/decklist.js";
import type { RankingPost, ResultPost } from "../meta/supersolenoid.js";

/**
 * Meta (環境) tables. Built from meta/ (committed JSON + transcribed lists) on every DB build,
 * after the card tables, so deck lists are resolved against the current card data.
 */
export const META_SCHEMA = /* sql */ `
CREATE TABLE meta_snapshots (
  id            INTEGER PRIMARY KEY,
  format        TEXT NOT NULL,            -- original | advance
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  sample_size   INTEGER NOT NULL,         -- 母数 (top-4 placements counted by the source)
  latest_set    TEXT,
  title         TEXT NOT NULL,
  source_url    TEXT NOT NULL,
  published_at  TEXT,
  singleton_share REAL,
  UNIQUE (format, period_start)
);
CREATE TABLE meta_entries (
  id           INTEGER PRIMARY KEY,
  snapshot_id  INTEGER NOT NULL REFERENCES meta_snapshots(id) ON DELETE CASCADE,
  rank         INTEGER NOT NULL,
  name         TEXT NOT NULL,             -- archetype as named by the source
  note         TEXT,                      -- e.g. "トリーヴァ40、白青黒緑1"
  count        INTEGER NOT NULL,
  share        REAL NOT NULL,             -- percent, as published
  share_calc   REAL NOT NULL              -- count / sample_size * 100
);
CREATE INDEX meta_entries_snapshot ON meta_entries(snapshot_id);
CREATE TABLE meta_singletons (
  snapshot_id INTEGER NOT NULL REFERENCES meta_snapshots(id) ON DELETE CASCADE,
  name        TEXT NOT NULL
);
CREATE TABLE meta_events (
  id         INTEGER PRIMARY KEY,         -- source post id
  url        TEXT NOT NULL,
  title      TEXT NOT NULL,
  format     TEXT,
  name       TEXT,
  date       TEXT,
  capacity   INTEGER,
  players    INTEGER,
  region     TEXT,
  store      TEXT
);
CREATE INDEX meta_events_date ON meta_events(format, date);
CREATE TABLE meta_placements (
  id          INTEGER PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES meta_events(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,           -- 1-based position in the post
  rank        INTEGER NOT NULL,
  rank_label  TEXT NOT NULL,
  archetype   TEXT NOT NULL,              -- as written in the post
  player      TEXT,
  images      TEXT NOT NULL,              -- JSON array of organiser deck image URLs
  entry_id    INTEGER REFERENCES meta_entries(id),  -- matched archetype of the covering weekly snapshot
  match_method TEXT,
  UNIQUE (event_id, idx)
);
CREATE INDEX meta_placements_entry ON meta_placements(entry_id);
CREATE TABLE decklists (
  id            INTEGER PRIMARY KEY,
  file          TEXT NOT NULL UNIQUE,     -- meta/decklists/<event>-<idx>.txt
  placement_id  INTEGER REFERENCES meta_placements(id),
  format        TEXT NOT NULL,
  archetype     TEXT,
  status        TEXT NOT NULL,            -- complete | partial | unreadable
  main_count    INTEGER NOT NULL,
  unknown_count INTEGER NOT NULL,
  valid         INTEGER NOT NULL,         -- passes resolution + construction rules
  problems      TEXT NOT NULL,            -- JSON array
  image_url     TEXT,
  transcribed   TEXT
);
CREATE TABLE decklist_cards (
  decklist_id INTEGER NOT NULL REFERENCES decklists(id) ON DELETE CASCADE,
  zone        TEXT NOT NULL,              -- main | hyperspatial | gr
  card_id     INTEGER REFERENCES cards(id),
  raw_name    TEXT NOT NULL,
  count       INTEGER NOT NULL,
  resolve_method TEXT
);
CREATE INDEX decklist_cards_deck ON decklist_cards(decklist_id);
CREATE INDEX decklist_cards_card ON decklist_cards(card_id);
`;

export interface MetaSource {
  snapshots: RankingPost[];
  events: (ResultPost & { id: number })[];
  decklists: DecklistFile[];
}

export function buildMeta(db: Database, meta: MetaSource, issue: (kind: string, ref: string, detail: string) => void): { snapshots: number; events: number; decklists: number; validDecklists: number } {
  db.exec(META_SCHEMA);
  const insSnap = db.prepare(`INSERT INTO meta_snapshots (format, period_start, period_end, sample_size, latest_set, title, source_url, published_at, singleton_share)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insEntry = db.prepare("INSERT INTO meta_entries (snapshot_id, rank, name, note, count, share, share_calc) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insSingle = db.prepare("INSERT INTO meta_singletons (snapshot_id, name) VALUES (?, ?)");
  const insEvent = db.prepare("INSERT OR REPLACE INTO meta_events (id, url, title, format, name, date, capacity, players, region, store) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insPlacement = db.prepare(`INSERT INTO meta_placements (event_id, idx, rank, rank_label, archetype, player, images, entry_id, match_method)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insDeck = db.prepare(`INSERT INTO decklists (file, placement_id, format, archetype, status, main_count, unknown_count, valid, problems, image_url, transcribed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insDeckCard = db.prepare("INSERT INTO decklist_cards (decklist_id, zone, card_id, raw_name, count, resolve_method) VALUES (?, ?, ?, ?, ?, ?)");

  let validDecklists = 0;
  db.transaction(() => {
    // snapshots + entries; remember entry ids per snapshot for placement matching
    const snaps: { s: RankingPost; entries: { id: number; name: string }[] }[] = [];
    for (const s of meta.snapshots) {
      const sid = Number(
        insSnap.run(s.format, s.periodStart, s.periodEnd, s.sampleSize, s.latestSet, s.title, s.url, s.publishedAt, s.singletonShare).lastInsertRowid,
      );
      const entries = s.entries.map((e) => ({
        id: Number(insEntry.run(sid, e.rank, e.name, e.note, e.count, e.share, Math.round((e.count / s.sampleSize) * 1000) / 10).lastInsertRowid),
        name: e.name,
      }));
      for (const n of s.singletons) insSingle.run(sid, n);
      snaps.push({ s, entries });
      if (Math.abs(s.entries.reduce((a, e) => a + e.count, 0) + s.singletons.length - s.sampleSize) > 0)
        issue("meta_count_mismatch", s.url, `entries+singletons ≠ 母数 ${s.sampleSize}`);
    }
    // events + placements
    const placementId = new Map<string, number>();
    for (const e of meta.events) {
      insEvent.run(e.id, e.url, e.title, e.format, e.eventName, e.date, e.capacity, e.players, e.region, e.store);
      const cover = snaps.find((x) => x.s.format === e.format && e.date && e.date >= x.s.periodStart && e.date <= x.s.periodEnd);
      e.placements.forEach((p, i) => {
        const m = cover && p.rank <= 4 ? matchArchetype(p.archetype, cover.entries) : null;
        const id = Number(
          insPlacement.run(e.id, i + 1, p.rank, p.rankLabel, p.archetype, p.player, JSON.stringify(p.images), m?.target.id ?? null, m?.method ?? null).lastInsertRowid,
        );
        placementId.set(`${e.id}-${i + 1}`, id);
      });
    }
    // transcribed deck lists
    const resolver = new CardResolver(db);
    for (const f of meta.decklists) {
      const r = checkDecklist(db, resolver, f);
      const pid = placementId.get(`${f.meta.event}-${f.meta.placement}`) ?? null;
      if (!pid) r.problems.push(`placement ${f.meta.event}-${f.meta.placement} not found in meta/events`);
      const valid = f.status !== "unreadable" && r.problems.length === 0;
      if (valid) validDecklists++;
      const main = r.cards.filter((c) => c.zone === "main").reduce((s, c) => s + c.count, 0);
      const did = Number(
        insDeck.run(
          f.file,
          pid,
          f.meta.format === "advance" ? "advance" : "original",
          f.meta.archetype ?? null,
          f.status,
          main,
          r.unknown,
          valid ? 1 : 0,
          JSON.stringify(r.problems),
          f.meta.image ?? null,
          f.meta.transcribed ?? null,
        ).lastInsertRowid,
      );
      for (const c of r.cards) insDeckCard.run(did, c.zone, c.cardId, c.rawName, c.count, c.method);
      for (const p of r.problems) issue("decklist_problem", f.file, p);
    }
  })();
  return { snapshots: meta.snapshots.length, events: meta.events.length, decklists: meta.decklists.length, validDecklists };
}
