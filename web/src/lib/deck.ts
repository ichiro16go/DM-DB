// Deck-list helpers shared by the deck builder (pure, unit-tested).
import type { DeckCard, DeckRevision, Zone } from "../types";

export const ZONES: Zone[] = ["main", "hyperspatial", "gr"];
export const ZONE_LABEL: Record<Zone, string> = { main: "メインデッキ", hyperspatial: "超次元ゾーン", gr: "超GRゾーン" };
export const STATUS_LABEL = { complete: "完全", partial: "一部不明", unreadable: "読み取り不可" } as const;

export const total = (cards: DeckCard[], zone?: Zone) => cards.filter((c) => !zone || c.zone === zone).reduce((s, c) => s + c.count, 0);

/** Add `n` copies (negative removes); rows reaching 0 disappear. */
export function addCard(cards: DeckCard[], zone: Zone, name: string, n = 1): DeckCard[] {
  const i = cards.findIndex((c) => c.zone === zone && c.name === name);
  if (i < 0) return n > 0 ? [...cards, { zone, name, count: Math.min(n, 40) }] : cards;
  const count = Math.max(0, Math.min(40, cards[i]!.count + n));
  return count === 0 ? cards.filter((_, j) => j !== i) : cards.map((c, j) => (j === i ? { ...c, count } : c));
}

/** Merge duplicate (zone, name) rows, keeping the first row's position. */
export function normalize(cards: DeckCard[]): DeckCard[] {
  const out: DeckCard[] = [];
  for (const c of cards) {
    const prev = out.find((x) => x.zone === c.zone && x.name === c.name);
    if (prev) prev.count = Math.min(40, prev.count + c.count);
    else if (c.count > 0) out.push({ ...c });
  }
  return out;
}

/** Text form understood by /api/decks/parse (and the old validator). */
export function deckToText(cards: DeckCard[]): string {
  const lines: string[] = [];
  for (const z of ZONES) {
    const zc = cards.filter((c) => c.zone === z);
    if (!zc.length) continue;
    if (z === "hyperspatial") lines.push("", "超次元");
    if (z === "gr") lines.push("", "GR");
    for (const c of zc) lines.push(`${c.count} ${c.name}`);
  }
  return lines.join("\n").trim();
}

export interface DiffLine {
  zone: Zone;
  name: string;
  before: number;
  after: number;
}

/** What changed from `before` to `after` (per zone and card name). */
export function diffCards(before: DeckCard[], after: DeckCard[]): DiffLine[] {
  const key = (c: DeckCard) => `${c.zone}\u0000${c.name}`;
  const m = new Map<string, DiffLine>();
  for (const c of before) m.set(key(c), { zone: c.zone, name: c.name, before: c.count, after: 0 });
  for (const c of after) {
    const d = m.get(key(c));
    if (d) d.after = c.count;
    else m.set(key(c), { zone: c.zone, name: c.name, before: 0, after: c.count });
  }
  return [...m.values()].filter((d) => d.before !== d.after);
}

export const revisionSummary = (r: DeckRevision, current: DeckCard[]) => {
  const d = diffCards(r.cards, current);
  return d.length === 0 ? "カード変更なし" : `${d.length}種類のカードが変化`;
};

export const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const thumb = (url: string | null | undefined) => (url ? url.replace("/cardimage/", "/cardthumb/") : null);
export const FORMAT_LABEL = { original: "オリジナル", advance: "アドバンス" } as const;
