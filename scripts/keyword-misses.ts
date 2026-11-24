/**
 * Show cards the official ability filter tags with a keyword that our extractor missed (or added).
 *   tsx scripts/keyword-misses.ts <keyword> [limit] [--extra]
 */
import { openDb } from "../src/search/engine.js";

const [kw, limitArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const extra = process.argv.includes("--extra");
const db = openDb();
const sql = extra
  ? `SELECT DISTINCT c.id, c.name, c.text FROM face_keywords fk JOIN cards c ON c.id = fk.card_id
     WHERE fk.keyword = ? AND fk.scope = 'self' AND c.id NOT IN (SELECT card_id FROM card_official_keywords WHERE keyword = ?) LIMIT ?`
  : `SELECT c.id, c.name, c.text FROM card_official_keywords o JOIN cards c ON c.id = o.card_id
     WHERE o.keyword = ? AND c.id NOT IN (SELECT card_id FROM face_keywords WHERE keyword = ? AND scope = 'self') LIMIT ?`;
for (const r of db.prepare(sql).all(kw, kw, Number(limitArg ?? 5)) as { name: string; text: string }[]) {
  const lines = r.text.split("\n").filter((l) => l.includes(kw!.slice(0, 4)) || !extra);
  console.log(`- ${r.name}\n    ${lines.slice(0, 4).join("\n    ")}`);
}
