import * as cheerio from "cheerio";

export interface RegulationRef {
  name: string;
  /** Printing id linked from the regulation page (resolves the card unambiguously). */
  printingId: string | null;
}

export interface Regulation {
  premium: RegulationRef[];
  restricted: RegulationRef[];
  premiumCombos: RegulationRef[][];
  premiumHyperspatialCombos: RegulationRef[][];
}

const SECTIONS: Record<string, keyof Regulation> = {
  プレミアム殿堂コンビカード: "premiumCombos",
  プレミアム殿堂超次元コンビカード: "premiumHyperspatialCombos",
  プレミアム殿堂入りカード: "premium",
  殿堂入りカード: "restricted",
};

/**
 * Parse the official 殿堂レギュレーション page. Sections are <h2> headings followed by <ul><li>
 * entries containing links to card detail pages. Commented-out sections (e.g. past 殿堂解除) are
 * ignored because cheerio does not expose comments as elements.
 */
export function parseRegulation(html: string): Regulation {
  const $ = cheerio.load(html);
  const out: Regulation = { premium: [], restricted: [], premiumCombos: [], premiumHyperspatialCombos: [] };
  let current: keyof Regulation | null = null;
  const seen = new Set<string>();

  // Walk the main content in document order.
  $("h2, li").each((_, el) => {
    const $el = $(el);
    if (el.tagName === "h2") {
      const title = $el.text().trim();
      current = SECTIONS[title] ?? null;
      return;
    }
    if (!current) return;
    const refs: RegulationRef[] = $el
      .find("a")
      .toArray()
      .map((a) => {
        const name = $(a)
          .text()
          .trim()
          .replace(/^[《≪]/, "")
          .replace(/[》≫]$/, "")
          .trim();
        const href = $(a).attr("data-href") ?? $(a).attr("href") ?? "";
        const id = href.match(/[?&]id=([^&'"]+)/)?.[1] ?? null;
        return { name, printingId: id ? decodeURIComponent(id) : null };
      })
      .filter((r) => r.name);
    if (refs.length === 0) return;
    if (current === "premiumCombos" || current === "premiumHyperspatialCombos") {
      if (refs.length >= 2) out[current].push(refs);
    } else {
      for (const r of refs) {
        const key = `${current}|${r.printingId ?? r.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out[current].push(r);
      }
    }
  });
  return out;
}
