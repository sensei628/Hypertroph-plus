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