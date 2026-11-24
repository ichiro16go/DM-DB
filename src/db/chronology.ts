import type { Option } from "../parse/master.js";

/**
 * Release chronology of products.
 *
 * The official product list is NOT one timeline: indices 0..~262 are the main line in
 * release order (newest first: DM26-… down to DM-01, with packs/decks interleaved), followed by
 * category blocks (old DMC decks, DMBD/DMSD 01-04, DMD decks, 神アート, コロコロ付録, プロモ N期)
 * that are each newest-first but out of place.
 *
 * We assign every product an estimated release year (fractional):
 *   1. "backbone" = the leading run of the list; years come from anchors (DMyy-* codes are exact,
 *      plus a few well-known era starts) and are interpolated by position in between.
 *   2. Off-backbone products of a numbered family (DMC-41, DMX-03, DMBD-02…) are interpolated by
 *      their number against same-family products that are on the backbone.
 *   3. Families with no backbone members use explicit ranges (DMD-01..35 = 2011-2016, 神アート…).
 *   4. プロモ / コロコロ "N期" → 期 N ≈ year 2001 + N (1期 = 2002).
 * release_rank is then the order by (year, backbone position).
 */

export interface Chronology {
  year: number;
  /** false when the year comes from the product code itself (DM24-RP1 → 2024) */
  estimated: boolean;
  rank: number;
}

/** Well-known era starts on the main line (code → year). */
const ANCHORS: Record<string, number> = {
  "DM-01": 2002.4,
  "DM-10": 2004.2,
  "DM-19": 2006.2,
  "DM-28": 2008.2,
  "DM-36": 2010.2,
  "DMR-01": 2011.2,
  "DMR-17": 2015.2,
  "DMRP-01": 2017.2,
  "DMRP-05": 2018.2,
  "DMRP-09": 2019.2,
  "DMRP-13": 2020.2,
  "DMRP-17": 2021.2,
};

/** Families with no member on the backbone: number range → year range. */
const FAMILY_RANGES: Record<string, [number, number, number, number]> = {
  // family: [firstNo, lastNo, firstYear, lastYear]
  DMD: [1, 35, 2011.2, 2016.8],
  DMART: [1, 26, 2021.0, 2026.8],
  DMART極: [1, 3, 2025.8, 2026.8],
};

function codeOf(label: string): string {
  return label.split(/\s+/)[0] ?? "";
}

function familyAndNumber(code: string): { family: string; no: number } | null {
  const m = code.match(/^([A-Z]+極?)-(\d+)/);
  return m ? { family: m[1]!, no: Number(m[2]) } : null;
}

const isOffBackbone = (p: Option) => /^(art|gum|spdeck|corocoro|promo)/.test(p.value);

export function computeChronology(products: Option[]): Map<string, Chronology> {
  // 1) backbone = leading run until the first category block (DMC-21 / BD-04 / … after DM-01)
  const dm01 = products.findIndex((p) => codeOf(p.label) === "DM-01");
  const backboneEnd = dm01 >= 0 ? dm01 : products.findIndex(isOffBackbone) - 1;
  const backbone = products.slice(0, backboneEnd + 1);

  const anchorAt: { idx: number; year: number }[] = [];
  backbone.forEach((p, idx) => {
    const code = codeOf(p.label);
    const yy = code.match(/^DM(\d{2})-/);
    if (yy) anchorAt.push({ idx, year: 2000 + Number(yy[1]) + 0.5 });
    else if (ANCHORS[code] !== undefined) anchorAt.push({ idx, year: ANCHORS[code]! });
  });
  anchorAt.sort((a, b) => a.idx - b.idx);
  const yearAtIndex = (idx: number): number => {
    // list is newest-first: larger idx = older
    const after = anchorAt.filter((a) => a.idx <= idx).pop();
    const before = anchorAt.find((a) => a.idx >= idx);
    if (after && before && after.idx !== before.idx) return after.year + ((before.year - after.year) * (idx - after.idx)) / (before.idx - after.idx);
    return (after ?? before)?.year ?? 2002;
  };

  const out = new Map<string, Chronology>();
  const backboneFamily = new Map<string, { no: number; year: number }[]>();
  backbone.forEach((p, idx) => {
    const code = codeOf(p.label);
    const exact = /^DM\d{2}-/.test(code);
    const year = yearAtIndex(idx);
    out.set(p.value, { year, estimated: !exact, rank: 0 });
    const fn = familyAndNumber(code);
    if (fn) backboneFamily.set(fn.family, [...(backboneFamily.get(fn.family) ?? []), { no: fn.no, year }]);
  });

  // 2-4) everything else
  for (const p of products.slice(backboneEnd + 1)) {
    const code = codeOf(p.label);
    let year: number | null = null;
    const ki = p.label.match(/(\d+)期/) ?? p.value.match(/^(?:promoy|corocoroy)(\d+)$/);
    if (/^promoy/.test(p.value) && ki) year = 2001.8 + Number(ki[1]);
    else if (/^corocoroy(\d+)$/.test(p.value)) year = 2001.8 + Number(p.value.replace("corocoroy", ""));
    else if (/^spdeck(\d+)$/.test(p.value)) year = 2020 + (Number(p.value.replace("spdeck", "")) - 6) * 0.8;
    else if (/^gum/.test(p.value)) year = 2022.5;
    else {
      const fn = familyAndNumber(code);
      if (fn) {
        const range = FAMILY_RANGES[fn.family];
        const members = (backboneFamily.get(fn.family) ?? []).sort((a, b) => a.no - b.no);
        if (members.length >= 2) {
          const lo = [...members].reverse().find((m) => m.no <= fn.no);
          const hi = members.find((m) => m.no >= fn.no);
          if (lo && hi && lo.no !== hi.no) year = lo.year + ((hi.year - lo.year) * (fn.no - lo.no)) / (hi.no - lo.no);
          else if (lo && hi) year = lo.year;
          else if (!lo) year = members[0]!.year - 0.1 * (members[0]!.no - fn.no);
          else year = members[members.length - 1]!.year + 0.1 * (fn.no - members[members.length - 1]!.no);
        } else if (range) {
          const [n0, n1, y0, y1] = range;
          year = y0 + ((y1 - y0) * (fn.no - n0)) / Math.max(1, n1 - n0);
        }
      }
    }
    out.set(p.value, { year: year ?? 2010, estimated: true, rank: 0 });
  }

  // rank: oldest = 1. Ties broken by original list order (later in list = older).
  const order = products.map((p, i) => ({ v: p.value, y: out.get(p.value)!.year, i })).sort((a, b) => a.y - b.y || b.i - a.i);
  order.forEach((o, k) => (out.get(o.v)!.rank = k + 1));
  return out;
}
