-- Reference database (read-only at runtime) built by tools/import/import-usda.mjs
-- from the official USDA FoodData Central (CC0 1.0) archives. This DB is a build
-- artifact loaded into sql.js on startup; it is never written to at runtime.
--
-- Only public-domain / CC0 data is imported. Copyrighted food-composition
-- datasets are deliberately NOT supported (see DATA_LICENSES.md).
--
-- Conventions:
--  * nutrient ids are the official USDA FoodData Central nutrient ids.
--  * amounts keep the ORIGINAL source unit (g | mg | µg | kcal | kJ | IU).
--  * missing values are NULL, never 0.

PRAGMA application_id = 0x48504C53; -- 'HPLS'
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS ref_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id           TEXT PRIMARY KEY,      -- e.g. 'usda_fdc'
  name         TEXT NOT NULL,
  short_name   TEXT,
  license      TEXT,
  license_url  TEXT,
  url          TEXT,
  retrieved_at INTEGER
);

CREATE TABLE IF NOT EXISTS dataset_versions (
  id           TEXT PRIMARY KEY,      -- e.g. 'usda_foundation_2026-04-30'
  source_id    TEXT NOT NULL REFERENCES sources(id),
  data_type    TEXT,                  -- Foundation | SR Legacy | Survey (FNDDS) | Branded
  release_date TEXT,
  description  TEXT,
  imported_at  INTEGER,
  record_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dsv_source ON dataset_versions(source_id);

CREATE TABLE IF NOT EXISTS nutrients (
  id     INTEGER PRIMARY KEY,         -- USDA nutrient id
  number TEXT,
  name   TEXT NOT NULL,
  unit   TEXT NOT NULL,               -- g | mg | µg | kcal | kJ | IU
  rank   INTEGER,
  role   TEXT NOT NULL DEFAULT 'other', -- energy|macro|liquid|vitamin|mineral|other
  code   TEXT                         -- app nutrient code (nullable for unmapped)
);
CREATE INDEX IF NOT EXISTS idx_nutrients_code ON nutrients(code);

CREATE TABLE IF NOT EXISTS food_categories (
  id          INTEGER PRIMARY KEY,    -- USDA food category id (or synthetic)
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS foods (
  fdc_id             INTEGER PRIMARY KEY,
  description        TEXT NOT NULL,
  data_type          TEXT NOT NULL,
  food_class         TEXT,
  food_category      TEXT,
  food_category_id   INTEGER,
  ndb_number         TEXT,
  publication_date   TEXT,
  source_id          TEXT NOT NULL REFERENCES sources(id),
  dataset_version_id TEXT NOT NULL REFERENCES dataset_versions(id),
  search_key         TEXT NOT NULL,
  is_historical      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_foods_search ON foods(search_key);
CREATE INDEX IF NOT EXISTS idx_foods_type   ON foods(data_type);
CREATE INDEX IF NOT EXISTS idx_foods_cat    ON foods(food_category_id);
CREATE INDEX IF NOT EXISTS idx_foods_dsv    ON foods(dataset_version_id);

CREATE TABLE IF NOT EXISTS food_nutrients (
  food_id         INTEGER NOT NULL REFERENCES foods(fdc_id),
  nutrient_id     INTEGER NOT NULL REFERENCES nutrients(id),
  amount          REAL,               -- original source unit; NULL = unknown
  derivation_code TEXT,
  derivation_desc TEXT,
  PRIMARY KEY (food_id, nutrient_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_fn_nutrient ON food_nutrients(nutrient_id);

CREATE TABLE IF NOT EXISTS food_portions (
  id           INTEGER,               -- USDA portion id (may be null)
  food_id      INTEGER NOT NULL REFERENCES foods(fdc_id),
  seq          INTEGER,
  amount       REAL,
  modifier     TEXT,
  measure_name TEXT,
  measure_abbr TEXT,
  gram_weight  REAL                   -- grams; NULL/0 means not convertible
);
CREATE INDEX IF NOT EXISTS idx_fp_food ON food_portions(food_id);
