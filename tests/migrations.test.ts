import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import path from 'node:path';
import { createRequire } from 'node:module';
import { MIGRATIONS } from '../src/data/db';

const require = createRequire(import.meta.url);

let db: Database;

// Minimal pre-v4 layout: log_days + log_items with the old fixed-meal CHECK,
// plus a child table that references log_items (the FK that makes the rebuild
// need foreign_keys=OFF, as applyMigrations does).
const OLD_SCHEMA = `
  CREATE TABLE log_days (local_date TEXT PRIMARY KEY, tz_offset_min INTEGER);
  CREATE TABLE log_items (
    id            TEXT PRIMARY KEY,
    local_date    TEXT NOT NULL REFERENCES log_days(local_date),
    meal_section  TEXT NOT NULL CHECK (meal_section IN ('breakfast','lunch','dinner','snack','other')),
    food_id       TEXT,
    label         TEXT NOT NULL,
    quantity_g    REAL,
    portion_label TEXT,
    source_id     TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    is_deleted    INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1))
  );
  CREATE INDEX idx_logitems_day ON log_items(local_date, meal_section);
  CREATE TABLE log_item_nutrients (
    log_item_id  TEXT NOT NULL REFERENCES log_items(id) ON DELETE CASCADE,
    nutrient_id  TEXT NOT NULL,
    amount_milli INTEGER,
    was_unknown  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (log_item_id, nutrient_id)
  );
`;

beforeAll(async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
  });
  db = new SQL.Database();
  db.run(OLD_SCHEMA);
  db.run("INSERT INTO log_days VALUES ('2026-01-01', 0)");
  db.run("INSERT INTO log_items VALUES ('l1','2026-01-01','snack',NULL,'Oats',100,NULL,'s_app',1,1,0)");
  db.run("INSERT INTO log_item_nutrients VALUES ('l1','energy_kcal',123000,0)");
});

describe('migration v4 (user-defined meals)', () => {
  it('rebuilds log_items without the meal_section CHECK and preserves data', () => {
    const v4 = MIGRATIONS.find((m) => m.version === 4);
    expect(v4).toBeTruthy();
    db.run('BEGIN');
    db.run(v4!.sql);
    db.run('COMMIT');

    // Custom meal section is now accepted by the schema.
    db.run("INSERT INTO log_items VALUES ('l2','2026-01-01','late-night snack',NULL,'Rice',100,NULL,'s_app',1,1,0)");
    const sections = db.exec('SELECT meal_section FROM log_items ORDER BY id')[0].values;
    expect(sections).toEqual([['snack'], ['late-night snack']]);

    // Child snapshot rows survived the rebuild.
    const milli = db.exec("SELECT amount_milli FROM log_item_nutrients WHERE log_item_id = 'l1'")[0].values[0][0];
    expect(milli).toBe(123000);

    // The day index was recreated.
    const idx = db.exec("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_logitems_day'")[0].values[0][0];
    expect(idx).toBe(1);
  });
});

// Pre-v5/v6 schema for foods + exercises (the columns the taxonomy migrations
// add did not exist yet) plus the tables they depend on.
const PRE_TAXONOMY_SCHEMA = `
  CREATE TABLE sources (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, license TEXT NOT NULL,
    license_url TEXT, attribution TEXT, redistribution TEXT,
    pack_version TEXT, retrieved_at INTEGER
  );
  CREATE TABLE food_types (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE foods (
    id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, search_key TEXT NOT NULL,
    brand TEXT, category TEXT,
    prep_state TEXT NOT NULL DEFAULT 'unknown' CHECK (prep_state IN ('raw','cooked','as_sold','prepared','unknown')),
    basis TEXT NOT NULL DEFAULT 'per_100g', language TEXT, region TEXT,
    source_id TEXT NOT NULL, source_record_id TEXT,
    data_quality TEXT NOT NULL DEFAULT 'unverified', is_custom INTEGER NOT NULL DEFAULT 0,
    is_recipe INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE food_nutrients (
    food_id TEXT NOT NULL, nutrient_id TEXT NOT NULL, amount_milli INTEGER,
    PRIMARY KEY (food_id, nutrient_id)
  );
  CREATE TABLE food_portions (
    id TEXT PRIMARY KEY, food_id TEXT NOT NULL, label TEXT NOT NULL,
    gram_weight REAL NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE food_aliases (
    id TEXT PRIMARY KEY, food_id TEXT NOT NULL, alias TEXT NOT NULL, language TEXT
  );
  CREATE TABLE exercise_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE exercises (
    id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, search_key TEXT NOT NULL,
    source_id TEXT NOT NULL, source_record_id TEXT,
    unilateral INTEGER NOT NULL DEFAULT 0, is_custom INTEGER NOT NULL DEFAULT 0,
    is_deleted INTEGER NOT NULL DEFAULT 0, variation_group TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE exercise_aliases (
    id TEXT PRIMARY KEY, exercise_id TEXT NOT NULL, alias TEXT NOT NULL, language TEXT
  );
  CREATE TABLE exercise_muscles (
    exercise_id TEXT NOT NULL, muscle_id TEXT NOT NULL, role TEXT NOT NULL,
    PRIMARY KEY (exercise_id, muscle_id, role)
  );
  CREATE TABLE exercise_equipment (
    exercise_id TEXT NOT NULL, equipment_id TEXT NOT NULL,
    PRIMARY KEY (exercise_id, equipment_id)
  );
  CREATE TABLE movement_patterns (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE log_days (local_date TEXT PRIMARY KEY, tz_offset_min INTEGER);
  CREATE TABLE log_items (
    id TEXT PRIMARY KEY, local_date TEXT NOT NULL, meal_section TEXT NOT NULL,
    food_id TEXT, label TEXT NOT NULL, quantity_g REAL, portion_label TEXT,
    source_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
  );
`;

describe('migration v5 (food taxonomy + metrics)', () => {
  let d: Database;

  beforeAll(async () => {
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
    });
    d = new SQL.Database();
    d.run(PRE_TAXONOMY_SCHEMA);
    d.run(
      `INSERT INTO sources (id, name, license) VALUES
       ('s_usda','USDA','CC0-1.0'),('s_app','hypertroph+','original-work'),('s_user','User','user');`,
    );
    // Legacy rows: seed foods carry a category, custom food has none.
    d.run(
      `INSERT INTO foods (id, canonical_name, search_key, category, prep_state, source_id, source_record_id, data_quality, is_custom, created_at, updated_at) VALUES
       ('f_oats','Oats','oats','grains','raw','s_app','demo-1','derived',0,1,1),
       ('f_chicken','Chicken','chicken','meat','cooked','s_app','demo-4','derived',0,1,1),
       ('f_custom','Protein bar','protein bar',NULL,'unknown','s_user',NULL,'user',1,1,1);`,
    );
    // A legacy exercise at a "belt" variation.
    d.run(
      `INSERT INTO movement_patterns (id, name) VALUES ('horizontal_push','Horizontal push'),('squat','Squat');`,
    );
    d.run(
      `INSERT INTO exercises (id, canonical_name, search_key, source_id, source_record_id, unilateral, created_at, updated_at) VALUES
       ('e_bench','Bench Press','bench press','s_app',NULL,0,1,1),
       ('e_squat','Squat','squat','s_app',NULL,0,1,1),
       ('e_barbell_squat','Barbell Squat','barbell squat','s_exdb','bar_sq',0,1,1);`,
    );
  });

  it('adds the taxonomy columns and backfills from real category text', () => {
    const v5 = MIGRATIONS.find((m) => m.version === 5);
    expect(v5).toBeTruthy();
    d.run('BEGIN');
    d.run('PRAGMA foreign_keys = OFF');
    d.run(v5!.sql);
    d.run('PRAGMA foreign_keys = ON');
    d.run('COMMIT');

    // Prep-state CHECK was widened for the sample 'cooked'/'raw'.
    const cols = d.exec("PRAGMA table_info(foods)")[0].values;
    const names = cols.map((c) => c[1]);
    expect(names).toContain('food_type_id');
    expect(names).toContain('entry_type');
    expect(names).toContain('published_at');

    // Seed foods backfilled from their real category; custom food is 'custom'.
    const oats = d.exec("SELECT food_type_id, entry_type FROM foods WHERE id = 'f_oats'")[0].values[0];
    expect(oats).toEqual(['grains', 'generic']);
    const chicken = d.exec("SELECT food_type_id, entry_type FROM foods WHERE id = 'f_chicken'")[0].values[0];
    expect(chicken).toEqual(['meat', 'generic']);
    const custom = d.exec("SELECT food_type_id, entry_type FROM foods WHERE id = 'f_custom'")[0].values[0];
    expect(custom).toEqual([null, 'custom']);

    // Variant food (legacy 'cooked') survived with an unbackfilled type.
    expect(d.exec("SELECT COUNT(*) FROM foods WHERE id = 'f_chicken'")[0].values[0][0]).toBe(1);
  });

  it('creates the supporting metrics/favorites/recents tables', () => {
    const tables = d
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('body_metrics','favorites','recent_uses')")[0]
      .values.map((r) => r[0]);
    expect(tables.sort()).toEqual(['body_metrics', 'favorites', 'recent_uses']);
  });
});

describe('migration v6 (exercise taxonomy)', () => {
  let d: Database;

  beforeAll(async () => {
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
    });
    d = new SQL.Database();
    d.run(PRE_TAXONOMY_SCHEMA);
    d.run(
      `INSERT INTO sources (id, name, license) VALUES
       ('s_usda','USDA','CC0-1.0'),('s_app','hypertroph+','original-work'),('s_user','User','user'),
       ('s_exdb','Free Exercise DB','Unlicense');`,
    );
    d.run(
      `INSERT INTO movement_patterns (id, name) VALUES
       ('horizontal_push','Horizontal push'),('vertical_push','Vertical push'),
       ('horizontal_pull','Horizontal pull'),('vertical_pull','Vertical pull'),
       ('squat','Squat'),('hinge','Hinge');`,
    );
    d.run(
      `INSERT INTO exercises (id, canonical_name, search_key, source_id, source_record_id, unilateral, created_at, updated_at) VALUES
       ('e_bench','Bench Press','bench press','s_app',NULL,0,1,1),
       ('e_squat','Squat','squat','s_app',NULL,0,1,1),
       ('e_Barbell_Squat','Barbell Squat','barbell squat','s_exdb','Metal_Leg_Ext_sq',0,1,1),
       ('e_90_90_Hamstring','90/90 Hamstring','90 90 hamstring','s_exdb','90_90_Hamstring',0,1,1);`,
    );
  });

  it('adds category_id and backfills categories from the catalogue file', () => {
    const v6 = MIGRATIONS.find((m) => m.version === 6);
    expect(v6).toBeTruthy();
    d.run('BEGIN');
    d.run('PRAGMA foreign_keys = OFF');
    d.run(v6!.sql);
    d.run('PRAGMA foreign_keys = ON');
    d.run('COMMIT');

    const cols = d.exec('PRAGMA table_info(exercises)')[0].values.map((c) => c[1]);
    expect(cols).toContain('category_id');

    // FeDB rows get real categories from the catalogue data file:
    const barbellSquat = d.exec("SELECT category_id FROM exercises WHERE id = 'e_Barbell_Squat'")[0].values[0][0];
    expect(barbellSquat).toBe('resistance');
    const hamstring = d.exec("SELECT category_id FROM exercises WHERE id = 'e_90_90_Hamstring'")[0].values[0][0];
    expect(hamstring).toBe('stretching');

    // App-authored seed exercises are explicitly resistance.
    const bench = d.exec("SELECT category_id FROM exercises WHERE id = 'e_bench'")[0].values[0][0];
    expect(bench).toBe('resistance');

    // Curated movement-pattern assignments exist for the seed exercises.
    const patterns = d
      .exec("SELECT pattern_id FROM exercise_patterns WHERE exercise_id = 'e_bench'")[0]
      .values.map((r) => r[0]);
    expect(patterns).toContain('horizontal_push');
  });
});

// Pre-v7 training layout: workouts/workout_exercises without the per-exercise
// target columns and without the plan (routines) tables.
const PRE_V7_SCHEMA = `
  CREATE TABLE exercises (id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL);
  CREATE TABLE workouts (
    id TEXT PRIMARY KEY, routine_id TEXT, name TEXT NOT NULL,
    started_at INTEGER NOT NULL, ended_at INTEGER, local_date TEXT NOT NULL,
    tz_offset_min INTEGER, notes TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE workout_exercises (
    id TEXT PRIMARY KEY, workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
    exercise_id TEXT NOT NULL REFERENCES exercises(id), seq INTEGER NOT NULL DEFAULT 0, notes TEXT
  );
  CREATE TABLE sets (
    id TEXT PRIMARY KEY, workout_exercise_id TEXT NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
    set_index INTEGER NOT NULL
  );
`;

describe('migration v7 (workout plans + per-exercise targets)', () => {
  let d: Database;

  beforeAll(async () => {
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
    });
    d = new SQL.Database();
    d.run(PRE_V7_SCHEMA);
    d.run("INSERT INTO exercises VALUES ('e_bench','Bench Press')");
    d.run("INSERT INTO workouts VALUES ('wo1',NULL,'Push','2026-01-01',NULL,'2026-01-01',0,NULL,1)");
    d.run("INSERT INTO workout_exercises VALUES ('we1','wo1','e_bench',0,'note')");
    d.run("INSERT INTO sets VALUES ('set1','we1',1)");
  });

  it('adds target columns, preserves history, and creates the plan tables', () => {
    const v7 = MIGRATIONS.find((m) => m.version === 7);
    expect(v7).toBeTruthy();
    d.run('BEGIN');
    d.run('PRAGMA foreign_keys = OFF');
    d.run(v7!.sql);
    d.run('PRAGMA foreign_keys = ON');
    d.run('COMMIT');

    const cols = d.exec('PRAGMA table_info(workout_exercises)')[0].values.map((c) => c[1]);
    expect(cols).toContain('target_sets');
    expect(cols).toContain('target_reps');
    expect(cols).toContain('target_rir');

    // Existing workout_exercise + child set rows survived the rebuild.
    expect(d.exec("SELECT seq, notes FROM workout_exercises WHERE id = 'we1'")[0].values[0]).toEqual([0, 'note']);
    expect(d.exec("SELECT COUNT(*) FROM sets WHERE id = 'set1'")[0].values[0][0]).toBe(1);

    const tables = d
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('routines','routine_exercises')")[0]
      .values.map((r) => r[0]);
    expect(tables.sort()).toEqual(['routine_exercises', 'routines']);
  });
});