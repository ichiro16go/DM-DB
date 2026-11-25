import type { Database } from "better-sqlite3";
import { validateDeck, type DeckReport, type Format } from "../deck/validate.js";
import { homeZone, ZONES, type Zone } from "../deck/rules.js";
import { CardResolver, type ResolveMethod } from "../meta/decklist.js";

/**
 * A deck list. Two kinds share one model and one editor:
 *   meta  — a CS placement's list transcribed from the organiser's photo (source = the placement)
 *   user  — a deck built in the deck builder
 * Every save keeps the previous version in `revisions`, so a wrong correction can be undone.
 */
export type { Zone } from "../deck/rules.js";
export type DeckKind = "meta" | "user";
export type DeckStatus = "complete" | "partial" | "unreadable";

export interface DeckCard {
  zone: Zone;
  name: string; // official card name once resolved ("?" = unreadable card)
  count: number;
}

export interface DeckSource {
  eventId: number;
  placementIdx: number;
  url: string;
  image: string | null;
  eventName: string | null;
  date: string | null;
  rank: string;
  player: string | null;
  archetype: string; // as written in the CS result
}

export interface DeckRevision {
  at: string;
  by: string | null;
  name: string;
  status: DeckStatus;
  note: string;
  cards: DeckCard[];
}

export interface Deck {
  id: string;
  kind: DeckKind;
  name: string;
  format: Format;
  archetype: string | null; // deck type, for meta decks the weekly ranking's name
  status: DeckStatus;
  source: DeckSource | null;
  note: string;
  cards: DeckCard[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  revisions: DeckRevision[]; // newest first
}

/** Fields a client may set. */
export interface DeckInput {
  name?: string;
  format?: Format;
  archetype?: string | null;
  status?: DeckStatus;
  note?: string;
  cards?: DeckCard[];
  kind?: DeckKind;
  source?: DeckSource | null;
}

export const MAX_REVISIONS = 30;

export class DeckInputError extends Error {}

/** Validate and normalise client input (shape only; card legality is reported, not enforced). */
export function sanitizeInput(input: DeckInput): DeckInput {
  const out: DeckInput = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > 80) throw new DeckInputError("name は1〜80文字");
    out.name = input.name.trim();
  }
  if (input.format !== undefined) {
    if (input.format !== "original" && input.format !== "advance") throw new DeckInputError("format は original / advance");
    out.format = input.format;
  }
  if (input.status !== undefined) {
    if (!["complete", "partial", "unreadable"].includes(input.status)) throw new DeckInputError("status は complete / partial / unreadable");
    out.status = input.status;
  }
  if (input.note !== undefined) {
    if (typeof input.note !== "string" || input.note.length > 2000) throw new DeckInputError("note は2000文字まで");
    out.note = input.note;
  }
  if (input.archetype !== undefined) {
    if (input.archetype !== null && (typeof input.archetype !== "string" || input.archetype.length > 80)) throw new DeckInputError("archetype は80文字まで");
    out.archetype = input.archetype?.trim() || null;
  }
  if (input.cards !== undefined) {
    if (!Array.isArray(input.cards) || input.cards.length > 200) throw new DeckInputError("cards は200行まで");
    const merged = new Map<string, DeckCard>();
    for (const c of input.cards) {
      if (!c || !ZONES.includes(c.zone) || typeof c.name !== "string" || !c.name.trim()) throw new DeckInputError("cards の各行には zone と name が必要");
      if (!Number.isInteger(c.count) || c.count < 1 || c.count > 40) throw new DeckInputError(`「${c.name}」の枚数が不正です`);
      const key = `${c.zone}|${c.name.trim()}`;
      const prev = merged.get(key);
      merged.set(key, { zone: c.zone, name: c.name.trim(), count: (prev?.count ?? 0) + c.count });
    }
    out.cards = [...merged.values()];
  }
  if (input.kind !== undefined) {
    if (input.kind !== "meta" && input.kind !== "user") throw new DeckInputError("kind は meta / user");
    out.kind = input.kind;
  }
  if (input.source !== undefined) out.source = input.source === null ? null : sanitizeSource(input.source);
  return out;
}

function sanitizeSource(s: DeckSource): DeckSource {
  if (typeof s !== "object" || !Number.isInteger(s.eventId) || !Number.isInteger(s.placementIdx))
    throw new DeckInputError("source には eventId と placementIdx が必要");
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
  const url = str(s.url, 500) ?? "";
  if (url && !/^https:\/\//.test(url)) throw new DeckInputError("source.url は https:// で始まる URL");
  const image = str(s.image, 500);
  return {
    eventId: s.eventId,
    placementIdx: s.placementIdx,
    url,
    image: image && /^https:\/\//.test(image) ? image : null,
    eventName: str(s.eventName, 200),
    date: str(s.date, 10),
    rank: str(s.rank, 40) ?? "",
    player: str(s.player, 80),
    archetype: str(s.archetype, 80) ?? "",
  };
}

export interface ResolvedDeckCard extends DeckCard {
  cardId: number | null;
  inputName: string;
  method: ResolveMethod | null;
  candidates: string[];
  cost: number | null;
  civs: string[];
  type: string | null;
  image: string | null;
  homeZone: Zone | null; // where the card belongs (null if unknown)
}

export interface DeckAnalysis {
  cards: ResolvedDeckCard[];
  counts: Record<Zone, number> & { unknown: number };
  problems: string[]; // resolution problems (cards that could not be identified etc.)
  report: DeckReport; // construction rules for the deck's format
}

/**
 * Resolve every card name against the card DB and check construction rules.
 * Unresolved names are kept as typed so nothing is lost; they are listed in `problems`.
 */
export function analyzeDeck(db: Database, resolver: CardResolver, deck: Pick<Deck, "format" | "cards">): DeckAnalysis {
  const info = db.prepare(
    `SELECT c.id, c.name, c.civs, c.min_cost AS cost, f.type, c.zone, c.starts_in_battle_zone AS sbz,
            (SELECT image_url FROM printings p WHERE p.id = c.canonical_printing_id) AS image
     FROM cards c JOIN faces f ON f.card_id = c.id AND f.face_index = 0 WHERE c.id = ?`,
  );
  const problems: string[] = [];
  const cards: ResolvedDeckCard[] = deck.cards.map((c) => {
    if (c.name === "?")
      return { ...c, inputName: "?", cardId: null, method: null, candidates: [], cost: null, civs: [], type: null, image: null, homeZone: null };
    const r = resolver.resolve(c.name);
    if (!r.cardId) problems.push(`「${c.name}」を特定できません${r.candidates.length ? `（候補: ${r.candidates.slice(0, 5).join(" / ")}）` : ""}`);
    const row = r.cardId
      ? (info.get(r.cardId) as { name: string; civs: string; cost: number | null; type: string; image: string | null; zone: string; sbz: number })
      : null;
    return {
      zone: c.zone,
      count: c.count,
      name: row?.name ?? c.name,
      inputName: c.name,
      cardId: r.cardId,
      method: r.method,
      candidates: r.method === "exact" ? [] : r.candidates,
      cost: row?.cost ?? null,
      civs: row ? JSON.parse(row.civs) : [],
      type: row?.type ?? null,
      image: row?.image ?? null,
      homeZone: row ? homeZone(row.zone, !!row.sbz) : null,
    };
  });
  const sum = (z: Zone) => cards.filter((c) => c.zone === z).reduce((s, c) => s + c.count, 0);
  const byZone = (z: Zone) => cards.filter((c) => c.zone === z && c.cardId).map((c) => ({ name: c.name, count: c.count }));
  const report = validateDeck(db, {
    format: deck.format,
    main: byZone("main"),
    hyperspatial: byZone("hyperspatial"),
    gr: byZone("gr"),
    special: byZone("special"),
  });
  // The rule check only sees identified cards; report the true main-deck size including unknown ones.
  const unknown = cards.filter((c) => !c.cardId).reduce((s, c) => s + c.count, 0);
  if (unknown) {
    const main = sum("main");
    report.problems = report.problems
      .filter((p) => !/40枚ちょうど/.test(p.message) || main !== 40)
      .map((p) =>
        /40枚ちょうど/.test(p.message)
          ? { ...p, message: p.message.replace(/（現在\s*\d+\s*枚）/, `（現在 ${main} 枚、うち特定できないカード ${unknown} 枚）`) }
          : p,
      );
  }
  const counts = Object.fromEntries(ZONES.map((z) => [z, sum(z)])) as Record<Zone, number>;
  return { cards, counts: { ...counts, unknown }, problems, report };
}
