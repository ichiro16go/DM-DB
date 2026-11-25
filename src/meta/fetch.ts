import { fetchText, pool } from "../lib/http.js";
import type { MetaRepo } from "./repo.js";
import { isRankingTitle, isResultTitle, parsePostLinks, parseRankingPost, parseResultPost, type MetaFormat, type RankingPost } from "./supersolenoid.js";

const BASE = "https://supersolenoid.jp";
const TAGS: Record<MetaFormat, string> = { original: "オリジナルCS入賞数ランキング", advance: "アドバンスCS入賞数ランキング" };

function addDays(d: string, n: number) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export interface FetchMetaResult {
  snapshots: RankingPost[];
  newSnapshots: string[];
  eventsFound: number;
  eventsSaved: number;
  failed: number;
}

/**
 * Fetch the latest `weeks` weekly rankings (both formats) and the CS result posts in those weeks.
 * Incremental: result posts already in the repo are not fetched again. Ranking posts are always
 * re-read (two tag pages + a handful of posts), so a new week appears as soon as it is published.
 */
export async function fetchMeta(repo: MetaRepo, opts: { weeks?: number; log?: (m: string) => void } = {}): Promise<FetchMetaResult> {
  const weeks = opts.weeks ?? 6;
  const log = opts.log ?? (() => {});
  const known = new Set((await repo.snapshotKeys()).map((k) => k.replace(/^meta\/snapshots\/|\.json$/g, "")));
  const snapshots: RankingPost[] = [];
  const newSnapshots: string[] = [];
  for (const format of ["original", "advance"] as MetaFormat[]) {
    const links = parsePostLinks(await fetchText(`${BASE}/?tag=${encodeURIComponent(TAGS[format])}`)).filter((l) => isRankingTitle(l.title));
    let taken = 0;
    for (const l of links) {
      if (taken >= weeks) break;
      if (/速報/.test(l.title)) continue; // 新弾発売速報版 covers a single day, not a week
      let post: RankingPost;
      try {
        post = parseRankingPost(l.url, await fetchText(l.url));
      } catch (e) {
        log(`skip ${l.url}: ${(e as Error).message}`);
        continue;
      }
      if (post.format !== format || post.flash) continue;
      const key = `${format}-${post.periodStart}`;
      if (!known.has(key)) newSnapshots.push(key);
      await repo.saveSnapshot(post);
      snapshots.push(post);
      taken++;
      log(`ranking ${key}~${post.periodEnd}: n=${post.sampleSize}, ${post.entries.length} archetypes`);
    }
  }

  // CS result posts appear up to a few days after the event: scan daily archives over each period + 4 days.
  const dates = new Set<string>();
  for (const s of snapshots) for (const d of datesBetween(s.periodStart, addDays(s.periodEnd, 4))) dates.add(d);
  const today = new Date().toISOString().slice(0, 10);
  const links = new Map<number, string>();
  await pool(
    [...dates].filter((d) => d <= today).sort(),
    async (d) => {
      // 15 entries per page: blog-date-YYYYMMDD.html, then -1.html, -2.html …
      const stem = `blog-date-${d.replace(/-/g, "")}`;
      for (let page = 0; page < 20; page++) {
        const html = await fetchText(`${BASE}/${stem}${page ? `-${page}` : ""}.html`);
        for (const l of parsePostLinks(html)) if (isResultTitle(l.title)) links.set(l.id, l.url);
        if (!html.includes(`${stem}-${page + 1}.html`)) break;
      }
    },
    { concurrency: 2, minIntervalMs: 400 },
  );
  const todo: [number, string][] = [];
  for (const [id, url] of links) if (!(await repo.hasEvent(id))) todo.push([id, url]);
  log(`result posts: ${links.size} found, ${todo.length} new`);
  let saved = 0;
  const { failed } = await pool(
    todo,
    async ([id, url]) => {
      await repo.saveEvent({ id, ...parseResultPost(url, await fetchText(url)) });
      saved++;
    },
    { concurrency: 2, minIntervalMs: 400 },
  );
  return { snapshots, newSnapshots, eventsFound: links.size, eventsSaved: saved, failed: failed.length };
}
