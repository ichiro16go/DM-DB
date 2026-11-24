import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { nfkc } from "../lib/normalize.js";

/** One side of a printed card (twinpact halves and psychic/dragheart sides are separate faces). */
export interface ParsedFace {
  name: string;
  type: string;
  civs: string[];
  rarity: string | null;
  powerText: string;
  costText: string;
  manaText: string;
  races: string[];
  illustrator: string | null;
  abilities: string[];
  flavor: string | null;
  image: string | null;
}

export type Layout = "single" | "twinpact" | "multi";

export interface ParsedPrinting {
  id: string;
  /** Name as printed in the header (twinpact: "A / B"), without the pack number. */
  name: string;
  /** e.g. "DM26RP1" */
  packCode: string | null;
  /** e.g. "1/77", "SP3/SP10", "秘1/秘5" */
  number: string | null;
  annotation: string | null;
  layout: Layout;
  faces: ParsedFace[];
  /** Products containing a card with the same name (official "同名カードが含まれる商品"). */
  sameNameProducts: { slug: string; label: string }[];
  qaUrl: string | null;
}

const clean = (s: string) =>
  s
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();

function splitList(s: string): string[] {
  return clean(s)
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Text of an element where <br> becomes a newline. */
function textWithBreaks($: cheerio.CheerioAPI, el: AnyNode): string {
  const clone = $(el).clone();
  clone.find("br").replaceWith("\n");
  return clone.text();
}

/**
 * Parse the detail section of an official card page.
 * Throws if the HTML does not contain a card.
 */
export function parseDetail(id: string, html: string): ParsedPrinting {
  const $ = cheerio.load(html);
  const blocks = $("div.cardDetail").toArray();
  if (blocks.length === 0) throw new Error(`no cardDetail in ${id}`);

  let header = "";
  let packCode: string | null = null;
  let number: string | null = null;
  let annotation: string | null = null;
  const faceHeaders: string[] = [];

  const faces: ParsedFace[] = blocks.map((block, i) => {
    const b = $(block);
    const h3 = b.find("h3.card-name").first();
    const pack = clean(h3.find("span.packname").text());
    h3.find("span.packname").remove();
    // Some headers contain <br> (two-line names): fold every whitespace run into one space.
    const faceHeader = clean(h3.text()).replace(/\s+/g, " ");
    faceHeaders.push(faceHeader);
    if (i === 0) {
      header = faceHeader;
      const m = pack.match(/^\((.*)\)$/)?.[1] ?? pack;
      const sp = m.lastIndexOf(" ");
      if (m) {
        packCode = sp > 0 ? m.slice(0, sp) : m;
        number = sp > 0 ? m.slice(sp + 1) : null;
      }
      annotation = clean(b.find("p.annotation").text()) || null;
    }
    const td = (cls: string) => clean(b.find(`td.${cls}`).first().text());
    const abilities: string[] = [];
    b.find("td.skills li").each((_, li) => {
      for (const line of textWithBreaks($, li).split("\n")) {
        const t = clean(line);
        if (t) abilities.push(t);
      }
    });
    // Some very old pages put the text directly in the cell without <li>.
    if (abilities.length === 0) {
      const cell = b.find("td.skills").first();
      if (cell.length) for (const line of textWithBreaks($, cell[0]!).split("\n")) if (clean(line)) abilities.push(clean(line));
    }
    const img = b.find("div.card-img img").attr("src") || null;
    const flavor = b.find("td.flavor").length ? clean(textWithBreaks($, b.find("td.flavor")[0]!)) || null : null;
    return {
      name: faceHeader,
      type: td("type"),
      civs: splitList(td("civil")),
      rarity: td("rarelity") || null,
      powerText: td("power"),
      costText: td("cost"),
      manaText: td("mana"),
      races: splitList(td("race")),
      illustrator: td("illusttxt") || null,
      abilities,
      flavor,
      image: img,
    };
  });

  // Layout: twinpact = every block repeats the same "A / B" header and the parts match the blocks.
  let layout: Layout = "single";
  if (faces.length > 1) {
    // Separator is usually " / " but some pages use " /" or "／".
    const parts = header.split(/\s*[/／]\s*/).map((s) => s.trim());
    const sameHeader = faceHeaders.every((h) => h === header);
    if (sameHeader && parts.length === faces.length && parts.every(Boolean)) {
      layout = "twinpact";
      faces.forEach((f, i) => (f.name = parts[i]!));
      header = parts.join(" / ");
    } else {
      layout = "multi";
    }
  }
  // Twinpact lower halves have no image / illustrator / rarity of their own: inherit.
  for (const f of faces.slice(1)) {
    if (layout === "twinpact") {
      f.illustrator ??= faces[0]!.illustrator;
      f.image ??= null;
    }
    f.rarity ??= faces[0]!.rarity;
  }

  const sameNameProducts = $("ul.productCardList a")
    .toArray()
    .map((a) => {
      const href = $(a).attr("href") ?? "";
      return { slug: href.match(/\/product\/([^/]+)\/?/)?.[1] ?? "", label: clean($(a).text()) };
    });
  const qaUrl = ($("input#qa_url").attr("value") ?? "").trim() || null;

  return {
    id,
    name: header,
    packCode,
    number,
    annotation,
    layout,
    faces,
    sameNameProducts,
    qaUrl,
  };
}

/** Parse "9000+", "∞", "1000-", "" into structured power. */
export function parsePower(text: string): { value: number | null; mod: "+" | "-" | null; infinite: boolean } {
  const t = nfkc(text);
  if (!t || t === "-") return { value: null, mod: null, infinite: false };
  if (t.includes("∞")) return { value: null, mod: t.endsWith("+") ? "+" : null, infinite: true };
  const m = t.match(/^(-?\d+)\s*([+-])?/);
  if (!m) return { value: null, mod: null, infinite: false };
  return { value: Number(m[1]), mod: (m[2] as "+" | "-" | undefined) ?? null, infinite: false };
}

/** Parse cost / mana numbers ("7", "∞", "-", ""). */
export function parseNumberField(text: string): { value: number | null; infinite: boolean } {
  const t = nfkc(text);
  if (t.includes("∞")) return { value: null, infinite: true };
  const m = t.match(/^\d+/);
  return { value: m ? Number(m[0]) : null, infinite: false };
}
