import type { DeckStore, DeckSummary } from "../decks/store.js";
import { matchArchetype } from "./archetypes.js";
import { eventsFor, type MetaRepo, type StoredEvent } from "./repo.js";
import type { MetaFormat, RankingPost } from "./supersolenoid.js";

export interface SnapshotSummary {
  format: MetaFormat;
  periodStart: string;
  periodEnd: string;
  sampleSize: number;
  latestSet: string | null;
  title: string;
  url: string;
}

export interface RankingRow {
  rank: number;
  name: string;
  note: string | null;
  count: number;
  share: number;
  prev: { rank: number; share: number; count: number } | null; // same archetype in the previous week
  placements: number; // top-4 placements we have CS results for (≤ count)
  withImages: number;
  decks: DeckSummary[]; // registered deck lists of this archetype (this week's first)
}

export interface PlacementRow {
  eventId: number;
  eventName: string | null;
  date: string | null;
  url: string;
  store: string | null;
  region: string | null;
  players: number | null;
  idx: number;
  rank: number;
  rankLabel: string;
  archetype: string;
  player: string | null;
  images: string[];
  deckId: string | null;
}

const toSummary = (s: RankingPost): SnapshotSummary => ({
  format: s.format,
  periodStart: s.periodStart,
  periodEnd: s.periodEnd,
  sampleSize: s.sampleSize,
  latestSet: s.latestSet,
  title: s.title,
  url: s.url,
});

/**
 * In-memory view of the meta data in the store. Reloads when the update job rewrites
 * meta/index.json (checked at most every `refreshMs`, triggered by requests).
 */
export class MetaService {
  private snapshots: RankingPost[] = [];
  private events: StoredEvent[] = [];
  private version: string | null = null;
  private lastCheck = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private repo: MetaRepo,
    private decks: DeckStore | null,
    private refreshMs = 10 * 60_000,
    private log: (m: string) => void = () => {},
  ) {}

  async init() {
    await this.reload();
  }

  /** Reload if the job published new data (non-blocking unless nothing is loaded yet). */
  async ensureFresh() {
    if (Date.now() - this.lastCheck < this.refreshMs && this.version !== null) return;
    this.lastCheck = Date.now();
    this.loading ??= (async () => {
      try {
        const v = await this.repo.indexVersion();
        if (v !== this.version || this.snapshots.length === 0) await this.reload(v);
      } catch (e) {
        this.log(`meta refresh failed: ${String(e)}`);
      } finally {
        this.loading = null;
      }
    })();
    if (this.snapshots.length === 0) await this.loading;
  }

  private async reload(version?: string | null) {
    const { snapshots, events } = await this.repo.loadAll();
    this.snapshots = snapshots;
    this.events = events;
    this.version = version ?? (await this.repo.indexVersion());
    this.log(`meta loaded: ${snapshots.length} snapshots, ${events.length} events`);
  }

  listSnapshots(): SnapshotSummary[] {
    return this.snapshots.map(toSummary);
  }

  private find(format: MetaFormat, week?: string | null) {
    const list = this.snapshots.filter((s) => s.format === format).sort((a, b) => b.periodStart.localeCompare(a.periodStart));
    const i = week ? list.findIndex((s) => s.periodStart === week) : 0;
    return { snap: i >= 0 ? list[i] : undefined, prev: i >= 0 ? list[i + 1] : undefined };
  }

  /** Decks of an archetype: matched by name (robust to weekly renames like 生徒会組 ↔ アナカラー系生徒会組). */
  private async decksFor(snap: RankingPost, entryName: string): Promise<DeckSummary[]> {
    if (!this.decks) return [];
    const all = (await this.decks.list()).filter((d) => d.kind === "meta" && d.format === snap.format);
    const mine = all.filter((d) => {
      const name = d.archetype ?? d.source?.archetype ?? d.name;
      return (
        matchArchetype(name, snap.entries)?.target.name === entryName ||
        (d.source && matchArchetype(d.source.archetype, snap.entries)?.target.name === entryName)
      );
    });
    const inWeek = (d: DeckSummary) => !!d.source?.date && d.source.date >= snap.periodStart && d.source.date <= snap.periodEnd;
    const statusRank = { complete: 0, partial: 1, unreadable: 2 } as const;
    return mine.sort(
      (a, b) =>
        Number(inWeek(b)) - Number(inWeek(a)) || statusRank[a.status] - statusRank[b.status] || (b.source?.date ?? "").localeCompare(a.source?.date ?? ""),
    );
  }

  private placementsOf(snap: RankingPost) {
    return eventsFor(snap, this.events).flatMap((e) =>
      e.placements
        .map((p, i) => ({ e, p, idx: i + 1 }))
        .filter((x) => x.p.rank <= 4)
        .map((x) => ({ ...x, entry: matchArchetype(x.p.archetype, snap.entries)?.target.name ?? null })),
    );
  }

  async ranking(format: MetaFormat, week?: string | null) {
    const { snap, prev } = this.find(format, week);
    if (!snap) return null;
    const pls = this.placementsOf(snap);
    const rows: RankingRow[] = [];
    for (const e of snap.entries) {
      const p = prev ? matchArchetype(e.name, prev.entries)?.target : undefined;
      const mine = pls.filter((x) => x.entry === e.name);
      rows.push({
        rank: e.rank,
        name: e.name,
        note: e.note,
        count: e.count,
        share: e.share,
        prev: p ? { rank: p.rank, share: p.share, count: p.count } : null,
        placements: mine.length,
        withImages: mine.filter((x) => x.p.images.length > 0).length,
        decks: await this.decksFor(snap, e.name),
      });
    }
    const weeks = this.snapshots.filter((s) => s.format === format).map((s) => s.periodStart);
    return {
      snapshot: toSummary(snap),
      previous: prev ? toSummary(prev) : null,
      weeks,
      rows,
      singletons: snap.singletons,
      singletonShare: snap.singletonShare,
    };
  }

  async entry(format: MetaFormat, name: string, week?: string | null) {
    const { snap } = this.find(format, week);
    if (!snap) return null;
    const entry = snap.entries.find((e) => e.name === name);
    if (!entry) return null;
    const deckIds = new Set(this.decks ? (await this.decks.list()).map((d) => d.id) : []);
    const placements: PlacementRow[] = this.placementsOf(snap)
      .filter((x) => x.entry === name)
      .sort((a, b) => a.p.rank - b.p.rank || (b.e.date ?? "").localeCompare(a.e.date ?? ""))
      .map((x) => ({
        eventId: x.e.id,
        eventName: x.e.eventName,
        date: x.e.date,
        url: x.e.url,
        store: x.e.store,
        region: x.e.region,
        players: x.e.players,
        idx: x.idx,
        rank: x.p.rank,
        rankLabel: x.p.rankLabel,
        archetype: x.p.archetype,
        player: x.p.player,
        images: x.p.images,
        deckId: deckIds.has(`m-${x.e.id}-${x.idx}`) ? `m-${x.e.id}-${x.idx}` : null,
      }));
    return { snapshot: toSummary(snap), entry, placements, decks: await this.decksFor(snap, name) };
  }
}
