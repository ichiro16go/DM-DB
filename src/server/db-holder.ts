import type { Database } from "better-sqlite3";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openDb } from "../search/engine.js";
import type { ObjectStore } from "../storage/object-store.js";

/**
 * Holds the read-only SQLite DB the server answers from, and swaps in a newer one
 * without a restart when the update job publishes it to the object store.
 *
 * - With no store: serves the local file (`path`).
 * - With a store: at startup downloads `key` (unless the local copy is already that version),
 *   then re-checks at most every `refreshMs` (triggered by requests, so it also works on
 *   Cloud Run where background timers are throttled). A new version is downloaded next to the
 *   old one, opened, swapped in, and the old handle is closed after in-flight requests finish.
 */
export interface DbHolderOptions {
  path: string;
  store?: ObjectStore;
  key?: string;
  refreshMs?: number;
  log?: (msg: string) => void;
}

export class DbHolder {
  private db: Database | null = null;
  private file: string | null = null;
  private _version: string | null = null;
  private lastCheck = 0;
  private checking: Promise<void> | null = null;
  private readonly key: string;
  private readonly refreshMs: number;
  private readonly log: (msg: string) => void;

  constructor(private opts: DbHolderOptions) {
    this.key = opts.key ?? "dm.sqlite";
    this.refreshMs = opts.refreshMs ?? 10 * 60_000;
    this.log = opts.log ?? (() => {});
  }

  get version(): string | null {
    return this._version;
  }

  current(): Database {
    if (!this.db) throw new Error("DB not initialised");
    return this.db;
  }

  async init(): Promise<void> {
    if (this.opts.store) {
      try {
        await this.sync();
      } catch (e) {
        if (!existsSync(this.opts.path)) throw e;
        this.log(`could not fetch DB from ${this.opts.store.location} (${String(e)}); using local ${this.opts.path}`);
      }
    }
    if (!this.db) this.open(this.opts.path, "local");
    this.lastCheck = Date.now();
  }

  /** Non-blocking: start a version check if the last one is older than refreshMs. */
  maybeRefresh(): void {
    if (!this.opts.store || this.refreshMs <= 0 || this.checking) return;
    if (Date.now() - this.lastCheck < this.refreshMs) return;
    this.lastCheck = Date.now();
    this.checking = this.sync()
      .then(() => undefined)
      .catch((e) => this.log(`DB refresh failed: ${String(e)}`))
      .finally(() => (this.checking = null));
  }

  /** Download and swap in the store's DB if its version differs from the one being served. */
  async sync(): Promise<boolean> {
    const store = this.opts.store!;
    const remote = await store.version(this.key);
    if (!remote) throw new Error(`no ${this.key} in ${store.location}`);
    if (remote === this._version) return false;
    const dest = join(dirname(this.opts.path), `${basename(this.opts.path, ".sqlite")}.${remote.replace(/[^\w-]/g, "_")}.sqlite`);
    const got = existsSync(dest) ? remote : await store.download(this.key, dest);
    this.open(dest, got);
    this.log(`serving DB version ${got} from ${store.location}`);
    return true;
  }

  private open(file: string, version: string) {
    const next = openDb(file);
    next.prepare("SELECT COUNT(*) FROM cards").get(); // fail fast on a broken file
    const prev = this.db;
    const prevFile = this.file;
    this.db = next;
    this.file = file;
    this._version = version;
    if (prev) {
      // Let requests that already hold the old handle finish, then release it and its file.
      setTimeout(() => {
        prev.close();
        if (prevFile && prevFile !== this.opts.path && prevFile !== file) safeUnlink(prevFile);
      }, 30_000).unref();
    }
    this.cleanupStale(file);
  }

  /** Remove downloaded versions other than the one being served (left by earlier processes). */
  private cleanupStale(keep: string) {
    const dir = dirname(this.opts.path);
    const stem = basename(this.opts.path, ".sqlite");
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (full === keep || full === this.opts.path) continue;
      // Downloaded versions look like "<stem>.<version>.sqlite"; delete them after in-flight use.
      if (f.startsWith(`${stem}.`) && f.endsWith(".sqlite")) safeUnlinkLater(full);
    }
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}

function safeUnlink(f: string) {
  try {
    unlinkSync(f);
  } catch {
    /* already gone */
  }
}
function safeUnlinkLater(f: string) {
  setTimeout(() => safeUnlink(f), 60_000).unref();
}
