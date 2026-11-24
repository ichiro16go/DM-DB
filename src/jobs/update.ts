/**
 * Scheduled update job (Cloud Run Job): crawl what is new on the official site, rebuild the DB,
 * check it, and publish it to the data store where the server picks it up.
 *
 *   tsx src/jobs/update.ts --store=gs://bucket/prefix [--full] [--concurrency=4]
 *   (or DM_DATA_STORE=gs://… ; DM_DATA_DIR controls the local working directory)
 *
 * Store layout:
 *   raw.tar.gz        crawl cache (so each run only fetches new detail pages)
 *   dm.sqlite         the published DB (written last = the publish point)
 *   build-report.md   report of the published DB
 *   latest.json       manifest of the published DB (counts, build time, git revision)
 *   history/<ts>/     previous builds (dm.sqlite + report) for rollback
 *   rejected/<ts>/    reports of builds that failed the quality gate
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { runCrawl } from "../crawl/crawl.js";
import { buildDatabase, type BuildReport } from "../db/build.js";
import { loadRawSource, renderReport } from "../db/build-cli.js";
import { DATA_DIR, rawExists, readRawJson } from "../lib/raw.js";
import { openStore, type ObjectStore } from "../storage/object-store.js";

const log = (message: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity: "INFO", message, ...extra }));
const warn = (message: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ severity: "WARNING", message, ...extra }));

export interface Manifest {
  builtAt: string;
  printings: number;
  cards: number;
  listed: number;
  revision: string | null;
}

/**
 * Quality gate: a build is published only if it is at least as complete as the official listing
 * and the previously published DB. Returns the reasons it must not be published (empty = OK).
 */
export function evaluateGate(report: BuildReport, listed: number, previous: Manifest | null): string[] {
  const reasons: string[] = [];
  if (report.parseErrors > 0) reasons.push(`${report.parseErrors} parse errors`);
  const unavailable = report.issues.detail_unavailable ?? 0;
  if (report.printings < listed - unavailable) reasons.push(`printings ${report.printings} < listed ${listed} - unavailable ${unavailable} (crawl incomplete)`);
  if (unavailable > 20) reasons.push(`${unavailable} official pages unavailable (site change?)`);
  if ((report.issues.regulation_unresolved ?? 0) > 0) reasons.push(`${report.issues.regulation_unresolved} regulation entries unresolved`);
  if (report.issues.empty_set) reasons.push(`${report.issues.empty_set} products without printings`);
  if (previous) {
    if (report.printings < previous.printings) reasons.push(`printings dropped ${previous.printings} → ${report.printings}`);
    if (report.cards < previous.cards) reasons.push(`cards dropped ${previous.cards} → ${report.cards}`);
  }
  const tp = report.keywordAgreement.reduce((s, k) => s + k.both, 0);
  const parsed = report.keywordAgreement.reduce((s, k) => s + k.parsed, 0);
  if (parsed > 0 && tp / parsed < 0.9) reasons.push(`keyword precision ${(tp / parsed).toFixed(3)} < 0.9 (parser broken?)`);
  return reasons;
}

function sh(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}`);
}

async function restoreCache(store: ObjectStore) {
  if (!(await store.version("raw.tar.gz"))) {
    log("no crawl cache in store: full crawl (≈1.5h)");
    return;
  }
  const tgz = join(DATA_DIR, "raw.tar.gz");
  await store.download("raw.tar.gz", tgz);
  sh("tar", ["-xzf", tgz, "-C", DATA_DIR]);
  rmSync(tgz);
  log("restored crawl cache");
}

async function saveCache(store: ObjectStore) {
  const tgz = join(DATA_DIR, "raw.tar.gz");
  sh("tar", ["-czf", tgz, "-C", DATA_DIR, "raw"]);
  await store.upload(tgz, "raw.tar.gz", "application/gzip");
  rmSync(tgz);
  log("saved crawl cache");
}

export async function runUpdate(opts: {
  store: string;
  full?: boolean;
  concurrency?: number;
  revision?: string | null;
}): Promise<{ published: boolean; reasons: string[] }> {
  const store = openStore(opts.store);
  mkdirSync(DATA_DIR, { recursive: true });
  await restoreCache(store);

  const crawl = await runCrawl({
    // Indexes are always re-fetched; detail pages only when new (or everything with --full).
    refresh: opts.full ? true : ["master", "lists", "all", "abilities", "regulation"],
    concurrency: opts.concurrency ?? 4,
  });
  await saveCache(store); // keep progress even if the build below is rejected
  if (crawl.failed) warn(`${crawl.failed} items failed to download; they will be retried next run`);

  const dbPath = join(DATA_DIR, "dm.build.sqlite");
  const report = buildDatabase(loadRawSource(), dbPath, (m) => log(m));
  const md = renderReport(report);
  const reportPath = join(DATA_DIR, "build-report.md");
  writeFileSync(reportPath, md);

  const listed = rawExists("all.json") ? readRawJson<{ ids: string[] }>("all.json").ids.length : 0;
  const previous = (await store.version("latest.json"))
    ? (await store.download("latest.json", join(DATA_DIR, "latest.prev.json")),
      JSON.parse(readFileSync(join(DATA_DIR, "latest.prev.json"), "utf8")) as Manifest)
    : null;
  const reasons = evaluateGate(report, listed, previous);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (reasons.length) {
    await store.upload(reportPath, `rejected/${stamp}/build-report.md`, "text/markdown");
    warn("build rejected by quality gate; published DB unchanged", { reasons });
    return { published: false, reasons };
  }

  const manifest: Manifest = { builtAt: new Date().toISOString(), printings: report.printings, cards: report.cards, listed, revision: opts.revision ?? null };
  const manifestPath = join(DATA_DIR, "latest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  await store.upload(dbPath, `history/${stamp}/dm.sqlite`, "application/vnd.sqlite3");
  await store.upload(reportPath, `history/${stamp}/build-report.md`, "text/markdown");
  await store.upload(reportPath, "build-report.md", "text/markdown");
  await store.upload(dbPath, "dm.sqlite", "application/vnd.sqlite3"); // publish point
  await store.upload(manifestPath, "latest.json", "application/json");
  // Keep a local copy for anyone running the server on the same machine.
  if (existsSync(dbPath)) renameSync(dbPath, join(DATA_DIR, "dm.sqlite"));
  log("published new DB", { ...manifest });
  return { published: true, reasons: [] };
}

if (process.argv[1]?.endsWith("update.ts") || process.argv[1]?.endsWith("update.js")) {
  const args = process.argv.slice(2);
  const arg = (n: string) =>
    args
      .find((a) => a.startsWith(`--${n}=`))
      ?.split("=")
      .slice(1)
      .join("=");
  const store = arg("store") ?? env.DM_DATA_STORE;
  if (!store) {
    console.error("set --store=gs://bucket/prefix or DM_DATA_STORE");
    process.exit(2);
  }
  runUpdate({
    store,
    full: args.includes("--full"),
    concurrency: Number(arg("concurrency") ?? env.DM_CRAWL_CONCURRENCY ?? 4),
    revision: env.DM_REVISION ?? null,
  })
    .then((r) => process.exit(r.published ? 0 : 1))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
