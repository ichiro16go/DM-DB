import { randomUUID } from "node:crypto";
import { PreconditionFailedError, type ObjectStore } from "../storage/object-store.js";
import { MAX_REVISIONS, type Deck, type DeckInput, type DeckRevision } from "./model.js";

export class DeckNotFoundError extends Error {}

export interface DeckSummary {
  id: string;
  kind: Deck["kind"];
  name: string;
  format: Deck["format"];
  archetype: string | null;
  status: Deck["status"];
  source: Deck["source"];
  updatedAt: string;
  cardCount: number;
}

const summarize = (d: Deck): DeckSummary => ({
  id: d.id,
  kind: d.kind,
  name: d.name,
  format: d.format,
  archetype: d.archetype,
  status: d.status,
  source: d.source,
  updatedAt: d.updatedAt,
  cardCount: d.cards.filter((c) => c.zone === "main").reduce((s, c) => s + c.count, 0),
});

/**
 * Deck lists in the writable store, one JSON object per deck (decks/<id>.json).
 * Writes use the object version as a precondition, so two people editing the same deck
 * cannot silently overwrite each other (PreconditionFailedError → HTTP 409).
 * The listing is cached briefly; single reads always go to the store.
 */
export class DeckStore {
  private cache: { at: number; decks: Map<string, DeckSummary> } | null = null;

  constructor(
    private store: ObjectStore,
    private prefix = "decks/",
    private cacheMs = 30_000,
  ) {}

  private key(id: string) {
    if (!/^[\w-]{1,80}$/.test(id)) throw new DeckNotFoundError(id);
    return `${this.prefix}${id}.json`;
  }

  async list(force = false): Promise<DeckSummary[]> {
    if (force || !this.cache || Date.now() - this.cache.at > this.cacheMs) {
      const keys = (await this.store.list(this.prefix)).filter((k) => k.endsWith(".json"));
      const decks = new Map<string, DeckSummary>();
      // Small number of decks (hundreds at most): read them all, a few at a time.
      for (let i = 0; i < keys.length; i += 16) {
        const batch = await Promise.all(keys.slice(i, i + 16).map((k) => this.store.getText(k)));
        for (const b of batch) {
          if (!b) continue;
          const d = JSON.parse(b.text) as Deck;
          decks.set(d.id, summarize(d));
        }
      }
      this.cache = { at: Date.now(), decks };
    }
    return [...this.cache.decks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<{ deck: Deck; version: string }> {
    const r = await this.store.getText(this.key(id));
    if (!r) throw new DeckNotFoundError(id);
    return { deck: JSON.parse(r.text) as Deck, version: r.version };
  }

  async create(input: DeckInput & Pick<Deck, "name" | "format">, by: string | null, id?: string): Promise<{ deck: Deck; version: string }> {
    const now = new Date().toISOString();
    const deck: Deck = {
      id: id ?? `${input.kind === "meta" ? "m" : "u"}-${randomUUID().slice(0, 8)}`,
      kind: input.kind ?? "user",
      name: input.name,
      format: input.format,
      archetype: input.archetype ?? null,
      status: input.status ?? "complete",
      source: input.source ?? null,
      note: input.note ?? "",
      cards: input.cards ?? [],
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
      revisions: [],
    };
    const version = await this.store.putText(this.key(deck.id), JSON.stringify(deck, null, 1), { ifVersion: null });
    this.touch(deck);
    return { deck, version };
  }

  /** Update with optimistic concurrency: `version` must be the one the client read. */
  async update(id: string, input: DeckInput, version: string, by: string | null): Promise<{ deck: Deck; version: string }> {
    const { deck: cur } = await this.get(id);
    const rev: DeckRevision = { at: cur.updatedAt, by: cur.updatedBy, name: cur.name, status: cur.status, note: cur.note, cards: cur.cards };
    const next: Deck = {
      ...cur,
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
      id: cur.id,
      kind: cur.kind,
      createdAt: cur.createdAt,
      updatedAt: new Date().toISOString(),
      updatedBy: by,
      revisions: [rev, ...cur.revisions].slice(0, MAX_REVISIONS),
    };
    const v = await this.store.putText(this.key(id), JSON.stringify(next, null, 1), { ifVersion: version });
    this.touch(next);
    return { deck: next, version: v };
  }

  /** Bring back revision `index` (0 = the version before the current one) as a new save. */
  async restore(id: string, index: number, version: string, by: string | null) {
    const { deck } = await this.get(id);
    const rev = deck.revisions[index];
    if (!rev) throw new DeckNotFoundError(`${id} revision ${index}`);
    return this.update(id, { name: rev.name, status: rev.status, note: rev.note, cards: rev.cards }, version, by);
  }

  async delete(id: string, version: string) {
    const { version: cur } = await this.get(id);
    if (cur !== version) throw new PreconditionFailedError(this.key(id));
    await this.store.delete(this.key(id));
    this.cache?.decks.delete(id);
  }

  private touch(d: Deck) {
    this.cache?.decks.set(d.id, summarize(d));
  }
}
