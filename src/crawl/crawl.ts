/**
 * Polite, resumable crawler for the official Duel Masters card database.
 *
 *   tsx src/crawl/crawl.ts [step...] [--refresh] [--concurrency=N]
 *
 * steps: master | lists | all | abilities | details | regulation | everything (default)
 *
 * --refresh            re-fetch everything for the selected steps
 * --refresh=a,b        re-fetch only those steps (e.g. --refresh=master,lists,all,abilities,regulation
 *                      after a new set: indexes are refreshed, detail pages stay incremental)
 *
 * Everything fetched is stored under data/raw/ so the DB can be rebuilt (and the
 * parser improved) without hitting the site again.
 */
import { BASE, fetchText, HttpError, pool } from "../lib/http.js";
import { rawExists, readRawJson, writeRaw, writeRawJson, listRaw } from "../lib/raw.js";
import { parseListPage, parseMaster, type MasterData } from "../parse/master.js";

const args = process.argv.slice(2);
const refreshArg = args.find((a) => a === "--refresh" || a.startsWith("--refresh="));
const refreshSteps = refreshArg?.includes("=") ? new Set(refreshArg.split("=")[1]!.split(",")) : null;
/** Whether cached raw files of `step` should be ignored. */
const refreshes = (step: string) => !!refreshArg && (refreshSteps === null || refreshSteps.has(step));
const concurrency = Number(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? 4);
const steps = args.filter((a) => !a.startsWith("--"));

const log = (...m: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...m);
const progress = (label: string) => (done: number, total: number) => {
  if (done % 200 === 0 || done === total) log(`${label}: ${done}/${total}`);
};

async function stepMaster(): Promise<MasterData> {
  if (!refreshes("master") && rawExists("master.json")) return readRawJson<MasterData>("master.json");
  const html = await fetchText(`${BASE}/card/`);
  writeRaw(["master.html.gz"], html);
  const master = parseMaster(html);
  writeRawJson(["master.json"], master);
  log(`master: ${master.products.length} products, ${master.abilities.length} abilities, ${master.illustrators.length} illustrators`);
  return master;
}

/** Fetch every page of a search and return the printing ids in site order. */
async function searchAll(form: Record<string, string>): Promise<{ ids: string[]; pages: number }> {
  const first = parseListPage(await fetchText(`${BASE}/card/`, { form: { ...form, samename: "show", pagenum: "1" } }));
  const ids = [...first.ids];
  for (let p = 2; p <= first.lastPage; p++) {
    const page = parseListPage(await fetchText(`${BASE}/card/`, { form: { ...form, samename: "show", pagenum: String(p) } }));
    ids.push(...page.ids);
  }
  return { ids: [...new Set(ids)], pages: first.lastPage };
}

async function stepLists(master: MasterData) {
  const todo = master.products.filter((p) => refreshes("lists") || !rawExists("lists", `${p.value}.json`));
  log(`lists: ${todo.length} products to fetch`);
  const { failed } = await pool(
    todo,
    async (p) => {
      const r = await searchAll({ products: p.value });
      writeRawJson(["lists", `${p.value}.json`], { product: p.value, label: p.label, ...r });
    },
    { concurrency, onProgress: progress("lists") },
  );
  report("lists", failed);
}

/** The unfiltered listing, used only as a completeness cross-check. */
async function stepAll() {
  if (!refreshes("all") && rawExists("all.json")) return;
  const first = parseListPage(await fetchText(`${BASE}/card/`, { form: { samename: "show", pagenum: "1" } }));
  const pages = Array.from({ length: first.lastPage - 1 }, (_, i) => i + 2);
  const byPage = new Map<number, string[]>([[1, first.ids]]);
  const { failed } = await pool(
    pages,
    async (p) => {
      byPage.set(p, parseListPage(await fetchText(`${BASE}/card/`, { form: { samename: "show", pagenum: String(p) } })).ids);
    },
    { concurrency, onProgress: progress("all") },
  );
  report("all", failed);
  const ids = [...byPage.keys()].sort((a, b) => a - b).flatMap((p) => byPage.get(p)!);
  writeRawJson(["all.json"], { pages: first.lastPage, ids: [...new Set(ids)] });
}

async function stepAbilities(master: MasterData) {
  const todo = master.abilities.filter((a) => refreshes("abilities") || !rawExists("abilities", `${a.value}.json`));
  log(`abilities: ${todo.length} to fetch`);
  const { failed } = await pool(
    todo,
    async (a) => {
      const r = await searchAll({ ability: a.value });
      writeRawJson(["abilities", `${a.value}.json`], { id: a.value, name: a.label, ...r });
    },
    { concurrency, onProgress: progress("abilities") },
  );
  report("abilities", failed);
}

/**
 * The site reads the raw id ("dm27+1d-001", "dmrp07-s06$"); percent-encoding "+" or "$" returns an
 * empty page. encodeURI keeps those characters while still escaping anything unsafe.
 */
export function detailIdParam(id: string): string {
  return encodeURI(id);
}

export function extractDetailSection(html: string): string | null {
  const i = html.indexOf("class='cardDetail'");
  if (i < 0) return null;
  const start = html.lastIndexOf("<section", i);
  const end = html.indexOf("</section>", i);
  if (start < 0 || end < 0) return null;
  return html.slice(start, end + "</section>".length);
}

function allKnownIds(): string[] {
  const ids = new Set<string>();
  for (const f of listRaw("lists")) for (const id of readRawJson<{ ids: string[] }>("lists", f).ids) ids.add(id);
  if (rawExists("all.json")) for (const id of readRawJson<{ ids: string[] }>("all.json").ids) ids.add(id);
  return [...ids].sort();
}

const safeName = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
export const detailFile = (id: string) => `${safeName(id)}.html.gz`;

async function stepDetails() {
  const ids = allKnownIds();
  const have = new Set(listRaw("detail"));
  const todo = ids.filter((id) => refreshes("details") || !have.has(detailFile(id)));
  log(`details: ${ids.length} known printings, ${todo.length} to fetch`);
  const missing: string[] = [];
  const { failed } = await pool(
    todo,
    async (id) => {
      try {
        const html = await fetchText(`${BASE}/card/detail/?id=${detailIdParam(id)}`);
        const section = extractDetailSection(html);
        if (!section) {
          missing.push(id);
          writeRaw(["detail_unparsed", detailFile(id)], html);
          return;
        }
        writeRaw(["detail", detailFile(id)], section);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) missing.push(id);
        else throw e;
      }
    },
    { concurrency, minIntervalMs: 60, onProgress: progress("details") },
  );
  if (missing.length) {
    log(`details: ${missing.length} pages had no card section`);
    writeRawJson(["detail_missing.json"], missing);
  }
  report("details", failed);
}

async function stepRegulation() {
  if (!refreshes("regulation") && rawExists("regulation.html.gz")) return;
  const html = await fetchText(`${BASE}/rule/regulation/`);
  writeRaw(["regulation.html.gz"], html);
  log("regulation: saved");
}

function report(step: string, failed: { item: unknown; error: unknown }[]) {
  if (!failed.length) return;
  log(`${step}: ${failed.length} FAILED (re-run to retry)`);
  for (const f of failed.slice(0, 10)) log("  ", JSON.stringify(f.item), String(f.error));
  process.exitCode = 1;
}

async function main() {
  const want = (s: string) => steps.length === 0 || steps.includes(s) || steps.includes("everything");
  const master = await stepMaster();
  if (want("regulation")) await stepRegulation();
  if (want("lists")) await stepLists(master);
  if (want("all")) await stepAll();
  if (want("details")) await stepDetails();
  if (want("abilities")) await stepAbilities(master);
  log("done");
}

// Allow importing helpers (tests) without running the crawler.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
