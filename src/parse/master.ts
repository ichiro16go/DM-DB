import * as cheerio from "cheerio";

export interface Option {
  value: string;
  label: string;
}

export interface MasterData {
  products: Option[]; // newest first, as listed on the official site
  abilities: Option[]; // official keyword-ability filter (id -> name)
  races: Option[];
  illustrators: Option[];
  rarities: Option[];
  cardTypes: Option[];
  formats: Option[];
}

/** Parse the select boxes of the official card-search form. */
export function parseMaster(html: string): MasterData {
  const $ = cheerio.load(html);
  const form = $("form#search_cond");
  const opts = (name: string): Option[] =>
    form
      .find(`select[name="${name}"] option`)
      .toArray()
      .map((o) => ({ value: $(o).attr("value") ?? "", label: $(o).text().trim() }))
      .filter((o) => o.value !== "");
  return {
    products: opts("products"),
    abilities: opts("ability"),
    races: opts("race"),
    illustrators: opts("illustauthor"),
    rarities: opts("rarity"),
    cardTypes: opts("cardtype"),
    formats: opts("format"),
  };
}

/** Extract printing ids (e.g. "dm26rp1-001") and the last page number from a list response. */
export function parseListPage(html: string): { ids: string[]; lastPage: number } {
  const ids: string[] = [];
  const seen = new Set<string>();
  const cardlist = html.slice(Math.max(0, html.indexOf('id="cardlist"')));
  for (const m of cardlist.matchAll(/data-href='\/card\/detail\/\?id=([^']+)'><img/g)) {
    const id = decodeURIComponent(m[1]!);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  let lastPage = 1;
  for (const m of cardlist.matchAll(/data-page="(\d+)"/g)) lastPage = Math.max(lastPage, Number(m[1]));
  return { ids, lastPage };
}
