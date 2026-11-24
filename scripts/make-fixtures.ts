/** Fetch a fixed set of real card pages into test/fixtures (used by the unit tests). */
import { writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, fetchText } from "../src/lib/http.js";
import { detailIdParam, extractDetailSection } from "../src/crawl/crawl.js";
import { RAW_DIR, ROOT } from "../src/lib/raw.js";

export const FIXTURE_IDS = [
  "dm26rp1-001",
  "dm26bd1-004",
  "dm26ex4-016",
  "dm25bd3-008",
  "dm26ex4-060",
  "dm01-001",
  "dm26ex5-S003",
  "dm26rp3-035",
  "dm22ex2-036",
  "dm26rp2-071",
  "dm25rp1-072",
  "dm26ex4-014",
  "dm26bd1-SP004",
  "dm26ex4-038",
  "dm26ex4-022",
  "dm26ex4-001",
  "dm26bd1-ex015",
  "dm26bd1-SP003",
];

const dir = join(ROOT, "test/fixtures/detail");
mkdirSync(dir, { recursive: true });
for (const id of FIXTURE_IDS) {
  const html = await fetchText(`${BASE}/card/detail/?id=${detailIdParam(id)}`);
  const s = extractDetailSection(html);
  if (!s) throw new Error(`no section for ${id}`);
  writeFileSync(join(dir, `${id}.html`), s);
}
copyFileSync(join(RAW_DIR, "regulation.html.gz"), join(ROOT, "test/fixtures/regulation.html.gz"));
copyFileSync(join(RAW_DIR, "master.json"), join(ROOT, "test/fixtures/master.json"));
console.log(`saved ${FIXTURE_IDS.length} fixtures`);
