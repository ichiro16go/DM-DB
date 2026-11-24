import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

/** Project root (two levels above src/lib). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = join(ROOT, "data");
export const RAW_DIR = join(DATA_DIR, "raw");
export const DEFAULT_DB_PATH = join(DATA_DIR, "dm.sqlite");

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
