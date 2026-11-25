import type { Database } from "better-sqlite3";
import type { Hono } from "hono";
import { parseDeckText } from "../deck/validate.js";
import { analyzeDeck, DeckInputError, sanitizeInput, type DeckCard, type DeckInput } from "../decks/model.js";
import { DeckNotFoundError, type DeckStore } from "../decks/store.js";
import { CardResolver } from "../meta/decklist.js";
import { PreconditionFailedError } from "../storage/object-store.js";
import type { AppEnv } from "./app.js";

/**
 * Deck REST API (meta decks and user decks).
 *
 *   GET    /api/decks?kind=&format=&archetype=     list (summaries)
 *   GET    /api/decks/:id                          deck + version + analysis
 *   POST   /api/decks                              create
 *   PUT    /api/decks/:id   { version, ... }       update (409 if someone saved in between)
 *   DELETE /api/decks/:id?version=                 delete
 *   POST   /api/decks/:id/restore { version, index }  bring back an older revision
 *   POST   /api/decks/analyze { format, cards }     resolve + validate without saving (deck builder)
 *   POST   /api/decks/parse   { text }              deck-list text → cards (import)
 */
/** Map deck errors to HTTP responses (called from the app's error handler). */
export function deckErrorResponse(err: unknown): { status: 400 | 404 | 409; body: Record<string, string> } | null {
  if (err instanceof DeckNotFoundError) return { status: 404, body: { error: "deck not found" } };
  if (err instanceof PreconditionFailedError)
    return { status: 409, body: { error: "このデッキは他の場所で更新されています。再読み込みしてから編集してください。", code: "conflict" } };
  if (err instanceof DeckInputError) return { status: 400, body: { error: err.message } };
  return null;
}

/** A meta deck registered for a CS placement gets the placement's id (one list per placement; 409 if it exists). */
function metaDeckId(input: DeckInput): string | undefined {
  const s = input.source;
  if (input.kind !== "meta" || !s || !Number.isInteger(s.eventId) || !Number.isInteger(s.placementIdx) || s.eventId <= 0 || s.placementIdx <= 0)
    return undefined;
  return `m-${s.eventId}-${s.placementIdx}`;
}

export function registerDeckRoutes(app: Hono<AppEnv>, dbOf: () => Database, decks: DeckStore) {
  const resolvers = new WeakMap<Database, CardResolver>();
  const resolverOf = (db: Database) => {
    let r = resolvers.get(db);
    if (!r) resolvers.set(db, (r = new CardResolver(db)));
    return r;
  };
  const analyze = (d: { format: "original" | "advance"; cards: DeckCard[] }) => {
    const db = dbOf();
    return analyzeDeck(db, resolverOf(db), d);
  };
  /** Store official names for cards the resolver identified, so saved lists are canonical. */
  const canonical = (format: "original" | "advance", cards: DeckCard[]): DeckCard[] =>
    analyze({ format, cards }).cards.map((c) => ({ zone: c.zone, count: c.count, name: c.cardId ? c.name : c.inputName }));

  app.get("/api/decks", async (c) => {
    const kind = c.req.query("kind");
    const format = c.req.query("format");
    const archetype = c.req.query("archetype");
    const list = (await decks.list(c.req.query("fresh") === "1")).filter(
      (d) => (!kind || d.kind === kind) && (!format || d.format === format) && (!archetype || d.archetype === archetype),
    );
    return c.json({ decks: list });
  });

  app.get("/api/decks/:id", async (c) => {
    const { deck, version } = await decks.get(c.req.param("id"));
    return c.json({ deck, version, analysis: analyze(deck) });
  });

  app.post("/api/decks/analyze", async (c) => {
    const body = (await c.req.json()) as DeckInput;
    const input = sanitizeInput({ format: body.format ?? "original", cards: body.cards ?? [] });
    return c.json(analyze({ format: input.format!, cards: input.cards! }));
  });

  app.post("/api/decks/parse", async (c) => {
    const { text } = (await c.req.json()) as { text?: string };
    const parsed = parseDeckText(text ?? "");
    const cards: DeckCard[] = [
      ...parsed.main.map((e) => ({ zone: "main" as const, ...e })),
      ...(parsed.hyperspatial ?? []).map((e) => ({ zone: "hyperspatial" as const, ...e })),
      ...(parsed.gr ?? []).map((e) => ({ zone: "gr" as const, ...e })),
      ...(parsed.special ?? []).map((e) => ({ zone: "special" as const, ...e })),
    ];
    return c.json({ cards: sanitizeInput({ cards }).cards });
  });

  app.post("/api/decks", async (c) => {
    const body = (await c.req.json()) as DeckInput;
    const input = sanitizeInput(body);
    if (!input.name) throw new DeckInputError("name が必要です");
    const format = input.format ?? "original";
    const { deck, version } = await decks.create(
      { ...input, name: input.name, format, cards: canonical(format, input.cards ?? []) },
      c.get("user") ?? null,
      metaDeckId(input),
    );
    return c.json({ deck, version, analysis: analyze(deck) }, 201);
  });

  app.put("/api/decks/:id", async (c) => {
    const body = (await c.req.json()) as DeckInput & { version?: string };
    if (!body.version) throw new DeckInputError("version が必要です（読み込んだときの version を送ってください）");
    const { kind: _k, source: _s, ...rest } = body; // kind and source are fixed after creation
    const input = sanitizeInput(rest);
    const id = c.req.param("id");
    if (input.cards) {
      const format = input.format ?? (await decks.get(id)).deck.format;
      input.cards = canonical(format, input.cards);
    }
    const { deck, version } = await decks.update(id, input, body.version, c.get("user") ?? null);
    return c.json({ deck, version, analysis: analyze(deck) });
  });

  app.post("/api/decks/:id/restore", async (c) => {
    const { version, index } = (await c.req.json()) as { version?: string; index?: number };
    if (!version || !Number.isInteger(index)) throw new DeckInputError("version と index が必要です");
    const { deck, version: v } = await decks.restore(c.req.param("id"), index!, version, c.get("user") ?? null);
    return c.json({ deck, version: v, analysis: analyze(deck) });
  });

  app.delete("/api/decks/:id", async (c) => {
    const version = c.req.query("version");
    if (!version) throw new DeckInputError("version が必要です");
    await decks.delete(c.req.param("id"), version);
    return c.json({ ok: true });
  });
}
