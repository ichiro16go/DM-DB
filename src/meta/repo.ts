import type { ObjectStore } from "../storage/object-store.js";
import type { RankingPost, ResultPost } from "./supersolenoid.js";

export interface StoredEvent extends ResultPost {
  id: number;
}

export interface MetaIndex {
  updatedAt: string;
  snapshots: number;
  events: number;
  latest: Record<string, string>; // format → latest periodStart
}

/**
 * Meta (環境) data in the shared store:
 *   meta/snapshots/<format>-<periodStart>.json   weekly archetype shares
 *   meta/events/<postId>.json                    CS results (placements + deck image URLs)
 *   meta/index.json                              written last by the update job; readers watch its version
 */
export class MetaRepo {
  constructor(readonly store: ObjectStore) {}

  async snapshotKeys() {
    return (await this.store.list("meta/snapshots/")).filter((k) => k.endsWith(".json"));
  }
  async eventKeys() {
    return (await this.store.list("meta/events/")).filter((k) => k.endsWith(".json"));
  }
  async hasEvent(id: number) {
    return (await this.store.version(`meta/events/${id}.json`)) !== null;
  }
  async saveSnapshot(s: RankingPost) {
    await this.store.putText(`meta/snapshots/${s.format}-${s.periodStart}.json`, JSON.stringify(s, null, 1));
  }
  async saveEvent(e: StoredEvent) {
    await this.store.putText(`meta/events/${e.id}.json`, JSON.stringify(e, null, 1));
  }

  async loadAll(): Promise<{ snapshots: RankingPost[]; events: StoredEvent[] }> {
    const read = async <T>(keys: string[]) => {
      const out: T[] = [];
      for (let i = 0; i < keys.length; i += 24) {
        const batch = await Promise.all(keys.slice(i, i + 24).map((k) => this.store.getText(k)));
        for (const b of batch) if (b) out.push(JSON.parse(b.text) as T);
      }
      return out;
    };
    const snapshots = (await read<RankingPost>(await this.snapshotKeys())).sort(
      (a, b) => b.periodStart.localeCompare(a.periodStart) || a.format.localeCompare(b.format),
    );
    const events = await read<StoredEvent>(await this.eventKeys());
    return { snapshots, events };
  }

  async indexVersion() {
    return this.store.version("meta/index.json");
  }
  async writeIndex(snapshots: RankingPost[], events: number) {
    const latest: Record<string, string> = {};
    for (const s of snapshots) if (!latest[s.format] || latest[s.format]! < s.periodStart) latest[s.format] = s.periodStart;
    const idx: MetaIndex = { updatedAt: new Date().toISOString(), snapshots: snapshots.length, events, latest };
    await this.store.putText("meta/index.json", JSON.stringify(idx, null, 1));
    return idx;
  }
}

/** Events (and their placements) that fall inside a snapshot's period and format. */
export function eventsFor(snapshot: RankingPost, events: StoredEvent[]) {
  return events.filter((e) => e.format === snapshot.format && e.date && e.date >= snapshot.periodStart && e.date <= snapshot.periodEnd);
}
