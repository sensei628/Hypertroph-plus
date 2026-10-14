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

-- Saved nutrition plans (versioned; one may be active). Every plan keeps the
-- inputs AND the computed output so an old plan is reproducible even if the
-- estimation formulas evolve. Applying a plan writes the daily `targets` rows.
CREATE TABLE IF NOT EXISTS nutrition_plans (
  id                TEXT PRIMARY KEY,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  is_active         INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  sex               TEXT NOT NULL CHECK (sex IN ('male','female')),
  age               INTEGER NOT NULL,
  height_cm         REAL NOT NULL,
  weight_kg         REAL NOT NULL,
  activity          TEXT NOT NULL,
  goal              TEXT NOT NULL,
  rate_kg_per_week  REAL NOT NULL DEFAULT 0,
  protein_per_kg    REAL NOT NULL,
  fat_per_kg        REAL,
  fat_percent       REAL NOT NULL,
  bmr_kcal          INTEGER NOT NULL,
  tdee_kcal         INTEGER NOT NULL,
  target_kcal       INTEGER NOT NULL,
  protein_g         INTEGER NOT NULL,
  fat_g             INTEGER NOT NULL,
  carb_g            INTEGER NOT NULL,
  notes             TEXT
);
CREATE INDEX IF NOT EXISTS idx_nutrition_plans_active ON nutrition_plans(is_active);

-- Append-only log of daily-target changes, so past targets stay comparable with
-- the logs recorded against them. `source` records what set the value.
CREATE TABLE IF NOT EXISTS target_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  nutrient_id    TEXT NOT NULL REFERENCES nutrients(id),
  target_milli   INTEGER,
  effective_from TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('manual','plan','seed')),
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_target_history ON target_history(nutrient_id, effective_from);

-- Body measurements are their own data category (NOT exercises): weight,
-- height, body-fat %, waist. Timeseries keyed by local date.
CREATE TABLE IF NOT EXISTS body_metrics (
  id          TEXT PRIMARY KEY,
  metric_type TEXT NOT NULL CHECK (metric_type IN ('weight_kg','height_cm','body_fat_pct','neck_cm','chest_cm','waist_cm','hips_cm','thigh_cm','arm_cm','calf_cm','other')),
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

-- Diet plans: a saved template that is either a full "whole food" plan or a
-- protein-source rotation. Checking a plan meal writes its foods into the normal
-- meal log (log_items + nutrient snapshot) so daily totals stay correct;
-- unchecking removes exactly those entries again.
CREATE TABLE IF NOT EXISTS diet_plan (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  mode       TEXT NOT NULL CHECK (mode IN ('whole','protein')),
  is_active  INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diet_plan_active ON diet_plan(is_active);

-- day_of_week: 0=Sunday .. 6=Saturday, or NULL = every day.
CREATE TABLE IF NOT EXISTS diet_plan_meal (
  id          TEXT PRIMARY KEY,
  plan_id     TEXT NOT NULL REFERENCES diet_plan(id) ON DELETE CASCADE,
  day_of_week INTEGER CHECK (day_of_week IS NULL OR (day_of_week BETWEEN 0 AND 6)),
  meal_type   TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_diet_plan_meal_plan ON diet_plan_meal(plan_id, sort_order);

CREATE TABLE IF NOT EXISTS diet_plan_item (
  id           TEXT PRIMARY KEY,
  plan_meal_id TEXT NOT NULL REFERENCES diet_plan_meal(id) ON DELETE CASCADE,
  food_id      TEXT NOT NULL REFERENCES foods(id),
  grams        REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diet_plan_item_meal ON diet_plan_item(plan_meal_id);

-- One row per (meal, day) that has been checked off. log_entry_id holds a JSON
-- array of the log_items ids written for the check, so unchecking can find them.
CREATE TABLE IF NOT EXISTS diet_plan_check (
  id           TEXT PRIMARY KEY,
  plan_meal_id TEXT NOT NULL REFERENCES diet_plan_meal(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  checked_at   INTEGER NOT NULL,
  log_entry_id TEXT,
  UNIQUE (plan_meal_id, date)
);
CREATE INDEX IF NOT EXISTS idx_diet_plan_check_date ON diet_plan_check(date);

-- Protein-source reference table (values per 100 g); is_custom marks user rows.
CREATE TABLE IF NOT EXISTS protein_source (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kcal_100g    REAL NOT NULL,
  protein_100g REAL NOT NULL,
  carbs_100g   REAL NOT NULL,
  fat_100g     REAL NOT NULL,
  is_custom    INTEGER NOT NULL DEFAULT 0 CHECK (is_custom IN (0,1))
);

-- Protein-focus plans list protein sources (not full foods) per meal. grams is
-- the weighed amount of the source; egg-type sources are entered as piece counts
-- in the UI and stored here as grams (1 piece ≈ 50 g).
CREATE TABLE IF NOT EXISTS diet_plan_protein_item (
  id                TEXT PRIMARY KEY,
  plan_meal_id      TEXT NOT NULL REFERENCES diet_plan_meal(id) ON DELETE CASCADE,
  protein_source_id TEXT NOT NULL REFERENCES protein_source(id),
  grams             REAL NOT NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_diet_plan_protein_item_meal ON diet_plan_protein_item(plan_meal_id);

-- Daily micronutrient reference values; user_value overrides default_value.
CREATE TABLE IF NOT EXISTS micronutrient_target (
  id            TEXT PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  unit          TEXT NOT NULL,
  default_value REAL NOT NULL,
  user_value    REAL
);
