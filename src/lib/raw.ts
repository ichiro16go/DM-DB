import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { env } from "node:process";

/** Project root: nearest ancestor with package.json (works from src/ under tsx and from dist/ when compiled). */
function findRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start, "../..");
    dir = up;
  }
}
export const ROOT = findRoot(dirname(fileURLToPath(import.meta.url)));
/** Data directory; DM_DATA_DIR overrides it (e.g. a mounted volume or /tmp in a container). */
export const DATA_DIR = env.DM_DATA_DIR ? resolve(env.DM_DATA_DIR) : join(ROOT, "data");
export const RAW_DIR = join(DATA_DIR, "raw");
export const DEFAULT_DB_PATH = join(DATA_DIR, "dm.sqlite");
/** Writable store (meta data, decks) when DM_DATA_STORE is not set: a local directory. */
export const DEFAULT_STORE = join(DATA_DIR, "store");

export function rawPath(...parts: string[]): string {
  return join(RAW_DIR, ...parts);
}

export function rawExists(...parts: string[]): boolean {
  return existsSync(rawPath(...parts));
}

export function writeRaw(rel: string[], content: string): void {
  const p = rawPath(...rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, p.endsWith(".gz") ? gzipSync(content) : content);
}

export function readRaw(...rel: string[]): string {
  const p = rawPath(...rel);
  const buf = readFileSync(p);
  return p.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
}

export function writeRawJson(rel: string[], value: unknown): void {
  writeRaw(rel, JSON.stringify(value, null, 1));
}

export function readRawJson<T>(...rel: string[]): T {
  return JSON.parse(readRaw(...rel)) as T;
}

export function listRaw(...rel: string[]): string[] {
  const p = rawPath(...rel);
  return existsSync(p) ? readdirSync(p) : [];
}
