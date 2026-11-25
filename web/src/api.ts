import type { CardDetail, CardMeta, DeckAnalysis, DeckCard, DeckResponse, DeckSummary, EntryDetail, Format, Ranking, SearchResult } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: json !== undefined ? { "content-type": "application/json", ...rest.headers } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  let body: { error?: string; code?: string } & Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    if (!res.ok) throw new ApiError(text.slice(0, 200) || res.statusText, res.status);
  }
  if (!res.ok) throw new ApiError(body.error ?? res.statusText, res.status, body.code);
  return body as T;
}

const qs = (p: Record<string, string | number | null | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== null && v !== undefined && v !== "") u.set(k, String(v));
  return u.toString();
};

export interface DeckWrite {
  name?: string;
  format?: Format;
  archetype?: string | null;
  status?: DeckResponse["deck"]["status"];
  note?: string;
  cards?: DeckCard[];
  kind?: DeckResponse["deck"]["kind"];
  source?: DeckResponse["deck"]["source"];
}

export const api = {
  meta: () => call<CardMeta>("/api/meta"),
  search: (p: { q: string; page?: number; pageSize?: number; unique?: string; order?: string; dir?: string }) => call<SearchResult>(`/api/search?${qs(p)}`),
  card: (id: number | string) => call<CardDetail>(`/api/card/${encodeURIComponent(String(id))}`),
  quality: () =>
    call<{
      issues: { kind: string; n: number }[];
      keywordAgreement: { keyword: string; official: number; parsed: number; both: number; precision: number; recall: number }[];
    }>("/api/quality"),

  ranking: (format: Format, week?: string | null) => call<Ranking>(`/api/meta/ranking?${qs({ format, week })}`),
  entry: (format: Format, name: string, week?: string | null) => call<EntryDetail>(`/api/meta/entry?${qs({ format, name, week })}`),

  decks: (p: { kind?: string; format?: string; fresh?: boolean } = {}) =>
    call<{ decks: DeckSummary[] }>(`/api/decks?${qs({ kind: p.kind, format: p.format, fresh: p.fresh ? 1 : null })}`),
  deck: (id: string) => call<DeckResponse>(`/api/decks/${encodeURIComponent(id)}`),
  analyze: (format: Format, cards: DeckCard[]) => call<DeckAnalysis>("/api/decks/analyze", { method: "POST", json: { format, cards } }),
  parse: (text: string) => call<{ cards: DeckCard[] }>("/api/decks/parse", { method: "POST", json: { text } }),
  createDeck: (d: DeckWrite) => call<DeckResponse>("/api/decks", { method: "POST", json: d }),
  updateDeck: (id: string, version: string, d: DeckWrite) =>
    call<DeckResponse>(`/api/decks/${encodeURIComponent(id)}`, { method: "PUT", json: { ...d, version } }),
  restoreDeck: (id: string, version: string, index: number) =>
    call<DeckResponse>(`/api/decks/${encodeURIComponent(id)}/restore`, { method: "POST", json: { version, index } }),
  deleteDeck: (id: string, version: string) => call<{ ok: true }>(`/api/decks/${encodeURIComponent(id)}?${qs({ version })}`, { method: "DELETE" }),
};
