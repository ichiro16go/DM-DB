import Database from "better-sqlite3";
import { existsSync, rmSync } from "node:fs";
import { looseKey, nfkc, textKey } from "../lib/normalize.js";
import { parseDetail, parseNumberField, parsePower, type ParsedPrinting } from "../parse/detail.js";
import { BREAKER_COUNT, familiesOf, FAMILY_ROOTS, KeywordExtractor, type KeywordHit } from "../parse/keywords.js";
import type { MasterData } from "../parse/master.js";
import { parseRegulation, type RegulationRef } from "../parse/regulation.js";
import { tagAbilities, TAG_RULES } from "../parse/tags.js";
import { computeChronology } from "./chronology.js";
import { SCHEMA } from "./schema.js";

export const CIV_BITS: Record<string, number> = { 光: 1, 水: 2, 闇: 4, 火: 8, 自然: 16 };
export const CIV_ORDER = ["光", "水", "闇", "火", "自然"];
const COLORLESS = new Set(["ゼロ", "無色"]);
const INF = 1e9;

/** Everything the builder needs; produced from data/raw by loadRawSource() or from fixtures in tests. */
export interface RawSource {
  master: MasterData;
  lists: { product: string; ids: string[] }[];
  details: Iterable<[id: string, html: string]>;
  abilities: { id: string; name: string; ids: string[] }[];
  regulationHtml: string | null;
  /** Listed printings whose official detail page is empty (recorded as quality issues). */
  unavailable?: string[];
}

export interface BuildReport {
  printings: number;
  cards: number;
  faces: number;
  sets: number;
  parseErrors: number;
  issues: Record<string, number>;
  keywordAgreement: KeywordAgreement[];
}

export interface KeywordAgreement {
  keyword: string;
  /** reading of our data that agrees best with the official filter: "kwa|kw|any" / "exact|family" */
  mode: string;
  /** the plain kw=K reading (self, incl. conditional, exact), for comparison */
  withConditional: { parsed: number; both: number };
  official: number;
  parsed: number;
  both: number;
  precision: number;
  recall: number;
}

function setKind(code: string, label: string): string {
  if (code.startsWith("promo")) return "promo";
  if (/デッキ/.test(label)) return "deck";
  if (/^\S+/.test(label)) return "pack";
  return "other";
}

function splitLabel(label: string): { displayCode: string | null; name: string } {
  const m = label.match(/^([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\s+(.*)$/);
  if (m && /\d/.test(m[1]!)) return { displayCode: m[1]!, name: m[2]!.trim() };
  return { displayCode: null, name: label };
}

function civInfo(civs: string[]): { mask: number; colorless: boolean; unknown: string[] } {
  let mask = 0;
  let colorless = false;
  const unknown: string[] = [];
  for (const c of civs) {
    if (CIV_BITS[c] !== undefined) mask |= CIV_BITS[c]!;
    else if (COLORLESS.has(c)) colorless = true;
    else unknown.push(c);
  }
  return { mask, colorless: colorless || (civs.length === 0 ? false : mask === 0), unknown };
}

const popcount = (n: number) => n.toString(2).replace(/0/g, "").length;

function zoneOf(types: string[]): "main" | "hyperspatial" | "gr" {
  if (types.some((t) => /GR/.test(nfkc(t)))) return "gr";
  if (types.some((t) => /サイキック|ドラグハート|デュエルメイト/.test(t))) return "hyperspatial";
  return "main";
}

/**
 * The official pages occasionally leave a field blank on one printing (a twinpact's lower half
 * without type/civilization, a psychic side without power) or show the creature's power on the
 * spell half. Fill blanks from another printing of the same card, drop power on pure spell faces,
 * and record every repair as a quality issue.
 */
function repairFaces(canon: ParsedPrinting, group: ParsedPrinting[], issue: (kind: string, ref: string, detail: string) => void): ParsedPrinting["faces"] {
  const faces = canon.faces.map((f) => ({ ...f, civs: [...f.civs], races: [...f.races] }));
  faces.forEach((f, fi) => {
    const others = group.filter((p) => p !== canon && p.faces.length === faces.length && p.faces[fi]?.name === f.name).map((p) => p.faces[fi]!);
    const fill = <K extends "type" | "powerText" | "costText">(key: K) => {
      if (f[key]) return;
      const donor = others.find((o) => o[key]);
      if (donor) {
        f[key] = donor[key];
        issue("filled_from_other_printing", canon.name, `face ${fi} ${key} ← ${donor[key]}`);
      }
    };
    fill("type");
    fill("costText");
    if (/クリーチャー/.test(f.type)) fill("powerText");
    if (f.civs.length === 0) {
      const donor = others.find((o) => o.civs.length);
      if (donor) {
        f.civs = [...donor.civs];
        issue("filled_from_other_printing", canon.name, `face ${fi} civs ← ${donor.civs.join("/")}`);
      } else if (canon.layout === "twinpact" && fi > 0 && faces[0]!.civs.length) {
        // A twinpact's halves share the card's civilizations when the lower half is blank everywhere.
        f.civs = [...faces[0]!.civs];
        issue("filled_from_other_face", canon.name, `face ${fi} civs ← face 0`);
      }
    }
    if (!f.type && canon.layout === "twinpact" && fi === 1 && !f.powerText) {
      // 553 of 559 twinpact lower halves are spells; the blank ones read as spells too.
      f.type = "呪文";
      issue("inferred_type", canon.name, `face ${fi} type blank on every printing → 呪文`);
    }
    if (/呪文/.test(f.type) && !/クリーチャー/.test(f.type) && f.powerText) {
      issue("spell_with_power", canon.name, `face ${fi} showed power ${f.powerText}; dropped`);
      f.powerText = "";
    }
    if (/クリーチャー/.test(f.type) && !f.powerText) issue("creature_without_power", canon.name, `face ${fi} (${f.type})`);
    if (!f.type) issue("face_without_type", canon.name, `face ${fi}`);
  });
  return faces;
}

export function buildDatabase(source: RawSource, dbPath: string, log: (msg: string) => void = () => {}): BuildReport {
  if (dbPath !== ":memory:") for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
  const db = new Database(dbPath);
  db.pragma("journal_mode = OFF");
  db.pragma("synchronous = OFF");
  db.exec(SCHEMA);
  const issues: { kind: string; ref: string; detail: string }[] = [];
  const issue = (kind: string, ref: string, detail: string) => issues.push({ kind, ref, detail });

  // ---------- sets ----------
  const products = source.master.products;
  const chronology = computeChronology(products);
  const rankOf = new Map([...chronology].map(([code, c]) => [code, c.rank]));
  const insertSet = db.prepare(
    "INSERT INTO sets (code, display_code, name, label, kind, release_rank, release_year, release_estimated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const p of products) {
    const { displayCode, name } = splitLabel(p.label);
    const c = chronology.get(p.value)!;
    insertSet.run(p.value, displayCode, name, p.label, setKind(p.value, p.label), c.rank, Math.round(c.year * 10) / 10, c.estimated ? 1 : 0);
  }

  // printing id -> [product, order within product]
  const listedIn = new Map<string, { product: string; order: number }[]>();
  for (const l of source.lists) {
    l.ids.forEach((id, order) => {
      const arr = listedIn.get(id) ?? [];
      arr.push({ product: l.product, order });
      listedIn.set(id, arr);
    });
  }
  const productCodes = new Set(products.map((p) => p.value));
  function setFor(id: string): { set: string | null; order: number | null } {
    const prefix = id.split("-")[0]!.toLowerCase();
    const listed = listedIn.get(id) ?? [];
    const byPrefix = listed.find((l) => `dm${l.product}` === prefix || l.product === prefix);
    const chosen = byPrefix ?? listed[0];
    if (chosen) return { set: chosen.product, order: chosen.order };
    const guess = productCodes.has(prefix) ? prefix : productCodes.has(prefix.replace(/^dm/, "")) ? prefix.replace(/^dm/, "") : null;
    return { set: guess, order: null };
  }

  // ---------- parse all printings ----------
  const printings: (ParsedPrinting & { set: string | null; order: number | null; rank: number })[] = [];
  let parseErrors = 0;
  for (const [id, html] of source.details) {
    try {
      const p = parseDetail(id, html);
      const s = setFor(id);
      if (!s.set) issue("printing_without_set", id, p.name);
      printings.push({ ...p, set: s.set, order: s.order, rank: s.set ? rankOf.get(s.set)! : 0 });
    } catch (e) {
      parseErrors++;
      issue("parse_error", id, String(e));
    }
  }
  for (const id of source.unavailable ?? []) issue("detail_unavailable", id, "official detail page has no card data");
  log(`parsed ${printings.length} printings (${parseErrors} errors)`);

  // ---------- group into cards ----------
  const groups = new Map<string, typeof printings>();
  for (const p of printings) {
    const key = nfkc(p.name);
    const g = groups.get(key) ?? [];
    g.push(p);
    groups.set(key, g);
  }

  const extractor = new KeywordExtractor(source.master.abilities.map((a) => a.label));
  const officialIdByName = new Map(source.master.abilities.map((a) => [a.label, a.value]));

  const insertCard = db.prepare(`INSERT INTO cards (name, name_norm, layout, zone, starts_in_battle_zone, civ_mask, civ_count, colorless, civs, types, races,
      min_cost, text, text_norm, deck_limit, legal_original, legal_advance, first_set, latest_set, first_rank, latest_rank, printing_count, canonical_printing_id, qa_url)
      VALUES (@name, @name_norm, @layout, @zone, @starts_in_battle_zone, @civ_mask, @civ_count, @colorless, @civs, @types, @races,
      @min_cost, @text, @text_norm, @deck_limit, @legal_original, @legal_advance, @first_set, @latest_set, @first_rank, @latest_rank, @printing_count, @canonical_printing_id, @qa_url)`);
  const insertFace = db.prepare(`INSERT INTO faces (card_id, face_index, name, name_norm, type, is_creature, is_spell, is_evolution, civ_mask, civs,
      cost, cost_text, cost_infinite, power, power_text, power_mod, power_infinite, mana, mana_text, races, breaks, text, text_norm)
      VALUES (@card_id, @face_index, @name, @name_norm, @type, @is_creature, @is_spell, @is_evolution, @civ_mask, @civs,
      @cost, @cost_text, @cost_infinite, @power, @power_text, @power_mod, @power_infinite, @mana, @mana_text, @races, @breaks, @text, @text_norm)`);
  const insertFaceCiv = db.prepare("INSERT OR IGNORE INTO face_civs (face_id, civ) VALUES (?, ?)");
  const insertFaceRace = db.prepare("INSERT OR IGNORE INTO face_races (face_id, race, race_norm) VALUES (?, ?, ?)");
  const insertAbility = db.prepare("INSERT INTO abilities (face_id, idx, text, text_norm) VALUES (?, ?, ?, ?)");
  const insertKw = db.prepare(
    "INSERT INTO face_keywords (face_id, card_id, ability_idx, keyword, scope, conditional, value, value_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertTag = db.prepare("INSERT OR IGNORE INTO face_tags (face_id, card_id, tag, source) VALUES (?, ?, ?, 'rule')");
  const insertPrinting =
    db.prepare(`INSERT INTO printings (id, card_id, set_code, pack_code, number, rarity, illustrator, illustrator_norm, image_url, flavor, annotation, set_rank, site_order)
      VALUES (@id, @card_id, @set_code, @pack_code, @number, @rarity, @illustrator, @illustrator_norm, @image_url, @flavor, @annotation, @set_rank, @site_order)`);
  const insertPrintingFace = db.prepare("INSERT INTO printing_faces (printing_id, face_index, name, image_url, illustrator, flavor) VALUES (?, ?, ?, ?, ?, ?)");

  const printingToCard = new Map<string, number>();
  const cardIdByName = new Map<string, number>();
  const usedKeywords = new Set<string>();
  let faceCount = 0;
  const abs = (u: string | null) => (u ? (u.startsWith("http") ? u : `https://dm.takaratomy.co.jp${u}`) : null);

  const tx = db.transaction(() => {
    for (const [, group] of groups) {
      group.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
      const canon = group[0]!;
      const variantKey = (p: ParsedPrinting) => p.faces.map((f) => nfkc(f.abilities.join("\n"))).join("||");
      const canonKey = variantKey(canon);
      const variants = group.filter((p) => variantKey(p) !== canonKey);
      if (variants.length) issue("text_variant", canon.name, `${variants.length}/${group.length} printings differ from ${canon.id} (e.g. ${variants[0]!.id})`);
      if (new Set(group.map((p) => p.layout)).size > 1) issue("layout_variant", canon.name, group.map((p) => `${p.id}:${p.layout}`).join(", "));

      const faces = repairFaces(canon, group, issue);
      const allText = faces.map((f) => f.abilities.join("\n")).join("\n");
      const types = faces.map((f) => f.type);
      const zone = zoneOf(types);
      const startsInBZ = /ゲーム開始時.{0,40}バトルゾーンに/.test(nfkc(allText)) ? 1 : 0;
      let mask = 0;
      let colorless = false;
      const civs: string[] = [];
      for (const f of faces) {
        const ci = civInfo(f.civs);
        mask |= ci.mask;
        colorless ||= ci.colorless;
        for (const u of ci.unknown) issue("unknown_civ", canon.id, u);
        for (const c of f.civs) if (!civs.includes(c)) civs.push(c);
      }
      civs.sort((a, b) => ((CIV_ORDER.indexOf(a) + 99) % 99) - ((CIV_ORDER.indexOf(b) + 99) % 99));
      const races = [...new Set(faces.flatMap((f) => f.races))];
      const costs = faces.map((f) => parseNumberField(f.costText).value).filter((x): x is number => x !== null);
      const unlimited = /何枚でも/.test(nfkc(allText)) && /デッキ/.test(nfkc(allText));
      const sorted = [...group].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));

      const cardId = Number(
        insertCard.run({
          name: canon.name,
          name_norm: [looseKey(canon.name), ...faces.map((f) => looseKey(f.name))].join("|"),
          layout: canon.layout,
          zone,
          starts_in_battle_zone: startsInBZ,
          civ_mask: mask,
          civ_count: popcount(mask),
          colorless: colorless ? 1 : 0,
          civs: JSON.stringify(civs),
          types: JSON.stringify(types),
          races: JSON.stringify(races),
          min_cost: costs.length ? Math.min(...costs) : null,
          text: allText,
          text_norm: textKey(allText),
          deck_limit: unlimited ? null : 4,
          legal_original: zone === "main" && !startsInBZ ? 1 : 0,
          legal_advance: 1,
          first_set: sorted[0]!.set,
          latest_set: canon.set,
          first_rank: sorted[0]!.rank || null,
          latest_rank: canon.rank || null,
          printing_count: group.length,
          canonical_printing_id: canon.id,
          qa_url: canon.qaUrl,
        }).lastInsertRowid,
      );
      cardIdByName.set(nfkc(canon.name), cardId);

      faces.forEach((f, fi) => {
        const ci = civInfo(f.civs);
        const pw = parsePower(f.powerText);
        const cost = parseNumberField(f.costText);
        const mana = parseNumberField(f.manaText);
        const hits: KeywordHit[] = extractor.extract(f.abilities);
        const isCreature = /クリーチャー/.test(f.type);
        let breaks: number | null = null;
        if (isCreature) {
          breaks = 1;
          for (const h of hits)
            if (h.scope === "self" && !h.conditional && BREAKER_COUNT[h.keyword])
              breaks = Math.max(breaks, BREAKER_COUNT[h.keyword] === Infinity ? 99 : BREAKER_COUNT[h.keyword]!);
        }
        const text = f.abilities.join("\n");
        const faceId = Number(
          insertFace.run({
            card_id: cardId,
            face_index: fi,
            name: f.name,
            name_norm: looseKey(f.name),
            type: f.type,
            is_creature: isCreature ? 1 : 0,
            is_spell: /呪文/.test(f.type) ? 1 : 0,
            is_evolution: /進化/.test(f.type) ? 1 : 0,
            civ_mask: ci.mask,
            civs: JSON.stringify(f.civs),
            cost: cost.value,
            cost_text: f.costText,
            cost_infinite: cost.infinite ? 1 : 0,
            power: pw.value,
            power_text: f.powerText,
            power_mod: pw.mod,
            power_infinite: pw.infinite ? 1 : 0,
            mana: mana.value,
            mana_text: f.manaText,
            races: JSON.stringify(f.races),
            breaks,
            text,
            text_norm: textKey(text),
          }).lastInsertRowid,
        );
        faceCount++;
        for (const c of f.civs) insertFaceCiv.run(faceId, c);
        for (const r of f.races) insertFaceRace.run(faceId, r, looseKey(r));
        f.abilities.forEach((a, i) => insertAbility.run(faceId, i, a, textKey(a)));
        for (const h of hits) {
          usedKeywords.add(h.keyword);
          insertKw.run(faceId, cardId, h.abilityIndex, h.keyword, h.scope, h.conditional ? 1 : 0, h.value === Infinity ? INF : h.value, h.valueText);
        }
        for (const t of tagAbilities(f.abilities)) insertTag.run(faceId, cardId, t);
      });

      for (const p of group) {
        printingToCard.set(p.id, cardId);
        const f0 = p.faces[0]!;
        insertPrinting.run({
          id: p.id,
          card_id: cardId,
          set_code: p.set,
          pack_code: p.packCode,
          number: p.number,
          rarity: f0.rarity,
          illustrator: f0.illustrator,
          illustrator_norm: f0.illustrator ? looseKey(f0.illustrator) : null,
          image_url: abs(f0.image),
          flavor:
            p.faces
              .map((f) => f.flavor)
              .filter(Boolean)
              .join("\n") || null,
          annotation: p.annotation,
          set_rank: p.rank || null,
          site_order: p.order,
        });
        p.faces.forEach((f, fi) => insertPrintingFace.run(p.id, fi, f.name, abs(f.image), f.illustrator, f.flavor));
      }
    }
  });
  tx();
  log(`inserted ${groups.size} cards, ${faceCount} faces`);

  // ---------- keyword master ----------
  const insertKeyword = db.prepare("INSERT OR IGNORE INTO keywords (name, official_id) VALUES (?, ?)");
  const insertFamily = db.prepare("INSERT OR IGNORE INTO keyword_families (keyword, family) VALUES (?, ?)");
  db.transaction(() => {
    for (const a of source.master.abilities) insertKeyword.run(a.label, a.value);
    for (const k of usedKeywords) insertKeyword.run(k, officialIdByName.get(k) ?? null);
    const allNames = db.prepare("SELECT name FROM keywords").pluck().all() as string[];
    for (const k of allNames) for (const f of familiesOf(k)) insertFamily.run(k, f);
    for (const root of FAMILY_ROOTS) insertFamily.run(root, root);
  })();

  // ---------- official ability ground truth ----------
  const insertOfficial = db.prepare("INSERT OR IGNORE INTO card_official_keywords (card_id, keyword) VALUES (?, ?)");
  db.transaction(() => {
    for (const a of source.abilities) {
      for (const pid of a.ids) {
        const cid = printingToCard.get(pid);
        if (cid) insertOfficial.run(cid, a.name);
        else issue("official_keyword_unknown_printing", pid, a.name);
      }
    }
  })();
  db.exec(`UPDATE keywords SET card_count = (
      SELECT COUNT(DISTINCT card_id) FROM face_keywords fk WHERE fk.keyword = keywords.name AND fk.scope = 'self')`);

  // ---------- tags ----------
  const insertTagDef = db.prepare("INSERT INTO tags (tag, label, description) VALUES (?, ?, ?)");
  for (const r of TAG_RULES) insertTagDef.run(r.tag, r.label, r.description);

  // ---------- regulation ----------
  if (source.regulationHtml) {
    const reg = parseRegulation(source.regulationHtml);
    const resolve = (r: RegulationRef): number | null => {
      const byPrinting = r.printingId ? printingToCard.get(r.printingId) : undefined;
      if (byPrinting) return byPrinting;
      const byName = cardIdByName.get(nfkc(r.name));
      if (byName) return byName;
      issue("regulation_unresolved", r.printingId ?? "-", r.name);
      return null;
    };
    const insertReg = db.prepare("INSERT OR IGNORE INTO regulation_entries (card_id, status) VALUES (?, ?)");
    const insertCombo = db.prepare("INSERT OR IGNORE INTO regulation_combos (combo_id, kind, card_id) VALUES (?, ?, ?)");
    db.transaction(() => {
      for (const r of reg.restricted) {
        const id = resolve(r);
        if (id) insertReg.run(id, "restricted");
      }
      for (const r of reg.premium) {
        const id = resolve(r);
        if (id) insertReg.run(id, "premium");
      }
      let comboId = 0;
      for (const [kind, combos] of [
        ["premium_combo", reg.premiumCombos],
        ["premium_hyperspatial_combo", reg.premiumHyperspatialCombos],
      ] as const) {
        for (const combo of combos) {
          comboId++;
          for (const r of combo) {
            const id = resolve(r);
            if (id) insertCombo.run(comboId, kind, id);
          }
        }
      }
    })();
    for (const row of db
      .prepare("SELECT c.name FROM regulation_entries r JOIN cards c ON c.id = r.card_id GROUP BY r.card_id HAVING COUNT(*) > 1")
      .pluck()
      .all() as string[])
      issue("regulation_conflict", row, "listed as both 殿堂 and プレミアム殿堂; using プレミアム殿堂");
    db.exec(`UPDATE cards SET regulation = 'restricted', deck_limit = 1 WHERE id IN (SELECT card_id FROM regulation_entries WHERE status = 'restricted')`);
    db.exec(`UPDATE cards SET regulation = 'premium', deck_limit = 0 WHERE id IN (SELECT card_id FROM regulation_entries WHERE status = 'premium')`);
  } else {
    issue("regulation_missing", "-", "no regulation page in source");
  }

  // ---------- aggregates ----------
  db.exec(`UPDATE sets SET printing_count = (SELECT COUNT(*) FROM printings p WHERE p.set_code = sets.code)`);
  db.exec(`INSERT INTO illustrators (name, name_norm, printing_count)
           SELECT illustrator, illustrator_norm, COUNT(*) FROM printings WHERE illustrator IS NOT NULL GROUP BY illustrator`);
  for (const s of db.prepare("SELECT code, label FROM sets WHERE printing_count = 0").all() as { code: string; label: string }[])
    issue("empty_set", s.code, s.label);

  // ---------- keyword agreement vs official ----------
  const keywordAgreement: KeywordAgreement[] = [];
  if (source.abilities.length) {
    // Two ways to read our data, matching the two search forms:
    //   exact  (kw=K): cards with keyword K itself
    //   family (kw:K): cards with K or any keyword in K's family (e.g. メクレイド ⊃ ジョーカーズ・メクレイド)
    // The official filter sometimes means one, sometimes the other; we report the one that agrees
    // better and say which (mode), so the number reflects what a search actually returns.
    // Our data can be read in several ways, each matching a search form:
    //   kwa   printed (unconditional) keyword            → kwa:K
    //   kw    + keywords gained under a condition        → kw:K
    //   any   + keywords the card gives to others       → kw:K or grant:K
    // each either exact (K itself) or family-expanded (K and its family, e.g. メクレイド ⊃ ジョーカーズ・メクレイド).
    // The official filter is not consistent about which one it means (it tags most grants, but not
    // conditional self-grants), so each keyword is scored under the reading that agrees best and the
    // reading is reported (`mode`). Overall numbers for the plain kw: reading are kept as well.
    const readings: Record<string, string> = {
      kwa: "scope = 'self' AND conditional = 0",
      kw: "scope = 'self'",
      any: "scope IN ('self', 'others')",
    };
    for (const [name, where] of Object.entries(readings))
      db.exec(`CREATE TEMP TABLE r_${name}_exact AS SELECT DISTINCT keyword, card_id FROM face_keywords WHERE ${where};
               CREATE TEMP TABLE r_${name}_family AS SELECT keyword, card_id FROM r_${name}_exact
                 UNION SELECT kf.family, fk.card_id FROM face_keywords fk JOIN keyword_families kf ON kf.keyword = fk.keyword WHERE ${where.replace(/\b(scope|conditional)\b/g, "fk.$1")};
               CREATE INDEX r_${name}_exact_i ON r_${name}_exact(keyword, card_id); CREATE INDEX r_${name}_family_i ON r_${name}_family(keyword, card_id);`);
    type Row = { keyword: string; official: number; parsed: number; both: number };
    const stats = (table: string) =>
      new Map(
        (
          db
            .prepare(
              `SELECT k.name AS keyword,
                      (SELECT COUNT(*) FROM card_official_keywords o WHERE o.keyword = k.name) AS official,
                      (SELECT COUNT(*) FROM ${table} p WHERE p.keyword = k.name) AS parsed,
                      (SELECT COUNT(*) FROM card_official_keywords o JOIN ${table} p ON p.keyword = o.keyword AND p.card_id = o.card_id WHERE o.keyword = k.name) AS both
               FROM keywords k WHERE k.official_id IS NOT NULL`,
            )
            .all() as Row[]
        ).map((r) => [r.keyword, r]),
      );
    const f1 = (r: Row) => (r.official + r.parsed ? (2 * r.both) / (r.official + r.parsed) : 1);
    const modes = Object.keys(readings).flatMap((r) => [`${r}_exact`, `${r}_family`]);
    const tables = new Map(modes.map((m) => [m, stats(`r_${m}`)]));
    const kwExact = tables.get("kw_exact")!;
    for (const name of kwExact.keys()) {
      let best = "kwa_exact";
      for (const m of modes) if (f1(tables.get(m)!.get(name)!) > f1(tables.get(best)!.get(name)!) + 1e-9) best = m;
      const r = tables.get(best)!.get(name)!;
      const k = kwExact.get(name)!;
      keywordAgreement.push({
        ...r,
        mode: best.replace("_", "/"),
        precision: r.parsed ? r.both / r.parsed : r.official ? 0 : 1,
        recall: r.official ? r.both / r.official : r.parsed ? 0 : 1,
        withConditional: { parsed: k.parsed, both: k.both },
      });
    }
  }

  const insertIssue = db.prepare("INSERT INTO quality_issues (kind, ref, detail) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (const i of issues) insertIssue.run(i.kind, i.ref, i.detail);
  })();
  const setMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  setMeta.run("built_at", new Date().toISOString());
  setMeta.run("source", "https://dm.takaratomy.co.jp/card/");
  setMeta.run("keyword_agreement", JSON.stringify(keywordAgreement));
  setMeta.run("schema_version", "1");

  db.exec("ANALYZE");
  const count = (sql: string) => db.prepare(sql).pluck().get() as number;
  const report: BuildReport = {
    printings: count("SELECT COUNT(*) FROM printings"),
    cards: count("SELECT COUNT(*) FROM cards"),
    faces: count("SELECT COUNT(*) FROM faces"),
    sets: count("SELECT COUNT(*) FROM sets"),
    parseErrors,
    issues: Object.fromEntries(
      (db.prepare("SELECT kind, COUNT(*) n FROM quality_issues GROUP BY kind").all() as { kind: string; n: number }[]).map((r) => [r.kind, r.n]),
    ),
    keywordAgreement,
  };
  db.close();
  return report;
}
