/**
 * SQLite schema.
 *
 *   card      — logical card (same name = same card for deck rules). Search results are cards by default.
 *   face      — one side: twinpact halves, psychic/dragheart sides. Stats live here.
 *   printing  — one physical print (set + collector number + illustration). "絵柄違い" = several printings.
 *
 * Every *_norm column is produced by src/lib/normalize.ts; the search engine applies the
 * same normalization to user input.
 */
export const SCHEMA = /* sql */ `
PRAGMA foreign_keys = ON;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sets (
  code          TEXT PRIMARY KEY,          -- official product slug, e.g. "26rp1", "promoy5"
  display_code  TEXT,                      -- "DM26-RP1"
  name          TEXT NOT NULL,             -- product name without the code
  label         TEXT NOT NULL,             -- official label "DM26-RP1 逆札篇 第1弾 …"
  kind          TEXT NOT NULL,             -- pack | deck | promo | other
  release_rank  INTEGER NOT NULL,          -- 1 = oldest (see src/db/chronology.ts)
  release_year  REAL NOT NULL,             -- estimated release year (e.g. 2015.2)
  release_estimated INTEGER NOT NULL,      -- 0 when the year is printed in the code (DM24-RP1)
  printing_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE cards (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,      -- twinpact: "A / B"
  name_norm     TEXT NOT NULL,             -- looseKey(name) + looseKey(each face name)
  layout        TEXT NOT NULL,             -- single | twinpact | multi (psychic/dragheart sides…)
  zone          TEXT NOT NULL,             -- main | hyperspatial | gr
  starts_in_battle_zone INTEGER NOT NULL DEFAULT 0, -- 禁断の鼓動 / 零龍星雲 etc. (not usable in オリジナル)
  civ_mask      INTEGER NOT NULL,          -- union over faces: 光1 水2 闇4 火8 自然16
  civ_count     INTEGER NOT NULL,
  colorless     INTEGER NOT NULL,          -- ゼロ文明 / 無色
  civs          TEXT NOT NULL,             -- JSON array (display order)
  types         TEXT NOT NULL,             -- JSON array of face types
  races         TEXT NOT NULL,             -- JSON array union
  min_cost      INTEGER,
  text          TEXT NOT NULL,             -- all faces' ability text, newline separated
  text_norm     TEXT NOT NULL,
  regulation    TEXT NOT NULL DEFAULT 'none',  -- none | restricted (殿堂) | premium (プレミアム殿堂)
  deck_limit    INTEGER,                   -- 4 normally, 1 殿堂, 0 プレ殿, NULL = no limit (何枚でも)
  legal_original INTEGER NOT NULL,         -- usable in オリジナル (ignoring 殿堂)
  legal_advance  INTEGER NOT NULL,         -- usable in アドバンス (ignoring 殿堂)
  first_set     TEXT REFERENCES sets(code),
  latest_set    TEXT REFERENCES sets(code),
  first_rank    INTEGER,
  latest_rank   INTEGER,
  printing_count INTEGER NOT NULL DEFAULT 0,
  canonical_printing_id TEXT,              -- printing whose text/stats are stored on the faces
  qa_url        TEXT
);

CREATE TABLE faces (
  id            INTEGER PRIMARY KEY,
  card_id       INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  face_index    INTEGER NOT NULL,
  name          TEXT NOT NULL,
  name_norm     TEXT NOT NULL,
  type          TEXT NOT NULL,             -- "クリーチャー", "進化クリーチャー", "呪文", "サイキック・クリーチャー", …
  is_creature   INTEGER NOT NULL,
  is_spell      INTEGER NOT NULL,
  is_evolution  INTEGER NOT NULL,
  civ_mask      INTEGER NOT NULL,
  civs          TEXT NOT NULL,
  cost          INTEGER,
  cost_text     TEXT NOT NULL,
  cost_infinite INTEGER NOT NULL DEFAULT 0,
  power         INTEGER,
  power_text    TEXT NOT NULL,
  power_mod     TEXT,                      -- '+' for "9000+", '-' for "1000-"
  power_infinite INTEGER NOT NULL DEFAULT 0,
  mana          INTEGER,
  mana_text     TEXT NOT NULL,
  races         TEXT NOT NULL,             -- JSON array
  breaks        INTEGER,                   -- shields broken by an unconditional self breaker (creatures default 1); 99 = ワールド/∞
  text          TEXT NOT NULL,
  text_norm     TEXT NOT NULL,
  UNIQUE (card_id, face_index)
);
CREATE INDEX faces_card ON faces(card_id);
CREATE INDEX faces_cost ON faces(cost);
CREATE INDEX faces_power ON faces(power);

CREATE TABLE face_civs  (face_id INTEGER NOT NULL REFERENCES faces(id) ON DELETE CASCADE, civ TEXT NOT NULL, PRIMARY KEY (face_id, civ));
CREATE TABLE face_races (face_id INTEGER NOT NULL REFERENCES faces(id) ON DELETE CASCADE, race TEXT NOT NULL, race_norm TEXT NOT NULL, PRIMARY KEY (face_id, race));
CREATE INDEX face_races_race ON face_races(race);

CREATE TABLE abilities (
  id        INTEGER PRIMARY KEY,
  face_id   INTEGER NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL,
  text      TEXT NOT NULL,
  text_norm TEXT NOT NULL
);
CREATE INDEX abilities_face ON abilities(face_id);

CREATE TABLE keywords (
  name         TEXT PRIMARY KEY,           -- official spelling
  official_id  TEXT,                       -- id in the official ability filter
  card_count   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE keyword_families (
  keyword TEXT NOT NULL,
  family  TEXT NOT NULL,                   -- kw:<family> matches every keyword in it
  PRIMARY KEY (keyword, family)
);
CREATE INDEX keyword_families_family ON keyword_families(family);

CREATE TABLE face_keywords (
  face_id     INTEGER NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
  card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  ability_idx INTEGER NOT NULL,
  keyword     TEXT NOT NULL,
  scope       TEXT NOT NULL,               -- self | others | ref
  conditional INTEGER NOT NULL,            -- 0 printed keyword, 1 gained under a condition
  value       REAL,                        -- numeric parameter (パワーアタッカー+1000 → 1000); 1e9 = ∞
  value_text  TEXT                         -- textual parameter (革命チェンジ：<condition>)
);
CREATE INDEX face_keywords_kw ON face_keywords(keyword, scope);
CREATE INDEX face_keywords_card ON face_keywords(card_id, keyword, scope);

-- Ground truth from the official site's ability filter (card has keyword according to the site).
CREATE TABLE card_official_keywords (
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  PRIMARY KEY (card_id, keyword)
);
CREATE INDEX card_official_keywords_kw ON card_official_keywords(keyword);

CREATE TABLE tags (
  tag         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT NOT NULL
);
CREATE TABLE face_tags (
  face_id INTEGER NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  source  TEXT NOT NULL DEFAULT 'rule',    -- rule | human | llm
  PRIMARY KEY (face_id, tag)
);
CREATE INDEX face_tags_tag ON face_tags(tag);
CREATE INDEX face_tags_card ON face_tags(card_id, tag);

CREATE TABLE printings (
  id            TEXT PRIMARY KEY,          -- official detail id, e.g. "dm26rp1-001"
  card_id       INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  set_code      TEXT REFERENCES sets(code),
  pack_code     TEXT,                      -- printed code, e.g. "DM26RP1"
  number        TEXT,                      -- collector number "1/77"
  rarity        TEXT,
  illustrator   TEXT,
  illustrator_norm TEXT,
  image_url     TEXT,
  flavor        TEXT,
  annotation    TEXT,
  set_rank      INTEGER,
  site_order    INTEGER                    -- order within its product list on the official site
);
CREATE INDEX printings_card ON printings(card_id);
CREATE INDEX printings_set ON printings(set_code);
CREATE INDEX printings_illust ON printings(illustrator_norm);

CREATE TABLE printing_faces (
  printing_id TEXT NOT NULL REFERENCES printings(id) ON DELETE CASCADE,
  face_index  INTEGER NOT NULL,
  name        TEXT NOT NULL,
  image_url   TEXT,
  illustrator TEXT,
  flavor      TEXT,
  PRIMARY KEY (printing_id, face_index)
);

CREATE TABLE illustrators (
  name       TEXT PRIMARY KEY,
  name_norm  TEXT NOT NULL,
  printing_count INTEGER NOT NULL
);

CREATE TABLE regulation_entries (
  card_id  INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  status   TEXT NOT NULL,                  -- restricted | premium
  PRIMARY KEY (card_id, status)
);
CREATE TABLE regulation_combos (
  combo_id INTEGER NOT NULL,
  kind     TEXT NOT NULL,                  -- premium_combo | premium_hyperspatial_combo
  card_id  INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  PRIMARY KEY (combo_id, card_id)
);

CREATE TABLE quality_issues (
  kind   TEXT NOT NULL,
  ref    TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX quality_issues_kind ON quality_issues(kind);
`;
