import { copyFile, mkdir, rename, stat } from "node:fs/promises";
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
}
