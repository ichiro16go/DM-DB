import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Where the built DB and the crawl cache live between runs.
 *
 *   gs://bucket/prefix   Google Cloud Storage (Cloud Run service + update job)
 *   /some/dir            a local directory (development, tests)
 *
 * Every object has a version string (GCS generation / local mtime+size) so a reader can
 * tell cheaply whether a newer DB has been published.
 */
export interface ObjectStore {
  readonly location: string;
  /** Version of the object, or null if it does not exist. */
  version(key: string): Promise<string | null>;
  /** Download to `dest` atomically (via a temp file); returns the version downloaded. */
  download(key: string, dest: string): Promise<string>;
  upload(src: string, key: string, contentType?: string): Promise<void>;
  /** Keys (relative to the store) under a prefix, e.g. "decks/". */
  list(prefix: string): Promise<string[]>;
  /** Text content and version, or null if the object does not exist. */
  getText(key: string): Promise<{ text: string; version: string } | null>;
  /**
   * Write text. With `ifVersion` the write only succeeds if the object is still at that
   * version (`null` = must not exist yet); otherwise PreconditionFailedError. Returns the new version.
   */
  putText(key: string, text: string, opts?: { ifVersion?: string | null; contentType?: string }): Promise<string>;
  delete(key: string): Promise<void>;
}

/** Optimistic-concurrency conflict: someone else changed the object since it was read. */
export class PreconditionFailedError extends Error {
  constructor(key: string) {
    super(`object ${key} was modified by someone else`);
  }
}

export function openStore(location: string): ObjectStore {
  const m = location.match(/^gs:\/\/([^/]+)\/?(.*)$/);
  if (m) return new GcsStore(m[1]!, m[2]!.replace(/\/+$/, ""));
  return new LocalStore(resolve(location.replace(/^file:\/\//, "")));
}

class LocalStore implements ObjectStore {
  constructor(readonly location: string) {}
  private path(key: string) {
    return join(this.location, key);
  }
  async version(key: string) {
    try {
      const s = await stat(this.path(key));
      return `${s.mtimeMs}-${s.size}`;
    } catch {
      return null;
    }
  }
  async download(key: string, dest: string) {
    const v = await this.version(key);
    if (!v) throw new Error(`object not found: ${this.path(key)}`);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    await copyFile(this.path(key), tmp);
    await rename(tmp, dest);
    return v;
  }
  async upload(src: string, key: string) {
    await mkdir(dirname(this.path(key)), { recursive: true });
    const tmp = `${this.path(key)}.tmp-${process.pid}`;
    await copyFile(src, tmp);
    await rename(tmp, this.path(key));
  }
  async list(prefix: string) {
    const out: string[] = [];
    const walk = async (rel: string) => {
      let entries;
      try {
        entries = await readdir(join(this.location, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const k = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(k);
        else if (!e.name.includes(".tmp-")) out.push(k);
      }
    };
    const dir = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
    await walk(dir);
    return out.filter((k) => k.startsWith(prefix)).sort();
  }
  async getText(key: string) {
    const version = await this.version(key);
    if (!version) return null;
    return { text: await readFile(this.path(key), "utf8"), version };
  }
  // Serialise writes per key inside this process so the version check and the write are atomic.
  private locks = new Map<string, Promise<unknown>>();
  async putText(key: string, text: string, opts: { ifVersion?: string | null } = {}) {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(async () => {
      if (opts.ifVersion !== undefined && (await this.version(key)) !== opts.ifVersion) throw new PreconditionFailedError(key);
      await mkdir(dirname(this.path(key)), { recursive: true });
      const tmp = `${this.path(key)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      await writeFile(tmp, text);
      await rename(tmp, this.path(key));
      return (await this.version(key))!;
    });
    this.locks.set(
      key,
      run.catch(() => {}),
    );
    return run;
  }
  async delete(key: string) {
    await unlink(this.path(key)).catch(() => {});
  }
}

class GcsStore implements ObjectStore {
  readonly location: string;
  // Loaded lazily so local runs and tests never need the GCP client or credentials.
  private bucketPromise: Promise<import("@google-cloud/storage").Bucket> | null = null;

  constructor(
    private bucketName: string,
    private prefix: string,
  ) {
    this.location = `gs://${bucketName}/${prefix}`;
  }
  private bucket() {
    this.bucketPromise ??= import("@google-cloud/storage").then(({ Storage }) => new Storage().bucket(this.bucketName));
    return this.bucketPromise;
  }
  private name(key: string) {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }
  async version(key: string) {
    const file = (await this.bucket()).file(this.name(key));
    try {
      const [meta] = await file.getMetadata();
      return String(meta.generation);
    } catch (e) {
      if ((e as { code?: number }).code === 404) return null;
      throw e;
    }
  }
  async download(key: string, dest: string) {
    const bucket = await this.bucket();
    const [meta] = await bucket.file(this.name(key)).getMetadata();
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    // Pin the generation so a concurrent upload cannot give us a mix of two versions.
    const pinned = bucket.file(this.name(key), { generation: meta.generation as number | string | undefined });
    await pinned.download({ destination: tmp, validation: "crc32c" });
    await rename(tmp, dest);
    return String(meta.generation);
  }
  async upload(src: string, key: string, contentType?: string) {
    await (await this.bucket()).upload(src, { destination: this.name(key), resumable: true, contentType });
  }
  async list(prefix: string) {
    const base = this.prefix ? `${this.prefix}/` : "";
    const [files] = await (await this.bucket()).getFiles({ prefix: base + prefix });
    return files.map((f) => f.name.slice(base.length)).sort();
  }
  async getText(key: string) {
    const file = (await this.bucket()).file(this.name(key));
    try {
      const [meta] = await file.getMetadata();
      const pinned = (await this.bucket()).file(this.name(key), { generation: meta.generation as number | string | undefined });
      const [buf] = await pinned.download();
      return { text: buf.toString("utf8"), version: String(meta.generation) };
    } catch (e) {
      if ((e as { code?: number }).code === 404) return null;
      throw e;
    }
  }
  async putText(key: string, text: string, opts: { ifVersion?: string | null; contentType?: string } = {}) {
    const file = (await this.bucket()).file(this.name(key));
    try {
      await file.save(text, {
        resumable: false,
        contentType: opts.contentType ?? "application/json; charset=utf-8",
        // ifGenerationMatch: 0 means "only if the object does not exist yet".
        ...(opts.ifVersion !== undefined ? { preconditionOpts: { ifGenerationMatch: opts.ifVersion === null ? 0 : Number(opts.ifVersion) } } : {}),
      });
    } catch (e) {
      if ((e as { code?: number }).code === 412) throw new PreconditionFailedError(key);
      throw e;
    }
    return String(file.metadata.generation ?? (await this.version(key)));
  }
  async delete(key: string) {
    await (await this.bucket()).file(this.name(key)).delete({ ignoreNotFound: true });
  }
}
