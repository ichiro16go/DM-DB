/**
 * Build data/dm.sqlite from data/raw (no network access).
 *   tsx src/db/build-cli.ts [--db=path]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, DEFAULT_DB_PATH, listRaw, rawExists, readRaw, readRawJson } from "../lib/raw.js";
import type { MasterData } from "../parse/master.js";
import { buildDatabase, type BuildReport, type RawSource } from "./build.js";

export function loadRawSource(): RawSource {
  if (!rawExists("master.json")) throw new Error("data/raw/master.json not found — run `npm run crawl` first");
  const master = readRawJson<MasterData>("master.json");
  const lists = listRaw("lists").map((f) => readRawJson<{ product: string; ids: string[] }>("lists", f));
  const abilities = listRaw("abilities").map((f) => readRawJson<{ id: string; name: string; ids: string[] }>("abilities", f));
  function* details(): Generator<[string, string]> {
    for (const f of listRaw("detail")) {
      const id = decodeURIComponent(f.replace(/\.html\.gz$/, "").replace(/%([0-9a-f]{2})/g, "%$1"));
      yield [id, readRaw("detail", f)];
    }
  }
  return {
    master,
    lists,
    abilities,
    details: details(),
    regulationHtml: rawExists("regulation.html.gz") ? readRaw("regulation.html.gz") : null,
    unavailable: rawExists("detail_missing.json") ? readRawJson<string[]>("detail_missing.json") : [],
  };
}

export function renderReport(r: BuildReport): string {
  const lines = [
    "# Build report",
    "",
    `- built: ${new Date().toISOString()}`,
    `- printings: ${r.printings}`,
    `- cards (unique names): ${r.cards}`,
    `- faces: ${r.faces}`,
    `- sets: ${r.sets}`,
    `- parse errors: ${r.parseErrors}`,
    "",
    "## Quality issues",
    "",
    ...Object.entries(r.issues).map(([k, n]) => `- ${k}: ${n}`),
  ];
  if (r.keywordAgreement.length) {
    const rows = r.keywordAgreement.filter((k) => k.official > 0 || k.parsed > 0 || k.withConditional.parsed > 0);
    const tp = rows.reduce((s, k) => s + k.both, 0);
    const o = rows.reduce((s, k) => s + k.official, 0);
    const p = rows.reduce((s, k) => s + k.parsed, 0);
    const ctp = rows.reduce((s, k) => s + k.withConditional.both, 0);
    const cp = rows.reduce((s, k) => s + k.withConditional.parsed, 0);
    lines.push(
      "",
      "## Keyword extraction vs official ability filter",
      "",
      `Best reading per keyword, micro-averaged over ${rows.length} keywords: precision ${((tp / p) * 100).toFixed(1)}%, recall ${((tp / o) * 100).toFixed(1)}% (official pairs ${o}, parsed ${p}, agree ${tp}).`,
      "",
      `Plain kw=K reading for every keyword: precision ${((ctp / cp) * 100).toFixed(1)}%, recall ${((ctp / o) * 100).toFixed(1)}%.`,
      "",
      "Known definition differences: the official パワーアタッカー tag also covers any 'パワーを+N' effect; old 進化 cards (進化-…) are mostly untagged officially; サイキック・セル is a card role, not text.",
      "",
      "mode = reading of our data: kwa (printed) / kw (+conditional) / any (+given to others), exact or family (メクレイド ⊃ ジョーカーズ・メクレイド).",
      "",
      "| keyword | mode | official | parsed | agree | precision | recall |",
      "|---|---|---:|---:|---:|---:|---:|",
      ...rows
        .sort((a, b) => b.official - a.official)
        .map(
          (k) =>
            `| ${k.keyword} | ${k.mode} | ${k.official} | ${k.parsed} | ${k.both} | ${(k.precision * 100).toFixed(0)}% | ${(k.recall * 100).toFixed(0)}% |`,
        ),
    );
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1]?.endsWith("build-cli.ts") || process.argv[1]?.endsWith("build-cli.js")) {
  const dbArg = process.argv.find((a) => a.startsWith("--db="))?.split("=")[1];
  const dbPath = dbArg ?? DEFAULT_DB_PATH;
  const t0 = Date.now();
  const report = buildDatabase(loadRawSource(), dbPath, (m) => console.log(m));
  const md = renderReport(report);
  writeFileSync(join(DATA_DIR, "build-report.md"), md);
  console.log(md.split("\n## Keyword")[0]);
  console.log(`wrote ${dbPath} in ${((Date.now() - t0) / 1000).toFixed(1)}s; full report: data/build-report.md`);
}
