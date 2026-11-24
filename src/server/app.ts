import type { Database } from "better-sqlite3";
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type Next } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { FIELDS } from "../search/compile.js";
import { QueryError, SearchEngine, type Order } from "../search/engine.js";
import { parseDeckText, validateDeck, type DeckInput, type Format } from "../deck/validate.js";
import { createMcpServer } from "../mcp/tools.js";
import type { DbHolder } from "./db-holder.js";

/**
 * Access control. The card texts and images belong to their rights holders, so a deployed
 * instance must not be open to the world by accident:
 *   - basic: username/password for the browser UI and the API
 *   - token: "Authorization: Bearer <token>" for the API and /mcp (Claude Code, scripts)
 *            and /mcp/<token> for MCP clients that cannot send headers
 *   - public: explicitly allow unauthenticated access (local development)
 */
export interface AuthConfig {
  basic?: { user: string; password: string };
  token?: string;
  public?: boolean;
}

export interface AppOptions {
  auth?: AuthConfig;
}

type DbSource = Database | Pick<DbHolder, "current" | "maybeRefresh" | "version">;

const sha = (s: string) => createHash("sha256").update(s).digest();
/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha(a), sha(b));
}

function authMiddleware(auth: AuthConfig) {
  return async (c: Context, next: Next) => {
    if (auth.public || c.req.path === "/healthz") return next();
    const header = c.req.header("authorization") ?? "";
    if (auth.token && header.startsWith("Bearer ") && safeEqual(header.slice(7).trim(), auth.token)) return next();
    if (auth.token && c.req.path.startsWith("/mcp/")) {
      const t = decodeURIComponent(c.req.path.slice("/mcp/".length));
      if (safeEqual(t, auth.token)) return next();
    }
    if (auth.basic && header.startsWith("Basic ")) {
      const [user, ...rest] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
      if (safeEqual(user ?? "", auth.basic.user) && safeEqual(rest.join(":"), auth.basic.password)) return next();
    }
    if (auth.basic) c.header("WWW-Authenticate", 'Basic realm="DM Card DB", charset="UTF-8"');
    return c.json({ error: "authentication required" }, 401);
  };
}

/** HTTP API + MCP endpoint. Kept separate from the listener so tests can call app.request() directly. */
export function createApp(source: DbSource, opts: AppOptions = {}): Hono {
  const holder = "current" in source ? source : null;
  const dbOf = (): Database => (holder ? holder.current() : (source as Database));
  // One engine / meta payload per DB handle (the handle changes when a new DB is swapped in).
  const engines = new WeakMap<Database, SearchEngine>();
  const metas = new WeakMap<Database, unknown>();
  const engineOf = (db: Database) => {
    let e = engines.get(db);
    if (!e) engines.set(db, (e = new SearchEngine(db)));
    return e;
  };

  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof QueryError) return c.json({ error: err.message, position: err.position ?? null }, 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  app.use("*", authMiddleware(opts.auth ?? { public: true }));
  app.use("*", async (_c, next) => {
    holder?.maybeRefresh();
    await next();
  });

  app.get("/healthz", (c) => {
    const db = dbOf();
    return c.json({ ok: true, dbVersion: holder?.version ?? "local", cards: db.prepare("SELECT COUNT(*) FROM cards").pluck().get() });
  });

  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    const unique = c.req.query("unique");
    const result = engineOf(dbOf()).search(q, {
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
    const engine = engineOf(dbOf());
    const card = /^\d+$/.test(raw) ? engine.card(Number(raw)) : engine.card(decodeURIComponent(raw));
    return card ? c.json(card) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/meta", (c) => {
    const db = dbOf();
    let meta = metas.get(db);
    if (!meta) metas.set(db, (meta = buildMeta(db)));
    return c.json(meta);
  });

  app.post("/api/deck/validate", async (c) => {
    const body = (await c.req.json()) as Partial<DeckInput> & { text?: string; format?: Format };
    const format: Format = body.format === "advance" ? "advance" : "original";
    const deck: DeckInput = body.text ? parseDeckText(body.text, format) : { format, main: body.main ?? [], hyperspatial: body.hyperspatial, gr: body.gr };
    return c.json(validateDeck(dbOf(), deck));
  });

  app.get("/api/quality", (c) => {
    const db = dbOf();
    const issues = db.prepare("SELECT kind, COUNT(*) AS n FROM quality_issues GROUP BY kind ORDER BY n DESC").all();
    const kind = c.req.query("kind");
    const samples = kind ? db.prepare("SELECT ref, detail FROM quality_issues WHERE kind = ? LIMIT 200").all(kind) : [];
    const agreement = JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'keyword_agreement'").pluck().get() as string) ?? "[]");
    return c.json({ issues, samples, keywordAgreement: agreement });
  });

  // MCP over Streamable HTTP, stateless: a fresh server per request bound to the current DB.
  const mcp = async (c: Context) => {
    const server = createMcpServer(dbOf());
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  };
  app.all("/mcp", mcp);
  app.all("/mcp/:token", mcp);

  return app;
}

function buildMeta(db: Database) {
  return {
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
      .prepare("SELECT race, COUNT(DISTINCT f.card_id) AS cardCount FROM face_races fr JOIN faces f ON f.id = fr.face_id GROUP BY race ORDER BY cardCount DESC")
      .all(),
    illustrators: db.prepare("SELECT name, printing_count AS printingCount FROM illustrators ORDER BY printing_count DESC").all(),
    rarities: db.prepare("SELECT rarity, COUNT(*) AS n FROM printings WHERE rarity IS NOT NULL GROUP BY rarity ORDER BY n DESC").all(),
    fields: FIELDS,
  };
}
