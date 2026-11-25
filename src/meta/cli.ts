/**
 * Meta (環境) data tools. Data lives in the shared store (DM_DATA_STORE, default data/store).
 *
 *   tsx src/meta/cli.ts fetch [--weeks=6]        weekly rankings (both formats) + new CS result posts
 *   tsx src/meta/cli.ts queue [--per=1] [--min-count=1] [--week=YYYY-MM-DD] [--format=original|advance]
 *                                                 pick placements to transcribe, download their deck images
 *   tsx src/meta/cli.ts check [--fix]             resolve + validate every meta/decklists/*.txt
 *   tsx src/meta/cli.ts import-decks             create store decks from meta/decklists/*.txt (create-only)
 *   common: --store=gs://bucket/prefix | /local/dir
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { pool } from "../lib/http.js";
import { DEFAULT_DB_PATH, DEFAULT_STORE, ROOT } from "../lib/raw.js";
import { openDb } from "../search/engine.js";
import { openStore } from "../storage/object-store.js";
import { DeckStore } from "../decks/store.js";
import { seedDecks } from "../decks/seed.js";
import { matchArchetype } from "./archetypes.js";
import { CardResolver, checkDecklist, formatDecklistFile, parseDecklistFile } from "./decklist.js";
import { fetchMeta } from "./fetch.js";
import { eventsFor, MetaRepo } from "./repo.js";
import type { RankingPost } from "./supersolenoid.js";

export const META_DIR = join(ROOT, "meta");
export const DECK_DIR = join(META_DIR, "decklists");
const BASE = "https://supersolenoid.jp";

const args = process.argv.slice(2);
const arg = (n: string) =>
  args
    .find((a) => a.startsWith(`--${n}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const log = (...m: unknown[]) => console.log(...m);
const storeLocation = () => arg("store") ?? env.DM_DATA_STORE ?? DEFAULT_STORE;
const repo = () => new MetaRepo(openStore(storeLocation()));

async function cmdFetch() {
  const r = repo();
  const res = await fetchMeta(r, { weeks: Number(arg("weeks") ?? 6), log: (m) => log(m) });
  const all = await r.loadAll();
  await r.writeIndex(all.snapshots, all.events.length);
  log(`new weeks: ${res.newSnapshots.join(", ") || "none"}; events saved: ${res.eventsSaved}${res.failed ? `, failed: ${res.failed}` : ""}`);
}

async function cmdImportDecks() {
  const r = repo();
  const { events } = await r.loadAll();
  const res = await seedDecks(new DeckStore(r.store), DECK_DIR, events, (m) => log(m));
  log(`decks created: ${res.created}, skipped: ${res.skipped}`);
}

interface Dims {
  w: number;
  h: number;
}
const DIMS_FILE = join(ROOT, "data", "raw", "meta", "image-dims.json");
let dimsCache: Record<string, Dims | null> | null = null;

/** Image size from the first 64 KB (JPEG SOF / PNG IHDR), cached on disk. */
async function imageDims(url: string): Promise<Dims | null> {
  dimsCache ??= existsSync(DIMS_FILE) ? JSON.parse(readFileSync(DIMS_FILE, "utf8")) : {};
  if (url in dimsCache!) return dimsCache![url]!;
  let d: Dims | null = null;
  try {
    const res = await fetch(url, { headers: { range: "bytes=0-65535", referer: `${BASE}/`, "user-agent": "dm-card-db/0.1" } });
    const b = Buffer.from(await res.arrayBuffer());
    if (b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG") d = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    else
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) break;
        const m = b[i + 1]!;
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          d = { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
          break;
        }
        i += 2 + b.readUInt16BE(i + 2);
      }
  } catch {
    d = null;
  }
  dimsCache![url] = d;
  mkdirSync(join(ROOT, "data", "raw", "meta"), { recursive: true });
  writeFileSync(DIMS_FILE, JSON.stringify(dimsCache));
  return d;
}

const deckFile = (eventId: number, placementIdx: number) => join(DECK_DIR, `${eventId}-${placementIdx}.txt`);

async function cmdQueue() {
  const per = Number(arg("per") ?? 1);
  const minCount = Number(arg("min-count") ?? 1);
  const week = arg("week");
  const fmt = arg("format");
  const { snapshots: allSnaps, events } = await repo().loadAll();
  const snaps = allSnaps.filter((s) => (!fmt || s.format === fmt) && (!week || s.periodStart === week));
  const latest = new Map<string, RankingPost>();
  for (const s of snaps) if (!latest.has(s.format) || latest.get(s.format)!.periodStart < s.periodStart) latest.set(s.format, s);
  mkdirSync(DECK_DIR, { recursive: true });
  const queue: { file: string; image: string; local: string; label: string }[] = [];
  for (const snap of latest.values()) {
    const evs = eventsFor(snap, events);
    log(`\n== ${snap.format} ${snap.periodStart}~${snap.periodEnd}: ${evs.length} events in DB`);
    for (const entry of snap.entries.filter((e) => e.count >= minCount)) {
      // Candidate placements of this archetype, best first: higher place, then later date.
      const matched = evs
        .flatMap((e) => e.placements.map((p, i) => ({ e, p, i: i + 1 })))
        .filter((x) => x.p.rank <= 4 && x.p.images.length > 0)
        .filter((x) => matchArchetype(x.p.archetype, snap.entries)?.target === entry);
      // Readability first: app deck-list screenshots are portrait; table photos (often fanned,
      // unreadable) are wide. Then better place, then later date.
      const dims = new Map<string, Dims | null>();
      for (const c of matched) dims.set(c.p.images[0]!, await imageDims(c.p.images[0]!));
      const score = (u: string) => {
        const d = dims.get(u);
        return !d ? 1 : d.h > d.w ? 0 : d.w / d.h >= 1.85 ? 2 : 1;
      };
      const cands = matched.sort((a, b) => score(a.p.images[0]!) - score(b.p.images[0]!) || a.p.rank - b.p.rank || b.e.date!.localeCompare(a.e.date!));
      const done = cands.filter((c) => existsSync(deckFile(c.e.id, c.i)) && !/status:\s*unreadable/.test(readFileSync(deckFile(c.e.id, c.i), "utf8")));
      const need = Math.max(0, per - done.length);
      const todo = cands.filter((c) => !existsSync(deckFile(c.e.id, c.i))).slice(0, need);
      log(`  ${entry.rank}. ${entry.name} (${entry.share}%): ${cands.length} lists available, ${done.length} transcribed, ${todo.length} queued`);
      for (const c of todo) {
        const image = c.p.images[0]!;
        const local = join("data", "raw", "meta", "images", `${c.e.id}-${c.i}.${image.split(".").pop()}`);
        queue.push({
          file: deckFile(c.e.id, c.i),
          image,
          local,
          label: `${snap.format} ${entry.name} ← ${c.p.rankLabel} ${c.p.archetype}@${c.p.player ?? "?"} / ${c.e.eventName} (${c.e.date})`,
        });
        if (!existsSync(deckFile(c.e.id, c.i) + ".todo"))
          writeFileSync(
            deckFile(c.e.id, c.i) + ".todo",
            formatDecklistFile(
              {
                event: c.e.id,
                placement: c.i,
                archetype: c.p.archetype,
                "meta-archetype": entry.name,
                player: c.p.player,
                format: snap.format,
                rank: c.p.rankLabel,
                date: c.e.date,
                "event-name": c.e.eventName,
                source: c.e.url,
                image,
                status: "complete",
                transcribed: "",
              },
              [],
            ),
          );
      }
    }
  }
  await pool(
    queue,
    async (q) => {
      if (existsSync(join(ROOT, q.local))) return;
      const res = await fetch(q.image, { headers: { referer: `${BASE}/`, "user-agent": "dm-card-db/0.1" } });
      if (!res.ok) throw new Error(`${res.status} ${q.image}`);
      mkdirSync(join(ROOT, "data", "raw", "meta", "images"), { recursive: true });
      writeFileSync(join(ROOT, q.local), Buffer.from(await res.arrayBuffer()));
    },
    { concurrency: 2, minIntervalMs: 300 },
  );
  writeFileSync(
    join(META_DIR, "queue.md"),
    ["# Transcription queue", "", ...queue.map((q) => `- [ ] ${q.label}\n  - image: ${q.local}\n  - write: ${q.file.replace(ROOT + "/", "")}`)].join("\n") +
      "\n",
  );
  log(`\n${queue.length} lists queued → meta/queue.md (templates: meta/decklists/*.txt.todo)`);
}

function cmdCheck() {
  const db = openDb(arg("db") ?? DEFAULT_DB_PATH);
  const resolver = new CardResolver(db);
  let bad = 0;
  const files = existsSync(DECK_DIR) ? readdirSync(DECK_DIR).filter((f) => f.endsWith(".txt")) : [];
  const fix = args.includes("--fix");
  for (const f of files.sort()) {
    const path = join(DECK_DIR, f);
    let r = checkDecklist(db, resolver, parseDecklistFile(f, readFileSync(path, "utf8")));
    // --fix: after reviewing the warnings, rewrite fuzzy/partial/loose names to the official card name.
    if (fix && r.cards.some((c) => c.cardId && c.method && c.method !== "exact")) {
      const text = readFileSync(path, "utf8");
      writeFileSync(
        path,
        formatDecklistFile(
          r.file.meta,
          r.cards.map((c) => ({ zone: c.zone, count: c.count, name: c.cardId ? c.name! : c.rawName })),
        ),
      );
      if (text !== readFileSync(path, "utf8")) log(`fixed names in ${f}`);
      r = checkDecklist(db, resolver, parseDecklistFile(f, readFileSync(path, "utf8")));
    }
    const main = r.cards.filter((c) => c.zone === "main").reduce((s, c) => s + c.count, 0);
    const mark = r.problems.length ? "✗" : "✓";
    if (r.problems.length) bad++;
    log(`${mark} ${f} [${r.file.status}] ${r.file.meta.archetype ?? ""} main=${main}${r.unknown ? ` unknown=${r.unknown}` : ""}`);
    for (const p of r.problems) log(`    - ${p}`);
  }
  log(`\n${files.length} lists, ${bad} with problems`);
  if (bad) process.exitCode = 1;
}

if (/[\\/]meta[\\/]cli\.(ts|js)$/.test(process.argv[1] ?? "")) {
  const cmd = args.find((a) => !a.startsWith("--"));
  const run =
    cmd === "fetch" ? cmdFetch : cmd === "queue" ? cmdQueue : cmd === "check" ? async () => cmdCheck() : cmd === "import-decks" ? cmdImportDecks : null;
  if (!run) {
    console.error("usage: tsx src/meta/cli.ts fetch|queue|check|import-decks [options]");
    process.exit(2);
  }
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
