import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDatabase, type BuildReport, type RawSource } from "../../src/db/build.js";
import { openDb } from "../../src/search/engine.js";
import type { MasterData } from "../../src/parse/master.js";

export const FIXTURES = join(import.meta.dirname, "..", "fixtures");

export function fixtureHtml(id: string): string {
  return readFileSync(join(FIXTURES, "detail", `${id}.html`), "utf8");
}

export function fixtureMaster(): MasterData {
  return JSON.parse(readFileSync(join(FIXTURES, "master.json"), "utf8"));
}

export function fixtureRegulation(): string {
  return gunzipSync(readFileSync(join(FIXTURES, "regulation.html.gz"))).toString("utf8");
}

export function fixtureSource(): RawSource {
  const ids = readdirSync(join(FIXTURES, "detail")).map((f) => f.replace(/\.html$/, ""));
  return {
    master: fixtureMaster(),
    lists: [],
    details: ids.map((id) => [id, fixtureHtml(id)] as [string, string]),
    // A tiny slice of "official" ability data, enough to exercise the agreement report.
    abilities: [
      { id: "1", name: "パワーアタッカー", ids: ["dm26rp2-071", "dm26bd1-ex015", "dm25rp1-072"] },
      { id: "204", name: "ジャストダイバー", ids: ["dm26ex5-S003", "dm26ex4-022"] },
    ],
    regulationHtml: fixtureRegulation(),
  };
}

/** Build a DB from the fixtures into a temp file and open it read-only. */
export function buildFixtureDb(): { db: ReturnType<typeof openDb>; report: BuildReport; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "dmdb-"));
  const path = join(dir, "fixture.sqlite");
  const report = buildDatabase(fixtureSource(), path);
  return { db: openDb(path), report, path };
}
