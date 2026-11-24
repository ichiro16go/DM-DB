import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// Route fetch() through HTTPS_PROXY when present (Node's fetch ignores it by default).
setGlobalDispatcher(new EnvHttpProxyAgent());

export const BASE = "https://dm.takaratomy.co.jp";
const UA = "dm-card-db/0.1 (personal card database builder)";

export interface FetchOptions {
  method?: "GET" | "POST";
  form?: Record<string, string | string[]>;
  retries?: number;
}

function encodeForm(form: Record<string, string | string[]>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    if (Array.isArray(v)) for (const x of v) p.append(`${k}[]`, x);
    else p.append(k, v);
  }
  return p.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch text with retry + exponential backoff. Throws on final failure. */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const retries = opts.retries ?? 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: opts.method ?? (opts.form ? "POST" : "GET"),
        headers: {
          "user-agent": UA,
          ...(opts.form ? { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" } : {}),
        },
        body: opts.form ? encodeForm(opts.form) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 404) throw new HttpError(404, url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastErr = e;
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

/**
 * Run tasks with bounded concurrency and a minimum interval between task starts
 * (politeness toward the source site).
 */
export async function pool<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  {
    concurrency = 4,
    minIntervalMs = 100,
    onProgress,
  }: {
    concurrency?: number;
    minIntervalMs?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<{ failed: { item: T; error: unknown }[] }> {
  let next = 0;
  let done = 0;
  let lastStart = 0;
  const failed: { item: T; error: unknown }[] = [];
  async function run() {
    while (next < items.length) {
      const i = next++;
      const wait = lastStart + minIntervalMs - Date.now();
      lastStart = Math.max(Date.now(), lastStart + minIntervalMs);
      if (wait > 0) await sleep(wait);
      try {
        await worker(items[i]!, i);
      } catch (error) {
        failed.push({ item: items[i]!, error });
      }
      done++;
      onProgress?.(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return { failed };
}
