// Shapes of the server's JSON responses (kept in sync with src/server, src/decks, src/meta).

export type Format = "original" | "advance";
export type Zone = "main" | "hyperspatial" | "gr";
export type DeckKind = "meta" | "user";
export type DeckStatus = "complete" | "partial" | "unreadable";

export interface Face {
  name: string;
  type: string;
  civs: string[];
  cost: number | null;
  costText: string | null;
  power: number | null;
  powerText: string | null;
  races: string[];
  abilities: string[];
}

export interface PrintingBrief {
  id: string;
  setCode?: string | null;
  setLabel?: string | null;
  number?: string | null;
  rarity?: string | null;
  illustrator?: string | null;
  image?: string | null;
  flavor?: string | null;
  releaseYear?: number | null;
  releaseEstimated?: boolean;
}

export interface CardItem {
  id: number;
  name: string;
  layout: string;
  zone: Zone;
  civs: string[];
  races: string[];
  minCost: number | null;
  regulation: "none" | "restricted" | "premium";
  deckLimit: number | null;
  legalOriginal: boolean;
  legalAdvance: boolean;
  printingCount: number;
  image: string | null;
  faces: Face[];
  printing?: PrintingBrief;
}

export interface SearchResult {
  query: string;
  total: number;
  page: number;
  pageSize: number;
  unique: "cards" | "prints";
  items: CardItem[];
}

export interface CardKeyword {
  keyword: string;
  scope: "self" | "others";
  conditional: boolean;
  value: number | null;
  valueText: string | null;
}

export interface CardDetail extends CardItem {
  keywords: CardKeyword[];
  officialKeywords: string[];
  tags: string[];
  printings: PrintingBrief[];
  qaUrl: string | null;
}

export interface CardMeta {
  counts: { cards: number; printings: number; sets: number; illustrators: number };
  sets: { code: string; displayCode: string | null; label: string }[];
  keywords: { name: string; cardCount: number }[];
  families: { name: string; members: number }[];
  tags: { tag: string; label: string; description: string; cardCount: number }[];
  types: { type: string; cardCount: number }[];
  races: { race: string; cardCount: number }[];
  illustrators: { name: string; printingCount: number }[];
  rarities: { rarity: string; n: number }[];
  fields: Record<string, { names: string[]; description: string; example: string }>;
}

// ------------------------------------------------------------------ decks

export interface DeckCard {
  zone: Zone;
  name: string;
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
  archetype: string;
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
  archetype: string | null;
  status: DeckStatus;
  source: DeckSource | null;
  note: string;
  cards: DeckCard[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
  revisions: DeckRevision[];
}

export interface DeckSummary {
  id: string;
  kind: DeckKind;
  name: string;
  format: Format;
  archetype: string | null;
  status: DeckStatus;
  source: DeckSource | null;
  updatedAt: string;
  cardCount: number;
}

export interface ResolvedDeckCard extends DeckCard {
  cardId: number | null;
  inputName: string;
  method: "exact" | "loose" | "partial" | "fuzzy" | null;
  candidates: string[];
  cost: number | null;
  civs: string[];
  type: string | null;
  image: string | null;
}

export interface DeckProblem {
  severity: "error" | "warning";
  message: string;
  card?: string;
}

export interface DeckAnalysis {
  cards: ResolvedDeckCard[];
  counts: { main: number; hyperspatial: number; gr: number; unknown: number };
  problems: string[];
  report: {
    valid: boolean;
    format: Format;
    counts: { main: number; hyperspatial: number; gr: number };
    problems: DeckProblem[];
    civs: Record<string, number>;
    costCurve: Record<string, number>;
  };
}

export interface DeckResponse {
  deck: Deck;
  version: string;
  analysis: DeckAnalysis;
}

// ------------------------------------------------------------------ meta (環境)

export interface SnapshotSummary {
  format: Format;
  periodStart: string;
  periodEnd: string;
  sampleSize: number;
  latestSet: string | null;
  title: string;
  url: string;
}

export interface RankingRow {
  rank: number;
  name: string;
  note: string | null;
  count: number;
  share: number;
  prev: { rank: number; share: number; count: number } | null;
  placements: number;
  withImages: number;
  decks: DeckSummary[];
}

export interface Ranking {
  snapshot: SnapshotSummary;
  previous: SnapshotSummary | null;
  weeks: string[];
  rows: RankingRow[];
  singletons: string[];
  singletonShare: number | null;
}

export interface PlacementRow {
  eventId: number;
  eventName: string | null;
  date: string | null;
  url: string;
  store: string | null;
  region: string | null;
  players: number | null;
  idx: number;
  rank: number;
  rankLabel: string;
  archetype: string;
  player: string | null;
  images: string[];
  deckId: string | null;
}

export interface EntryDetail {
  snapshot: SnapshotSummary;
  entry: { rank: number; name: string; note: string | null; count: number; share: number };
  placements: PlacementRow[];
  decks: DeckSummary[];
}
