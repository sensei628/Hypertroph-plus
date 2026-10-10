-- hypertroph+ schema v1 (base model)
-- Conventions: TEXT UUID PKs, UTC epoch-ms timestamps, fixed-point nutrient
-- amounts (amount_milli = amount * 1000), NULL = unknown (never 0).
-- NOTE: this base model uses a normalized `search_key` + LIKE search.
-- The Tauri build uses SQLite FTS5 (unicode61, remove_diacritics) instead.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  checksum   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  license        TEXT NOT NULL,
  license_url    TEXT,
  attribution    TEXT,
  redistribution TEXT,
  pack_version   TEXT,
  retrieved_at   INTEGER
);

CREATE TABLE IF NOT EXISTS nutrients (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  unit          TEXT NOT NULL CHECK (unit IN ('kcal','g','mg','ug','iu')),
  kind          TEXT NOT NULL CHECK (kind IN ('macro','energy','micro','fatty_acid','other')),
  display_order INTEGER NOT NULL DEFAULT 0,
  targetable    INTEGER NOT NULL DEFAULT 0 CHECK (targetable IN (0,1))
);

-- Food taxonomy. Vocabulary-only: rows are created from real catalogue data
-- only (see migrations v5/v6 backfills); NULL stays NULL (never inferred).
CREATE TABLE IF NOT EXISTS food_types (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Blood-key-taxonomy: food type / preparation / entry-kind are three
-- independent classification axes. `category` is kept as legacy free-text
-- provenance; `food_type_id` is the normalized taxonomy.
CREATE TABLE IF NOT EXISTS foods (
  id                 TEXT PRIMARY KEY,
  canonical_name     TEXT NOT NULL,
  search_key         TEXT NOT NULL,
  brand              TEXT,
  category           TEXT,
  food_type_id       TEXT REFERENCES food_types(id),
  entry_type         TEXT CHECK (entry_type IN ('generic','prepared','branded','custom')),
  manufacturer       TEXT,
  product_variant    TEXT,
  barcode            TEXT,
  serving_description TEXT,
  prep_state         TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (prep_state IN ('raw','cooked','boiled','steamed','roasted','fried','baked','dried','canned','frozen','as_sold','prepared','unknown')),
  basis              TEXT NOT NULL DEFAULT 'per_100g'
                       CHECK (basis IN ('per_100g','per_100ml')),
  language           TEXT,
  region             TEXT,
  source_id          TEXT NOT NULL REFERENCES sources(id),
  source_record_id   TEXT,
  data_quality       TEXT NOT NULL DEFAULT 'unverified'
                       CHECK (data_quality IN ('verified','derived','crowd','user','unverified')),
  is_custom          INTEGER NOT NULL DEFAULT 0 CHECK (is_custom IN (0,1)),
  is_recipe          INTEGER NOT NULL DEFAULT 0 CHECK (is_recipe IN (0,1)),
  is_deleted         INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  published_at       TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_foods_name   ON foods(canonical_name);
CREATE INDEX IF NOT EXISTS idx_foods_key    ON foods(search_key);
CREATE INDEX IF NOT EXISTS idx_foods_custom ON foods(is_custom, is_deleted);
CREATE INDEX IF NOT EXISTS idx_foods_type   ON foods(food_type_id);

CREATE TABLE IF NOT EXISTS food_nutrients (
  food_id      TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  nutrient_id  TEXT NOT NULL REFERENCES nutrients(id),
  amount_milli INTEGER, -- NULL = unknown
  PRIMARY KEY (food_id, nutrient_id)
);

CREATE TABLE IF NOT EXISTS food_portions (
  id          TEXT PRIMARY KEY,
  food_id     TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  gram_weight REAL NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  seq         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_portions_food ON food_portions(food_id);

CREATE TABLE IF NOT EXISTS food_aliases (
  id       TEXT PRIMARY KEY,
  food_id  TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  alias    TEXT NOT NULL,
  language TEXT
);
CREATE INDEX IF NOT EXISTS idx_faliases_food ON food_aliases(food_id);

CREATE TABLE IF NOT EXISTS muscles (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  region    TEXT,
  parent_id TEXT REFERENCES muscles(id)
);

CREATE TABLE IF NOT EXISTS equipment (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS movement_patterns (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

-- Exercise taxonomy: coarse category (resistance/cardio/mobility/...).
-- One category per exercise; assignments come from real catalogue data only.
CREATE TABLE IF NOT EXISTS exercise_categories (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exercises (
  id               TEXT PRIMARY KEY,
  canonical_name   TEXT NOT NULL,
  search_key       TEXT NOT NULL,
  source_id        TEXT NOT NULL REFERENCES sources(id),
  source_record_id TEXT,
  unilateral       INTEGER NOT NULL DEFAULT 0 CHECK (unilateral IN (0,1)),
  is_custom        INTEGER NOT NULL DEFAULT 0 CHECK (is_custom IN (0,1)),
  is_deleted       INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  variation_group  TEXT,
  category_id      TEXT REFERENCES exercise_categories(id),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- Curated movement-pattern assignments (real, known patterns only; the Free
-- Exercise DB does not carry a movement-pattern field, so its ~885 entries
-- stay unassigned rather than being inferred).
CREATE TABLE IF NOT EXISTS exercise_patterns (
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  pattern_id  TEXT NOT NULL REFERENCES movement_patterns(id),
  PRIMARY KEY (exercise_id, pattern_id)
);
CREATE INDEX IF NOT EXISTS idx_ex_name ON exercises(canonical_name);
CREATE INDEX IF NOT EXISTS idx_ex_key  ON exercises(search_key);

CREATE TABLE IF NOT EXISTS exercise_aliases (
  id          TEXT PRIMARY KEY,
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  language    TEXT
);

CREATE TABLE IF NOT EXISTS exercise_muscles (
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  muscle_id   TEXT NOT NULL REFERENCES muscles(id),
  role        TEXT NOT NULL CHECK (role IN ('primary','secondary')),
  PRIMARY KEY (exercise_id, muscle_id, role)
);

CREATE TABLE IF NOT EXISTS exercise_equipment (
  exercise_id  TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  equipment_id TEXT NOT NULL REFERENCES equipment(id),
  PRIMARY KEY (exercise_id, equipment_id)
);

CREATE TABLE IF NOT EXISTS log_days (
  local_date    TEXT PRIMARY KEY,
  tz_offset_min INTEGER
);

CREATE TABLE IF NOT EXISTS log_items (
  id            TEXT PRIMARY KEY,
  local_date    TEXT NOT NULL REFERENCES log_days(local_date),
  meal_section  TEXT NOT NULL,
  food_id       TEXT REFERENCES foods(id),
  label         TEXT NOT NULL,
  quantity_g    REAL,
  portion_label TEXT,
  source_id     TEXT REFERENCES sources(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  is_deleted    INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_logitems_day ON log_items(local_date, meal_section);

-- Nutrient SNAPSHOT frozen at log time (integrity guarantee)
CREATE TABLE IF NOT EXISTS log_item_nutrients (
  log_item_id  TEXT NOT NULL REFERENCES log_items(id) ON DELETE CASCADE,
  nutrient_id  TEXT NOT NULL REFERENCES nutrients(id),
  amount_milli INTEGER,
  was_unknown  INTEGER NOT NULL DEFAULT 0 CHECK (was_unknown IN (0,1)),
  PRIMARY KEY (log_item_id, nutrient_id)
);

CREATE TABLE IF NOT EXISTS targets (
  nutrient_id  TEXT PRIMARY KEY REFERENCES nutrients(id),
  target_milli INTEGER,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routines (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  notes      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1))
);

CREATE TABLE IF NOT EXISTS routine_exercises (
  id          TEXT PRIMARY KEY,
  routine_id  TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercises(id),
  target_sets INTEGER,
  target_reps TEXT,
  target_rir  INTEGER,
  rest_sec    INTEGER,
  seq         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_routine_exercises ON routine_exercises(routine_id, seq);

CREATE TABLE IF NOT EXISTS workouts (
  id            TEXT PRIMARY KEY,
  routine_id    TEXT REFERENCES routines(id),
  name          TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  local_date    TEXT NOT NULL,
  tz_offset_min INTEGER,
  notes         TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(local_date);

CREATE TABLE IF NOT EXISTS workout_exercises (
  id          TEXT PRIMARY KEY,
  workout_id  TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercises(id),
  seq         INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,
  target_sets INTEGER,
  target_reps TEXT,
  target_rir  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_we_workout ON workout_exercises(workout_id);

CREATE TABLE IF NOT EXISTS sets (
  id                  TEXT PRIMARY KEY,
  workout_exercise_id TEXT NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
  set_index           INTEGER NOT NULL,
  set_type            TEXT NOT NULL DEFAULT 'working'
                        CHECK (set_type IN ('working','warmup','drop','failure','amrap')),
  reps                INTEGER,
  load_g              INTEGER,
  is_bodyweight       INTEGER NOT NULL DEFAULT 0 CHECK (is_bodyweight IN (0,1)),
  side                TEXT CHECK (side IN ('left','right','both')),
  rir                 INTEGER,
  rpe                 REAL,
  is_completed        INTEGER NOT NULL DEFAULT 0 CHECK (is_completed IN (0,1)),
  notes               TEXT,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sets_we ON sets(workout_exercise_id, set_index);

CREATE TABLE IF NOT EXISTS personal_records (
  id               TEXT PRIMARY KEY,
  exercise_id      TEXT NOT NULL REFERENCES exercises(id),
  pr_type          TEXT NOT NULL CHECK (pr_type IN ('e1rm','reps_at_load','set_volume')),
  value_primary    INTEGER NOT NULL,
  value_secondary  INTEGER,
  set_id           TEXT REFERENCES sets(id),
  achieved_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_ex ON personal_records(exercise_id, pr_type);

CREATE TABLE IF NOT EXISTS preferences (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Body measurements are their own data category (NOT exercises): weight,
-- height, body-fat %, waist. Timeseries keyed by local date.
CREATE TABLE IF NOT EXISTS body_metrics (
  id          TEXT PRIMARY KEY,
  metric_type TEXT NOT NULL CHECK (metric_type IN ('weight_kg','height_cm','body_fat_pct','waist_cm','other')),
  value       REAL NOT NULL,
  local_date  TEXT NOT NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_body_metrics_date ON body_metrics(metric_type, local_date);

-- Cross-cutting favourites and recents (real user picks only).
CREATE TABLE IF NOT EXISTS favorites (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('food','exercise')),
  entity_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS recent_uses (
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('food','exercise')),
  entity_id    TEXT NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);
