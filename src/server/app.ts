import type { Database } from "better-sqlite3";
import { Hono } from "hono";
import { FIELDS } from "../search/compile.js";
import { QueryError, SearchEngine, type Order } from "../search/engine.js";
import { parseDeckText, validateDeck, type DeckInput, type Format } from "../deck/validate.js";

/** HTTP API. Kept separate from the listener so tests can call app.request() directly. */
export function createApp(db: Database): Hono {
  const engine = new SearchEngine(db);
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof QueryError) return c.json({ error: err.message, position: err.position ?? null }, 400);
    console.error(err);
    return c.json({ error: String(err) }, 500);
  });

  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    const unique = c.req.query("unique");
    const result = engine.search(q, {
      page: Number(c.req.query("page") ?? 1),
      pageSize: Number(c.req.query("pageSize") ?? 60),
      unique: unique === "prints" ? "prints" : unique === "cards" ? "cards" : undefined,
      order: (c.req.query("order") as Order | undefined) || undefined,
      dir: (c.req.query("dir") as "asc" | "desc" | undefined) || undefined,
    });
    return c.json(result);
  });

  app.get("/api/card/:id", (c) => {
    const raw = c.req.param("id");
    const card = /^\d+$/.test(raw) ? engine.card(Number(raw)) : engine.card(decodeURIComponent(raw));
    return card ? c.json(card) : c.json({ error: "not found" }, 404);
  });

  let metaCache: unknown = null;
  app.get("/api/meta", (c) => {
    metaCache ??= {
      builtAt: db.prepare("SELECT value FROM meta WHERE key = 'built_at'").pluck().get(),
      counts: {
        cards: db.prepare("SELECT COUNT(*) FROM cards").pluck().get(),
        printings: db.prepare("SELECT COUNT(*) FROM printings").pluck().get(),
        sets: db.prepare("SELECT COUNT(*) FROM sets").pluck().get(),
        illustrators: db.prepare("SELECT COUNT(*) FROM illustrators").pluck().get(),
      },
      sets: db
        .prepare(
          "SELECT code, display_code AS displayCode, name, label, kind, release_year AS releaseYear, release_estimated AS releaseEstimated, printing_count AS printingCount FROM sets ORDER BY release_rank DESC",
        )
        .all(),
      keywords: db
        .prepare(
          `SELECT name, card_count AS cardCount, official_id IS NOT NULL AS official FROM keywords
           WHERE card_count > 0 ORDER BY card_count DESC`,
        )
        .all(),
      families: db.prepare("SELECT family AS name, COUNT(*) AS members FROM keyword_families WHERE keyword != family GROUP BY family ORDER BY family").all(),
      tags: db
        .prepare("SELECT t.tag, t.label, t.description, (SELECT COUNT(DISTINCT card_id) FROM face_tags ft WHERE ft.tag = t.tag) AS cardCount FROM tags t")
        .all(),
      types: db.prepare("SELECT type, COUNT(DISTINCT card_id) AS cardCount FROM faces GROUP BY type ORDER BY cardCount DESC").all(),
      races: db
        .prepare(
          "SELECT race, COUNT(DISTINCT f.card_id) AS cardCount FROM face_races fr JOIN faces f ON f.id = fr.face_id GROUP BY race ORDER BY cardCount DESC",
        )
        .all(),
      illustrators: db.prepare("SELECT name, printing_count AS printingCount FROM illustrators ORDER BY printing_count DESC").all(),
      rarities: db.prepare("SELECT rarity, COUNT(*) AS n FROM printings WHERE rarity IS NOT NULL GROUP BY rarity ORDER BY n DESC").all(),
      fields: FIELDS,
    };
    return c.json(metaCache);
  });

  app.post("/api/deck/validate", async (c) => {
    const body = (await c.req.json()) as Partial<DeckInput> & { text?: string; format?: Format };
    const format: Format = body.format === "advance" ? "advance" : "original";
    const deck: DeckInput = body.text ? parseDeckText(body.text, format) : { format, main: body.main ?? [], hyperspatial: body.hyperspatial, gr: body.gr };
    return c.json(validateDeck(db, deck));
  });

  app.get("/api/quality", (c) => {
    const issues = db.prepare("SELECT kind, COUNT(*) AS n FROM quality_issues GROUP BY kind ORDER BY n DESC").all();
    const kind = c.req.query("kind");
    const samples = kind ? db.prepare("SELECT ref, detail FROM quality_issues WHERE kind = ? LIMIT 200").all(kind) : [];
    const agreement = JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'keyword_agreement'").pluck().get() as string) ?? "[]");
    return c.json({ issues, samples, keywordAgreement: agreement });
  });

  return app;
}
