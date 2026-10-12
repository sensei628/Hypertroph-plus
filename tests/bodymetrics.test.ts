import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import path from 'node:path';
import { createRequire } from 'node:module';
import schemaSql from '../db/schema.sql?raw';
import seedSql from '../db/seed.sql?raw';
import {
  SqliteRepository,
  BODY_METRIC_TYPES,
  bodyMetricUnit,
  isWeightMetric,
  type BodyMetricType,
} from '../src/data/repository';

const require = createRequire(import.meta.url);

let db: Database;
let repo: SqliteRepository;

beforeAll(async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
  });
  db = new SQL.Database();
  db.run(schemaSql);
  db.run(seedSql);
  repo = new SqliteRepository(db);
});

describe('body metric definitions', () => {
  it('exposes the widened measurement set', () => {
    const ids = BODY_METRIC_TYPES.map(([id]) => id);
    for (const t of ['weight_kg', 'body_fat_pct', 'neck_cm', 'chest_cm', 'waist_cm', 'hips_cm', 'thigh_cm', 'arm_cm', 'calf_cm']) {
      expect(ids).toContain(t as BodyMetricType);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps display units', () => {
    expect(bodyMetricUnit('weight_kg')).toBe('kg');
    expect(bodyMetricUnit('waist_cm')).toBe('cm');
    expect(bodyMetricUnit('body_fat_pct')).toBe('%');
    expect(isWeightMetric('weight_kg')).toBe(true);
    expect(isWeightMetric('waist_cm')).toBe(false);
  });
});

describe('body metric storage', () => {
  it('accepts the newly-allowed measurement types', () => {
    repo.addBodyMetric({ metricType: 'weight_kg', value: 82.5, localDate: '2026-01-01' });
    repo.addBodyMetric({ metricType: 'weight_kg', value: 82.1, localDate: '2026-01-08' });
    repo.addBodyMetric({ metricType: 'neck_cm', value: 38.4, localDate: '2026-01-08' });
    repo.addBodyMetric({ metricType: 'waist_cm', value: 84, localDate: '2026-01-08', note: 'morning' });

    expect(repo.getBodyMetrics('neck_cm')).toHaveLength(1);
    expect(repo.getBodyMetrics('waist_cm')[0].note).toBe('morning');
  });

  it('returns a type newest-first and respects the limit', () => {
    const weights = repo.getBodyMetrics('weight_kg');
    expect(weights.map((m) => m.localDate)).toEqual(['2026-01-08', '2026-01-01']);
    expect(repo.getBodyMetrics('weight_kg', 1)[0].value).toBe(82.1);
  });

  it('lists every metric across types, newest first', () => {
    const all = repo.listBodyMetrics();
    // 2026-01-08 entries come before the earlier weight entry.
    expect(all[0].localDate).toBe('2026-01-08');
    expect(all[all.length - 1].localDate).toBe('2026-01-01');
    const types = new Set(all.map((m) => m.metricType));
    expect(types).toEqual(new Set(['weight_kg', 'neck_cm', 'waist_cm']));
  });

  it('deletes a single entry', () => {
    const target = repo.getBodyMetrics('waist_cm')[0];
    repo.deleteBodyMetric(target.id);
    expect(repo.getBodyMetrics('waist_cm')).toHaveLength(0);
  });
});
