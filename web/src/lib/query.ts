// Filter form → query string in the search language (see /help). Pure, unit-tested.

export interface Filters {
  name: string;
  text: string;
  civs: string[]; // 光 水 闇 火 自然 無色
  civMode: ":" | "any" | "=" | "<=";
  civCount: "" | "単色" | "多色";
  costMin: string;
  costMax: string;
  powMin: string;
  powMax: string;
  type: string;
  race: string;
  keywords: string[];
  kwMode: "and" | "or";
  kwAlways: boolean;
  tags: string[];
  tagMode: "and" | "or";
  set: string;
  setFirst: boolean;
  illust: string;
  rarity: string;
  format: "" | "original" | "advance";
  reg: "" | "none" | "restricted" | "premium";
  is: string;
}

export const emptyFilters = (): Filters => ({
  name: "",
  text: "",
  civs: [],
  civMode: ":",
  civCount: "",
  costMin: "",
  costMax: "",
  powMin: "",
  powMax: "",
  type: "",
  race: "",
  keywords: [],
  kwMode: "and",
  kwAlways: false,
  tags: [],
  tagMode: "and",
  set: "",
  setFirst: false,
  illust: "",
  rarity: "",
  format: "",
  reg: "",
  is: "",
});

export const quote = (v: string) => (/[\s()"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);

function group(parts: string[], mode: "and" | "or") {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!;
  return mode === "or" ? `(${parts.join(" or ")})` : parts.join(" ");
}

/** A keyword chip may carry a comparison ("パワーアタッカー>=2000"); only the name part is quoted. */
function kwTerm(field: string, k: string) {
  const m = /^(.+?)(>=|<=|=|>|<)(\d+|∞)$/.exec(k.trim());
  return m ? `${field}:${quote(m[1]!)}${m[2]}${m[3]}` : `${field}:${quote(k.trim())}`;
}

export function filtersToQuery(f: Filters): string {
  const q: string[] = [];
  const t = (s: string) => s.trim();
  if (t(f.name)) q.push(quote(t(f.name)));
  if (t(f.text)) q.push(`text:${quote(t(f.text))}`);

  const colorless = f.civs.includes("無色");
  const colored = f.civs.filter((c) => c !== "無色");
  if (colored.length) {
    if (f.civMode === "any")
      q.push(
        group(
          colored.map((c) => `c:${c}`),
          "or",
        ),
      );
    else q.push(`c${f.civMode}${colored.join("")}`);
  }
  if (colorless && !(f.civMode === "<=" && colored.length)) q.push("c:無色");
  if (f.civCount) q.push(`c:${f.civCount}`);

  const num = (field: string, a: string, b: string) => {
    a = t(a);
    b = t(b);
    if (a && b && a === b) q.push(`${field}=${a}`);
    else {
      if (a) q.push(`${field}>=${a}`);
      if (b) q.push(`${field}<=${b}`);
    }
  };
  num("cost", f.costMin, f.costMax);
  num("pow", f.powMin, f.powMax);
  if (t(f.type)) q.push(`type=${quote(t(f.type))}`);
  if (t(f.race)) q.push(`race:${quote(t(f.race))}`);

  const kwField = f.kwAlways ? "kwa" : "kw";
  q.push(
    group(
      f.keywords.map((k) => kwTerm(kwField, k)),
      f.kwMode,
    ),
  );
  q.push(
    group(
      f.tags.map((x) => `tag:${x}`),
      f.tagMode,
    ),
  );

  if (t(f.set)) q.push(`${f.setFirst ? "first" : "set"}:${quote(t(f.set))}`);
  if (t(f.illust)) q.push(`illust:${quote(t(f.illust))}`);
  if (f.rarity) q.push(`rarity:${f.rarity}`);
  if (f.format) q.push(`f:${f.format}`);
  if (f.reg) q.push(`reg:${f.reg}`);
  if (f.is) q.push(`is:${f.is}`);
  return q.filter(Boolean).join(" ");
}
