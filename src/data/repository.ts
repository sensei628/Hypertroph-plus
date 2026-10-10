import type { DB } from './db';
import { persist } from './db';
import { NutrientUnit, Milli, toMilli } from '../domain/nutrients';
import { NutrientValue, LoggedNutrient, LogItem, snapshotLogItem, FoodLike } from '../domain/nutrition';
import { SetRecord, SetWithExercise, PRKind, evaluateSet, PRState, emptyPRState, workingSetVolumeByMuscle } from '../domain/training';

export function normalizeKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

// Reference-pack integration. Reference foods live in a separate, read-only
// SQLite DB and are addressed by a namespaced id. The first time a reference
// food is logged it is copied into the user DB, so logged history/recents keep
// working against the user schema and the reference pack is never mutated.
const REF_PREFIX = 'usda:';

/** Reference nutrient `code` -> app nutrient id. Only the app's core set is used. */
const REF_CODE_TO_APP: Record<string, string> = {
  energy_kcal: 'energy_kcal',
  protein: 'protein_g',
  fat: 'fat_g',
  carb: 'carb_g',
  fiber: 'fiber_g',
  sugars: 'sugar_g',
  sodium: 'sodium_mg',
};

// USDA FoodData Central `data_type` -> app entry_type. Real provenance only:
// Survey (FNDDS) foods are "as consumed", Foundation/SR Legacy are generic
// whole foods. Branded is supported by the schema but the catalogue contains
// no Branded rows, so that facet stays visibly empty (never inferred).
export const REF_DATA_TYPE_TO_ENTRY_TYPE: Record<string, string> = {
  Foundation: 'generic',
  'SR Legacy': 'generic',
  'Survey (FNDDS)': 'prepared',
  Branded: 'branded',
};

// USDA FoodData Central `food_category` -> app food_type. Mapped from the real
// category vocabulary of the imported pack; foods whose category has no app
// equivalent stay NULL (never inferred). Survey rows carry an empty category.
export const REF_CATEGORY_TO_FOOD_TYPE: Record<string, string> = {
  'Beef Products': 'meat',
  'Vegetables and Vegetable Products': 'vegetables',
  'Baked Products': 'grains',
  'Lamb, Veal, and Game Products': 'meat',
  'Fruits and Fruit Juices': 'fruits',
  'Poultry Products': 'meat',
  'Beverages': 'beverages',
  'Sweets': 'snacks',
  'Baby Foods': 'mixed_dishes',
  'Pork Products': 'meat',
  'Dairy and Egg Products': 'dairy',
  'Legumes and Legume Products': 'legumes',
  'Fast Foods': 'mixed_dishes',
  'Finfish and Shellfish Products': 'seafood',
  'Soups, Sauces, and Gravies': 'mixed_dishes',
  'Fats and Oils': 'oils',
  'Cereal Grains and Pasta': 'grains',
  'Breakfast Cereals': 'grains',
  'Snacks': 'snacks',
  'Sausages and Luncheon Meats': 'meat',
  'American Indian/Alaska Native Foods': 'other',
  'Nut and Seed Products': 'nuts',
  'Restaurant Foods': 'mixed_dishes',
  'Meals, Entrees, and Side Dishes': 'mixed_dishes',
  'Spices and Herbs': 'other',
};

// Curated quick-pick lists shown at the top of each picker so common foods and
// machine/dumbbell exercises stay one keystroke away while browsing.
const PINNED_FOOD_KEYWORDS = ['chicken breast', 'rice', 'eggs', 'lentils', 'beans', 'cauliflower', 'lettuce'];
const PINNED_EXERCISE_KEYWORDS = [
  'bench press',
  'squat',
  'deadlift',
  'lat pulldown',
  'cable row',
  'leg press',
  'dumbbell shoulder press',
  'dumbbell curl',
  'triceps pushdown',
  'lateral raise',
];

function refPortionLabel(p: {
  amount: number | null;
  modifier: string | null;
  measure_name: string | null;
  measure_abbr: string | null;
}): string {
  const modifier = p.modifier && p.modifier.trim();
  if (modifier) return modifier;
  const measure = p.measure_name || p.measure_abbr || 'serving';
  const amount = p.amount ?? 1;
  return `${amount} ${measure}`;
}

export interface NutrientDef {
  id: string;
  name: string;
  unit: NutrientUnit;
  kind: string;
  displayOrder: number;
  targetable: boolean;
}

export interface FoodSummary {
  id: string;
  name: string;
  brand: string | null;
  foodTypeId: string | null;
  entryType: string | null;
  prepState: string;
  basis: string;
  quality: string;
  sourceId: string;
  publishedAt: string | null;
  matchedAlias: string | null;
}

export interface FoodFilters {
  foodTypeId?: string | null;
  entryType?: string | null;
  prepState?: string | null;
}

export interface PortionRow {
  id: string;
  label: string;
  gramWeight: number;
  isDefault: boolean;
}

export interface FoodDetail extends FoodSummary {
  nutrients: NutrientValue[];
  portions: PortionRow[];
}

export interface DayItemRow {
  id: string;
  mealSection: string;
  label: string;
  quantityG: number | null;
  portionLabel: string | null;
  nutrients: LoggedNutrient[];
}

export interface ExerciseSummary {
  id: string;
  name: string;
  unilateral: boolean;
  categoryId: string | null;
  equipment: string[];
  primaryMuscles: string[];
  matchedAlias: string | null;
}

export interface ExerciseFilters {
  categoryId?: string | null;
  equipmentId?: string | null;
  muscleId?: string | null;
}

export interface FacetValue {
  id: string;
  name: string;
  count: number;
}

export interface FoodFacets {
  foodTypes: FacetValue[];
  entryTypes: FacetValue[];
  prepStates: FacetValue[];
}

export interface ExerciseFacets {
  categories: FacetValue[];
  equipment: FacetValue[];
  muscles: FacetValue[];
}

export type BodyMetricType = 'weight_kg' | 'height_cm' | 'body_fat_pct' | 'waist_cm' | 'other';

export interface BodyMetric {
  id: string;
  metricType: BodyMetricType;
  value: number;
  localDate: string;
  note: string | null;
  createdAt: number;
}

export interface LogSetInput {
  setType: SetRecord['setType'];
  reps: number | null;
  loadG: number | null;
  rir: number | null;
  isBodyweight: boolean;
  side?: 'left' | 'right' | 'both' | null;
}

export interface SetRow {
  id: string;
  setIndex: number;
  setType: SetRecord['setType'];
  reps: number | null;
  loadG: number | null;
  rir: number | null;
  isCompleted: boolean;
}

export interface WorkoutExerciseRow {
  id: string;
  exerciseId: string;
  name: string;
  unilateral: boolean;
  targetSets: number | null;
  targetReps: string | null;
  targetRir: number | null;
  sets: SetRow[];
}

export interface WorkoutRow {
  id: string;
  name: string;
  routineId: string | null;
  startedAt: number;
  endedAt: number | null;
  exercises: WorkoutExerciseRow[];
}

/** A user-authored workout-plan template ("Your workout plan"). */
export interface RoutineExerciseRow {
  id: string;
  exerciseId: string;
  name: string;
  targetSets: number | null;
  targetReps: string | null;
  targetRir: number | null;
  restSec: number | null;
  seq: number;
}

export interface RoutineSummary {
  id: string;
  name: string;
  notes: string | null;
  exerciseCount: number;
  updatedAt: number;
}

export interface RoutineDetail extends RoutineSummary {
  exercises: RoutineExerciseRow[];
}

export interface RoutineInput {
  id?: string;
  name: string;
  notes?: string | null;
  exercises: {
    exerciseId: string;
    targetSets?: number | null;
    targetReps?: string | null;
    targetRir?: number | null;
    restSec?: number | null;
  }[];
}

/** The most recently logged set for an exercise, used to prefill the next one. */
export interface LastSetHint {
  loadG: number | null;
  reps: number | null;
  rir: number | null;
}

export interface DataPort {
  getNutrientDefs(): NutrientDef[];
  getTargets(): Map<string, Milli>;
  setTarget(nutrientId: string, targetMilli: Milli | null): void;
  getPreference(key: string, fallback: string): string;
  setPreference(key: string, value: string | readonly string[]): void;

  searchFoods(query: string, limit?: number, filters?: FoodFilters): FoodSummary[];
  countFoods(query: string, filters?: FoodFilters): number;
  getFoodFacets(query: string): FoodFacets;
  getPinnedFoods(): FoodSummary[];
  getFood(id: string): FoodDetail | null;
  recentFoods(limit?: number): FoodSummary[];
  recentUses(entityType: 'food' | 'exercise', limit?: number): string[];
  touchUse(entityType: 'food' | 'exercise', id: string): void;
  favoriteIds(entityType: 'food' | 'exercise'): Set<string>;
  toggleFavorite(entityType: 'food' | 'exercise', id: string): void;
  createCustomFood(name: string, nutrients: NutrientValue[]): FoodDetail;

  addBodyMetric(input: { metricType: BodyMetricType; value: number; localDate: string; note?: string }): void;
  getBodyMetrics(metricType: BodyMetricType, limit?: number): BodyMetric[];
  deleteBodyMetric(id: string): void;

  logFood(input: {
    foodId: string;
    quantityG: number;
    portionLabel?: string;
    mealSection: string;
    localDate: string;
    tzOffsetMin?: number;
  }): void;
  getDayItems(localDate: string): DayItemRow[];
  deleteLogItem(id: string): void;
  getUsedMealSections(): string[];

  searchExercises(query: string, limit?: number, filters?: ExerciseFilters): ExerciseSummary[];
  countExercises(query: string, filters?: ExerciseFilters): number;
  getExerciseFacets(query: string): ExerciseFacets;
  getPinnedExercises(): ExerciseSummary[];
  getExercise(id: string): ExerciseSummary | null;
  getExerciseMuscles(id: string): { primary: string[]; secondary: string[] };
  getMuscleNames(): Map<string, string>;

  startWorkout(name: string, localDate: string, tzOffsetMin?: number): string;
  getActiveWorkout(localDate: string): WorkoutRow | null;
  addExercise(workoutId: string, exerciseId: string): string;
  logSet(workoutExerciseId: string, input: LogSetInput): { setId: string; prs: PRKind[] };
  finishWorkout(workoutId: string): void;
  getWeeklyVolume(fromDate: string, toDate: string, secondaryFactor?: number): Map<string, number>;

  listRoutines(): RoutineSummary[];
  getRoutine(id: string): RoutineDetail | null;
  saveRoutine(input: RoutineInput): string;
  deleteRoutine(id: string): void;
  startWorkoutFromRoutine(routineId: string, localDate: string, tzOffsetMin?: number): string | null;
  getLastSetForExercise(exerciseId: string): LastSetHint | null;
}

export class SqliteRepository implements DataPort {
  constructor(private db: DB, private ref: DB | null = null) {}

  private rows<T>(sql: string, params: unknown[] = []): T[] {
    return queryAll<T>(this.db, sql, params);
  }

  private refRows<T>(sql: string, params: unknown[] = []): T[] {
    return this.ref ? queryAll<T>(this.ref, sql, params) : [];
  }

  private run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params as never);
  }

  // ── nutrients / targets / prefs ──────────────────────────
  getNutrientDefs(): NutrientDef[] {
    return this.rows<{
      id: string;
      name: string;
      unit: NutrientUnit;
      kind: string;
      display_order: number;
      targetable: number;
    }>('SELECT id, name, unit, kind, display_order, targetable FROM nutrients ORDER BY display_order').map(
      (r) => ({
        id: r.id,
        name: r.name,
        unit: r.unit,
        kind: r.kind,
        displayOrder: r.display_order,
        targetable: r.targetable === 1,
      }),
    );
  }

  getTargets(): Map<string, Milli> {
    const out = new Map<string, Milli>();
    for (const r of this.rows<{ nutrient_id: string; target_milli: number | null }>(
      'SELECT nutrient_id, target_milli FROM targets',
    )) {
      if (r.target_milli != null) out.set(r.nutrient_id, r.target_milli);
    }
    return out;
  }

  setTarget(nutrientId: string, targetMilli: Milli | null): void {
    this.run(
      `INSERT INTO targets (nutrient_id, target_milli, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(nutrient_id) DO UPDATE SET target_milli = excluded.target_milli, updated_at = excluded.updated_at`,
      [nutrientId, targetMilli, Date.now()],
    );
    this.commit();
  }

  getPreference(key: string, fallback: string): string {
    const r = this.rows<{ value: string }>('SELECT value FROM preferences WHERE key = ?', [key])[0];
    return r ? r.value.replace(/^"|"$/g, '') : fallback;
  }

  setPreference(key: string, value: string | readonly string[]): void {
    this.run(
      `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), Date.now()],
    );
    this.commit();
  }

  // ── foods ────────────────────────────────────────────────
  searchFoods(query: string, limit = 25, filters?: FoodFilters): FoodSummary[] {
    const key = normalizeKey(query);
    const excludeRef = this.ref ? " AND source_id <> 's_usda'" : '';
    const fw = localFoodFilter(filters);
    if (!key) {
      // Browsing the catalogue (empty query): list local foods, then fill from
      // the reference pack so the full catalog is reachable without typing.
      const local = this.rows<Record<string, unknown>>(
        `SELECT id, canonical_name, brand, food_type_id, entry_type, prep_state, basis, data_quality, source_id, published_at
         FROM foods
         WHERE is_deleted = 0${excludeRef}${fw.sql}
         ORDER BY canonical_name LIMIT ?`,
        [...fw.params, limit],
      ).map(mapFood);
      return [...local, ...this.refBrowse(limit - local.length, filters)];
    }
    const like = `%${key}%`;
    const prefix = `${key}%`;
    const escaped = key.replace(/([%_])/g, '\\$1');
    // Rank: alias match, then name-prefix, then name-substring.
    const local = this.rows<Record<string, unknown>>(
      `SELECT f.id, f.canonical_name, f.brand, f.food_type_id, f.entry_type, f.prep_state, f.basis, f.data_quality, f.source_id, f.published_at,
              (SELECT a.alias FROM food_aliases a WHERE a.food_id = f.id AND a.alias LIKE ? LIMIT 1) AS matched_alias,
              CASE WHEN f.search_key LIKE ? THEN 0 ELSE 1 END AS rank
       FROM foods f
       WHERE f.is_deleted = 0${this.ref ? " AND f.source_id <> 's_usda'" : ''}
         AND (f.search_key LIKE ? OR f.id IN (SELECT food_id FROM food_aliases WHERE lower(alias) LIKE ?))
         ${fw.sql}
       ORDER BY rank, length(f.canonical_name) LIMIT ?`,
      [like, prefix, like, like, ...fw.params, limit],
    ).map(mapFood);
    void escaped;
    const remaining = limit - local.length;
    if (remaining <= 0) return local;
    return [...local, ...this.refSearch(key, remaining, filters)];
  }

  /** Total foods matching a query and filters (mirrors searchFoods). */
  countFoods(query: string, filters?: FoodFilters): number {
    const key = normalizeKey(query);
    const excludeRef = this.ref ? " AND source_id <> 's_usda'" : '';
    const fw = localFoodFilter(filters);
    if (!key) {
      const local =
        this.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM foods WHERE is_deleted = 0${excludeRef}${fw.sql}`, fw.params)[0]?.n ?? 0;
      const ref = this.ref ? this.refCountRef(filters) : 0;
      return local + ref;
    }
    const like = `%${key}%`;
    const local =
      this.rows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM foods f
         WHERE f.is_deleted = 0${excludeRef}
           AND (f.search_key LIKE ? OR f.id IN (SELECT food_id FROM food_aliases WHERE lower(alias) LIKE ?))
           ${fw.sql}`,
        [like, like, ...fw.params],
      )[0]?.n ?? 0;
    const ref = this.ref ? this.refCount(key, filters) : 0;
    return local + ref;
  }

  /**
   * Facet counts (food type / entry kind / prep) for the catalogue matching
   * `query`. Every vocabulary value is present so the UI renders facets that
   * are legitimately empty (e.g. branded) without mistaking them for missing.
   */
  getFoodFacets(query: string): FoodFacets {
    const key = normalizeKey(query);
    const like = key ? `%${key}%` : '%';

    // Local counts. Materialized ref copies are excluded to avoid double
    // counting against the ref pack (mirrors searchFoods).
    const types = new Map<string, number>();
    const entries = new Map<string, number>();
    const preps = new Map<string, number>();
    for (const r of this.rows<{ id: string; n: number }>(
      `SELECT f.food_type_id AS id, COUNT(*) AS n FROM foods f
       WHERE f.is_deleted = 0 AND f.source_id <> 's_usda' AND (f.search_key LIKE ?)
       GROUP BY f.food_type_id`,
      [like],
    )) {
      if (r.id) types.set(r.id, r.n);
    }
    for (const r of this.rows<{ id: string; n: number }>(
      `SELECT f.entry_type AS id, COUNT(*) AS n FROM foods f
       WHERE f.is_deleted = 0 AND f.source_id <> 's_usda' AND (f.search_key LIKE ?)
       GROUP BY f.entry_type`,
      [like],
    )) {
      if (r.id) entries.set(r.id, r.n);
    }
    for (const r of this.rows<{ id: string; n: number }>(
      `SELECT f.prep_state AS id, COUNT(*) AS n FROM foods f
       WHERE f.is_deleted = 0 AND f.source_id <> 's_usda' AND (f.search_key LIKE ?)
       GROUP BY f.prep_state`,
      [like],
    )) {
      if (r.id) preps.set(r.id, r.n);
    }

    // Reference-pack counts (mapped through the real USDA category/data_type).
    if (this.ref) {
      const byCat = new Map<string, number>();
      for (const r of this.refRows<{ food_category: string | null; n: number }>(
        `SELECT food_category, COUNT(*) AS n FROM foods WHERE search_key LIKE ? GROUP BY food_category`,
        [like],
      )) {
        if (r.food_category) byCat.set(r.food_category, r.n);
      }
      for (const r of this.refRows<{ data_type: string | null; n: number }>(
        `SELECT data_type, COUNT(*) AS n FROM foods WHERE search_key LIKE ? GROUP BY data_type`,
        [like],
      )) {
        if (r.data_type) {
          const t = REF_DATA_TYPE_TO_ENTRY_TYPE[r.data_type];
          if (t) entries.set(t, (entries.get(t) ?? 0) + r.n);
        }
      }
      for (const [cat, n] of byCat) {
        const t = REF_CATEGORY_TO_FOOD_TYPE[cat];
        if (t) types.set(t, (types.get(t) ?? 0) + n);
      }
      // Reference foods have no prep metadata; they are all 'unknown'.
      const totalRef = this.refRows<{ n: number }>(`SELECT COUNT(*) AS n FROM foods WHERE search_key LIKE ?`, [like])[0].n;
      if (totalRef > 0) preps.set('unknown', (preps.get('unknown') ?? 0) + totalRef);
    }

    return {
      foodTypes: FOOD_TYPE_VOCAB.map(([id, name]) => ({ id, name, count: types.get(id) ?? 0 })),
      entryTypes: ENTRY_TYPE_VOCAB.map(([id]) => ({ id, name: ENTRY_TYPE_VOCAB_BY_ID[id], count: entries.get(id) ?? 0 })),
      prepStates: PREP_STATE_VOCAB.map(([id]) => ({ id, name: PREP_STATE_VOCAB_BY_ID[id], count: preps.get(id) ?? 0 })),
    };
  }

  /** Top hit for each curated food keyword, deduped. */
  getPinnedFoods(): FoodSummary[] {
    const out: FoodSummary[] = [];
    const seen = new Set<string>();
    for (const kw of PINNED_FOOD_KEYWORDS) {
      const hit = this.searchFoods(kw, 1)[0];
      if (hit && !seen.has(hit.id)) {
        seen.add(hit.id);
        out.push(hit);
      }
    }
    return out;
  }

  /** Top hit for each curated exercise keyword, deduped. */
  getPinnedExercises(): ExerciseSummary[] {
    const out: ExerciseSummary[] = [];
    const seen = new Set<string>();
    for (const kw of PINNED_EXERCISE_KEYWORDS) {
      const hit = this.searchExercises(kw, 1)[0];
      if (hit && !seen.has(hit.id)) {
        seen.add(hit.id);
        out.push(hit);
      }
    }
    return out;
  }

  private refBrowse(limit: number, filters?: FoodFilters): FoodSummary[] {
    if (!this.ref || limit <= 0) return [];
    const preds = refFilterPredicates(filters);
    const where = preds.length ? `WHERE ${preds.join(' AND ')}` : '';
    return this.refRows<{ fdc_id: number; description: string }>(
      `SELECT fdc_id, description FROM foods ${where} ORDER BY description LIMIT ?`,
      [limit],
    ).map((r) => this.refFood(r));
  }

  private refSearch(key: string, limit: number, filters?: FoodFilters): FoodSummary[] {
    if (!this.ref || !key || limit <= 0) return [];
    const preds = refFilterPredicates(filters);
    const and = preds.length ? ` AND ${preds.join(' AND ')}` : '';
    return this.refRows<{ fdc_id: number; description: string }>(
      `SELECT fdc_id, description FROM foods
       WHERE search_key LIKE ?${and} ORDER BY length(description) LIMIT ?`,
      [`%${key}%`, limit],
    ).map((r) => this.refFood(r));
  }

  private refCount(key: string | null, filters?: FoodFilters): number {
    if (!this.ref) return 0;
    const preds = refFilterPredicates(filters);
    const where = preds.length ? `WHERE ${preds.join(' AND ')}` : '';
    return key
      ? this.refRows<{ n: number }>(`SELECT COUNT(*) AS n FROM foods WHERE search_key LIKE ?${preds.length ? ' AND ' + preds.join(' AND ') : ''}`, [`%${key}%`])[0].n
      : this.refRows<{ n: number }>(`SELECT COUNT(*) AS n FROM foods ${where}`)[0].n;
  }

  private refCountRef(filters?: FoodFilters): number {
    if (!this.ref) return 0;
    const preds = refFilterPredicates(filters);
    const where = preds.length ? `WHERE ${preds.join(' AND ')}` : '';
    return this.refRows<{ n: number }>(`SELECT COUNT(*) AS n FROM foods ${where}`)[0].n;
  }

  private refFood(r: { fdc_id: number; description: string }): FoodSummary {
    let foodTypeId: string | null = null;
    let entryType: string | null = null;
    let publishedAt: string | null = null;
    if (this.ref) {
      const meta = this.refRows<{ food_category: string | null; data_type: string; publication_date: string | null }>(
        'SELECT food_category, data_type, publication_date FROM foods WHERE fdc_id = ?',
        [r.fdc_id],
      )[0];
      if (meta) {
        foodTypeId = meta.food_category ? (REF_CATEGORY_TO_FOOD_TYPE[meta.food_category] ?? null) : null;
        entryType = REF_DATA_TYPE_TO_ENTRY_TYPE[meta.data_type] ?? null;
        publishedAt = meta.publication_date;
      }
    }
    return {
      id: `${REF_PREFIX}${r.fdc_id}`,
      name: r.description,
      brand: null,
      foodTypeId,
      entryType,
      prepState: 'unknown',
      basis: 'per_100g',
      quality: 'verified',
      sourceId: 's_usda',
      publishedAt,
      matchedAlias: null,
    };
  }

  getFood(id: string): FoodDetail | null {
    if (id.startsWith(REF_PREFIX)) return this.getRefFood(id);
    const row = this.rows<Record<string, unknown>>(
      `SELECT id, canonical_name, brand, food_type_id, entry_type, prep_state, basis, data_quality, source_id, published_at FROM foods WHERE id = ?`,
      [id],
    )[0];
    if (!row) return null;
    const nutrients = this.rows<{ nutrient_id: string; amount_milli: number | null }>(
      'SELECT nutrient_id, amount_milli FROM food_nutrients WHERE food_id = ?',
      [id],
    ).map((n) => ({ nutrientId: n.nutrient_id, amountMilli: n.amount_milli }));
    const portions = this.rows<{ id: string; label: string; gram_weight: number; is_default: number }>(
      'SELECT id, label, gram_weight, is_default FROM food_portions WHERE food_id = ? ORDER BY seq',
      [id],
    ).map((p) => ({ id: p.id, label: p.label, gramWeight: p.gram_weight, isDefault: p.is_default === 1 }));
    return { ...mapFood(row), nutrients, portions };
  }

  private getRefFood(id: string): FoodDetail | null {
    if (!this.ref) return null;
    const fdc = Number(id.slice(REF_PREFIX.length));
    if (!Number.isFinite(fdc)) return null;
    const row = this.refRows<{ description: string; food_category: string | null; data_type: string; publication_date: string | null }>(
      'SELECT description, food_category, data_type, publication_date FROM foods WHERE fdc_id = ?',
      [fdc],
    )[0];
    if (!row) return null;

    const foodTypeId = row.food_category ? (REF_CATEGORY_TO_FOOD_TYPE[row.food_category] ?? null) : null;
    const entryType = REF_DATA_TYPE_TO_ENTRY_TYPE[row.data_type] ?? null;

    const codes = Object.keys(REF_CODE_TO_APP);
    const placeholders = codes.map(() => '?').join(',');
    const nutrients = this.refRows<{ code: string; amount: number }>(
      `SELECT n.code AS code, fn.amount AS amount
       FROM food_nutrients fn JOIN nutrients n ON n.id = fn.nutrient_id
       WHERE fn.food_id = ? AND fn.amount IS NOT NULL AND n.code IN (${placeholders})`,
      [fdc, ...codes],
    ).map((n) => ({ nutrientId: REF_CODE_TO_APP[n.code], amountMilli: toMilli(n.amount) }));

    const portions = this.refRows<{
      id: number | null;
      amount: number | null;
      modifier: string | null;
      measure_name: string | null;
      measure_abbr: string | null;
      gram_weight: number;
    }>(
      `SELECT id, amount, modifier, measure_name, measure_abbr, gram_weight
       FROM food_portions
       WHERE food_id = ? AND gram_weight IS NOT NULL AND gram_weight > 0
       ORDER BY seq`,
      [fdc],
    ).map((p, i) => ({
      id: `${REF_PREFIX}p${p.id ?? `${fdc}_${i}`}`,
      label: refPortionLabel(p),
      gramWeight: p.gram_weight,
      isDefault: i === 0,
    }));

    return {
      id,
      name: row.description,
      brand: null,
      foodTypeId,
      entryType,
      prepState: 'unknown',
      basis: 'per_100g',
      quality: 'verified',
      sourceId: 's_usda',
      publishedAt: row.publication_date,
      matchedAlias: null,
      nutrients,
      portions,
    };
  }

  /**
   * Materialize a reference food into the user DB on first log so that
   * log_items.food_id (FK) and recents/history work against the local schema.
   */
  private ensureLocalFood(food: FoodDetail): string {
    if (!food.id.startsWith(REF_PREFIX)) return food.id;
    const fdc = food.id.slice(REF_PREFIX.length);
    const existing = this.rows<{ id: string }>(
      "SELECT id FROM foods WHERE source_id = 's_usda' AND source_record_id = ? LIMIT 1",
      [fdc],
    )[0];
    if (existing) return existing.id;

    const id = `food_${uid()}`;
    const now = Date.now();
    this.db.run('BEGIN');
    try {
      this.run(
        `INSERT INTO foods (id, canonical_name, search_key, brand, category, food_type_id, entry_type, prep_state, basis, language,
                            source_id, source_record_id, data_quality, is_custom, is_recipe, published_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, 'unknown', 'per_100g', 'en', 's_usda', ?, 'derived', 0, 0, ?, ?, ?)`,
        [id, food.name, normalizeKey(food.name), food.foodTypeId, food.entryType, fdc, food.publishedAt, now, now],
      );
      for (const n of food.nutrients) {
        this.run('INSERT INTO food_nutrients (food_id, nutrient_id, amount_milli) VALUES (?, ?, ?)', [
          id,
          n.nutrientId,
          n.amountMilli,
        ]);
      }
      food.portions.forEach((p, i) => {
        this.run(
          'INSERT INTO food_portions (id, food_id, label, gram_weight, is_default, seq) VALUES (?, ?, ?, ?, ?, ?)',
          [`p_${uid()}`, id, p.label, p.gramWeight, p.isDefault ? 1 : 0, i],
        );
      });
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    return id;
  }

  recentFoods(limit = 12): FoodSummary[] {
    return this.rows<Record<string, unknown>>(
      `SELECT f.id, f.canonical_name, f.brand, f.food_type_id, f.entry_type, f.prep_state, f.basis, f.data_quality, f.source_id, f.published_at,
              NULL AS matched_alias, MAX(li.created_at) AS last_used
       FROM log_items li JOIN foods f ON f.id = li.food_id
       WHERE li.is_deleted = 0 AND li.food_id IS NOT NULL
       GROUP BY f.id ORDER BY last_used DESC LIMIT ?`,
      [limit],
    ).map(mapFood);
  }

  /** Recently picked entity ids (latest first) from the lightweight recent_uses table. */
  recentUses(entityType: 'food' | 'exercise', limit = 12): string[] {
    return this.rows<{ entity_id: string }>(
      'SELECT entity_id FROM recent_uses WHERE entity_type = ? ORDER BY last_used_at DESC LIMIT ?',
      [entityType, limit],
    ).map((r) => r.entity_id);
  }

  favoriteIds(entityType: 'food' | 'exercise'): Set<string> {
    return new Set(
      this.rows<{ entity_id: string }>('SELECT entity_id FROM favorites WHERE entity_type = ?', [entityType]).map(
        (r) => r.entity_id,
      ),
    );
  }

  toggleFavorite(entityType: 'food' | 'exercise', id: string): void {
    const exists = this.rows<{ entity_id: string }>(
      'SELECT entity_id FROM favorites WHERE entity_type = ? AND entity_id = ?',
      [entityType, id],
    )[0];
    if (exists) {
      this.run('DELETE FROM favorites WHERE entity_type = ? AND entity_id = ?', [entityType, id]);
    } else {
      this.run('INSERT INTO favorites (entity_type, entity_id, created_at) VALUES (?, ?, ?)', [
        entityType,
        id,
        Date.now(),
      ]);
    }
    this.commit();
  }

  /** Record that an entity was picked/used (drives recent_uses ordering). */
  touchUse(entityType: 'food' | 'exercise', id: string): void {
    this.run(
      `INSERT INTO recent_uses (entity_type, entity_id, last_used_at) VALUES (?, ?, ?)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
      [entityType, id, Date.now()],
    );
    this.commit();
  }

  createCustomFood(name: string, nutrients: NutrientValue[]): FoodDetail {
    const id = `food_${uid()}`;
    const now = Date.now();
    this.db.run('BEGIN');
    try {
      this.run(
        `INSERT INTO foods (id, canonical_name, search_key, entry_type, prep_state, basis, source_id, data_quality, is_custom, is_recipe, created_at, updated_at)
         VALUES (?, ?, ?, 'custom', 'unknown', 'per_100g', 's_user', 'user', 1, 0, ?, ?)`,
        [id, name, normalizeKey(name), now, now],
      );
      for (const n of nutrients) {
        this.run('INSERT INTO food_nutrients (food_id, nutrient_id, amount_milli) VALUES (?, ?, ?)', [
          id,
          n.nutrientId,
          n.amountMilli,
        ]);
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this.commit();
    return this.getFood(id)!;
  }

  addBodyMetric(input: { metricType: BodyMetricType; value: number; localDate: string; note?: string }): void {
    this.run(
      `INSERT INTO body_metrics (id, metric_type, value, local_date, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uid(), input.metricType, input.value, input.localDate, input.note ?? null, Date.now(), Date.now()],
    );
    this.commit();
  }

  getBodyMetrics(metricType: BodyMetricType, limit = 30): BodyMetric[] {
    return this.rows<{ id: string; metric_type: string; value: number; local_date: string; note: string | null; created_at: number }>(
      `SELECT id, metric_type, value, local_date, note, created_at FROM body_metrics
       WHERE metric_type = ? ORDER BY local_date DESC, created_at DESC LIMIT ?`,
      [metricType, limit],
    ).map((r) => ({
      id: r.id,
      metricType: r.metric_type as BodyMetricType,
      value: r.value,
      localDate: r.local_date,
      note: r.note,
      createdAt: r.created_at,
    }));
  }

  deleteBodyMetric(id: string): void {
    this.run('DELETE FROM body_metrics WHERE id = ?', [id]);
    this.commit();
  }

  // ── logging ──────────────────────────────────────────────
  logFood(input: {
    foodId: string;
    quantityG: number;
    portionLabel?: string;
    mealSection: string;
    localDate: string;
    tzOffsetMin?: number;
  }): void {
    const food = this.getFood(input.foodId);
    if (!food) throw new Error(`Unknown food: ${input.foodId}`);
    const localFoodId = this.ensureLocalFood(food);
    this.touchUse('food', input.foodId);
    const foodLike: FoodLike = { id: food.id, name: food.name, basis: food.basis as FoodLike['basis'], nutrients: food.nutrients };
    const item: LogItem = snapshotLogItem({ food: foodLike, quantityG: input.quantityG });
    const logId = `log_${uid()}`;
    const now = Date.now();

    this.db.run('BEGIN');
    try {
      this.run('INSERT OR IGNORE INTO log_days (local_date, tz_offset_min) VALUES (?, ?)', [
        input.localDate,
        input.tzOffsetMin ?? 0,
      ]);
      this.run(
        `INSERT INTO log_items (id, local_date, meal_section, food_id, label, quantity_g, portion_label, source_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [logId, input.localDate, input.mealSection, localFoodId, item.label, item.quantityG, input.portionLabel ?? null, food.sourceId, now, now],
      );
      for (const n of item.nutrients) {
        this.run(
          'INSERT INTO log_item_nutrients (log_item_id, nutrient_id, amount_milli, was_unknown) VALUES (?, ?, ?, ?)',
          [logId, n.nutrientId, n.amountMilli, n.wasUnknown ? 1 : 0],
        );
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this.commit();
  }

  getDayItems(localDate: string): DayItemRow[] {
    const items = this.rows<{ id: string; meal_section: string; label: string; quantity_g: number | null; portion_label: string | null }>(
      `SELECT id, meal_section, label, quantity_g, portion_label FROM log_items
       WHERE local_date = ? AND is_deleted = 0 ORDER BY created_at`,
      [localDate],
    );
    return items.map((it) => ({
      id: it.id,
      mealSection: it.meal_section,
      label: it.label,
      quantityG: it.quantity_g,
      portionLabel: it.portion_label,
      nutrients: this.rows<{ nutrient_id: string; amount_milli: number | null; was_unknown: number }>(
        'SELECT nutrient_id, amount_milli, was_unknown FROM log_item_nutrients WHERE log_item_id = ?',
        [it.id],
      ).map((n) => ({ nutrientId: n.nutrient_id, amountMilli: n.amount_milli, wasUnknown: n.was_unknown === 1 })),
    }));
  }

  deleteLogItem(id: string): void {
    this.run('UPDATE log_items SET is_deleted = 1, updated_at = ? WHERE id = ?', [Date.now(), id]);
    this.commit();
  }

  /** Distinct meal sections that have at least one live logged item. */
  getUsedMealSections(): string[] {
    return this.rows<{ meal_section: string }>(
      'SELECT DISTINCT meal_section FROM log_items WHERE is_deleted = 0 ORDER BY meal_section',
    ).map((r) => r.meal_section);
  }

  // ── exercises / training ─────────────────────────────────
  searchExercises(query: string, limit = 25, filters?: ExerciseFilters): ExerciseSummary[] {
    const key = normalizeKey(query);
    const fw = localExerciseFilter(filters);
    const rows = this.rows<Record<string, unknown>>(
      `SELECT e.id, e.canonical_name, e.unilateral, e.category_id,
              (SELECT a.alias FROM exercise_aliases a WHERE a.exercise_id = e.id AND lower(a.alias) LIKE ? LIMIT 1) AS matched_alias
       FROM exercises e
       WHERE e.is_deleted = 0 AND (? = '' OR e.search_key LIKE ? OR e.id IN (SELECT exercise_id FROM exercise_aliases WHERE lower(alias) LIKE ?))
         ${fw.sql}
       ORDER BY length(e.canonical_name) LIMIT ?`,
      [`%${key}%`, key, `%${key}%`, `%${key}%`, ...fw.params, limit],
    );
    return this.toExerciseSummaries(rows);
  }

  private toExerciseSummaries(rows: Record<string, unknown>[]): ExerciseSummary[] {
    if (!rows.length) return [];
    const equipment = this.groupBy(
      'SELECT ee.exercise_id AS k, eq.name AS v FROM exercise_equipment ee JOIN equipment eq ON eq.id = ee.equipment_id',
    );
    const primary = this.groupBy(
      "SELECT em.exercise_id AS k, m.name AS v FROM exercise_muscles em JOIN muscles m ON m.id = em.muscle_id WHERE em.role = 'primary'",
    );
    return rows.map((r) => ({
      id: r.id as string,
      name: r.canonical_name as string,
      unilateral: r.unilateral === 1,
      categoryId: (r.category_id as string) ?? null,
      equipment: equipment.get(r.id as string) ?? [],
      primaryMuscles: primary.get(r.id as string) ?? [],
      matchedAlias: (r.matched_alias as string) ?? null,
    }));
  }

  getExercise(id: string): ExerciseSummary | null {
    const rows = this.rows<Record<string, unknown>>(
      `SELECT e.id, e.canonical_name, e.unilateral, e.category_id, NULL AS matched_alias
       FROM exercises e WHERE e.id = ? AND e.is_deleted = 0`,
      [id],
    );
    return this.toExerciseSummaries(rows)[0] ?? null;
  }

  /** Total exercises matching a query and filters (mirrors searchExercises). */
  countExercises(query: string, filters?: ExerciseFilters): number {
    const key = normalizeKey(query);
    const fw = localExerciseFilter(filters);
    return (
      this.rows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM exercises e
         WHERE e.is_deleted = 0 AND (? = '' OR e.search_key LIKE ? OR e.id IN (SELECT exercise_id FROM exercise_aliases WHERE lower(alias) LIKE ?))
         ${fw.sql}`,
        [key, `%${key}%`, `%${key}%`, ...fw.params],
      )[0]?.n ?? 0
    );
  }

  /** Exercise facet counts for the catalogue matching `query`. */
  getExerciseFacets(query: string): ExerciseFacets {
    const key = normalizeKey(query);
    const like = key ? `%${key}%` : '%';

    const categories = new Map<string, number>();
    for (const r of this.rows<{ id: string; n: number }>(
      `SELECT e.category_id AS id, COUNT(*) AS n FROM exercises e
       WHERE e.is_deleted = 0 AND (? = '' OR e.search_key LIKE ? OR e.id IN (SELECT exercise_id FROM exercise_aliases WHERE lower(alias) LIKE ?))
       GROUP BY e.category_id`,
      [key, like, like],
    )) {
      if (r.id) categories.set(r.id, r.n);
    }

    const equipment = new Map<string, number>();
    for (const r of this.rows<{ id: string; n: number }>(
      `SELECT eq.id AS id, COUNT(*) AS n FROM exercise_equipment ee
       JOIN equipment eq ON eq.id = ee.equipment_id
       JOIN exercises e ON e.id = ee.exercise_id
       WHERE e.is_deleted = 0 AND (? = '' OR e.search_key LIKE ? OR e.id IN (SELECT exercise_id FROM exercise_aliases WHERE lower(alias) LIKE ?))
       GROUP BY eq.id`,
      [key, like, like],
    )) {
      equipment.set(r.id, r.n);
    }

    const muscles = new Map<string, number>();
    for (const r of this.rows<{ id: string; n: number }>(
      `SELECT m.id AS id, COUNT(*) AS n FROM exercise_muscles em
       JOIN muscles m ON m.id = em.muscle_id
       JOIN exercises e ON e.id = em.exercise_id
       WHERE em.role = 'primary' AND e.is_deleted = 0 AND (? = '' OR e.search_key LIKE ? OR e.id IN (SELECT exercise_id FROM exercise_aliases WHERE lower(alias) LIKE ?))
       GROUP BY m.id`,
      [key, like, like],
    )) {
      muscles.set(r.id, r.n);
    }

    return {
      categories: EXERCISE_CATEGORY_VOCAB.map(([id]) => ({
        id,
        name: EXERCISE_CATEGORY_VOCAB_BY_ID[id],
        count: categories.get(id) ?? 0,
      })),
      equipment: EQUIPMENT_VOCAB.map(([id, name]) => ({ id, name, count: equipment.get(id) ?? 0 })),
      muscles: MUSCLE_COUNTS_VOCAB.map(([id, name]) => ({ id, name, count: muscles.get(id) ?? 0 })),
    };
  }

  getExerciseMuscles(id: string): { primary: string[]; secondary: string[] } {
    const rows = this.rows<{ muscle_id: string; role: string }>(
      'SELECT muscle_id, role FROM exercise_muscles WHERE exercise_id = ?',
      [id],
    );
    return {
      primary: rows.filter((r) => r.role === 'primary').map((r) => r.muscle_id),
      secondary: rows.filter((r) => r.role === 'secondary').map((r) => r.muscle_id),
    };
  }

  getMuscleNames(): Map<string, string> {
    const map = new Map<string, string>();
    for (const r of this.rows<{ id: string; name: string }>('SELECT id, name FROM muscles')) {
      map.set(r.id, r.name);
    }
    return map;
  }

  startWorkout(name: string, localDate: string, tzOffsetMin = 0): string {
    const id = `wo_${uid()}`;
    this.run(
      `INSERT INTO workouts (id, name, started_at, local_date, tz_offset_min, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, name, Date.now(), localDate, tzOffsetMin, Date.now()],
    );
    this.commit();
    return id;
  }

  getActiveWorkout(localDate: string): WorkoutRow | null {
    const row = this.rows<{ id: string; name: string; routine_id: string | null; started_at: number; ended_at: number | null }>(
      'SELECT id, name, routine_id, started_at, ended_at FROM workouts WHERE local_date = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
      [localDate],
    )[0];
    return row ? this.buildWorkout(row) : null;
  }

  addExercise(workoutId: string, exerciseId: string): string {
    const id = `we_${uid()}`;
    const seq = this.rows<{ n: number }>('SELECT COUNT(*) AS n FROM workout_exercises WHERE workout_id = ?', [workoutId])[0].n;
    this.run('INSERT INTO workout_exercises (id, workout_id, exercise_id, seq) VALUES (?, ?, ?, ?)', [
      id,
      workoutId,
      exerciseId,
      seq,
    ]);
    this.touchUse('exercise', exerciseId);
    this.commit();
    return id;
  }

  logSet(workoutExerciseId: string, input: LogSetInput): { setId: string; prs: PRKind[] } {
    const id = `set_${uid()}`;
    const setIndex =
      (this.rows<{ n: number }>('SELECT COUNT(*) AS n FROM sets WHERE workout_exercise_id = ?', [workoutExerciseId])[0]
        ?.n ?? 0) + 1;

    const we = this.rows<{ exercise_id: string }>('SELECT exercise_id FROM workout_exercises WHERE id = ?', [
      workoutExerciseId,
    ])[0];
    if (!we) throw new Error('Unknown workout exercise');

    // Capture PR baseline BEFORE inserting the new set, otherwise the new set
    // is already part of the state and can never register as an improvement.
    const priorState = this.currentPRState(we.exercise_id);

    let prs: PRKind[] = [];
    this.db.run('BEGIN');
    try {
      this.run(
        `INSERT INTO sets (id, workout_exercise_id, set_index, set_type, reps, load_g, is_bodyweight, side, rir, is_completed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          id,
          workoutExerciseId,
          setIndex,
          input.setType,
          input.reps,
          input.loadG,
          input.isBodyweight ? 1 : 0,
          input.side ?? null,
          input.rir,
          Date.now(),
        ],
      );

      if (input.setType === 'working' && input.reps != null && input.loadG != null && input.loadG > 0) {
        const result = evaluateSet(priorState, input.loadG, input.reps);
        prs = result.prs;
        for (const pr of result.prs) {
          this.run(
            `INSERT INTO personal_records (id, exercise_id, pr_type, value_primary, value_secondary, set_id, achieved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [uid(), we.exercise_id, pr, result.state.e1rmG, input.loadG, id, Date.now()],
          );
        }
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this.commit();
    return { setId: id, prs };
  }

  finishWorkout(workoutId: string): void {
    this.run('UPDATE workouts SET ended_at = ? WHERE id = ?', [Date.now(), workoutId]);
    this.commit();
  }

  // ── workout-plan templates (routines) ────────────────────
  listRoutines(): RoutineSummary[] {
    return this.rows<{ id: string; name: string; notes: string | null; updated_at: number; n: number }>(
      `SELECT r.id, r.name, r.notes, r.updated_at, COUNT(re.id) AS n
       FROM routines r LEFT JOIN routine_exercises re ON re.routine_id = r.id
       WHERE r.is_deleted = 0
       GROUP BY r.id ORDER BY r.updated_at DESC`,
    ).map((r) => ({ id: r.id, name: r.name, notes: r.notes, exerciseCount: r.n, updatedAt: r.updated_at }));
  }

  getRoutine(id: string): RoutineDetail | null {
    const row = this.rows<{ id: string; name: string; notes: string | null; updated_at: number }>(
      'SELECT id, name, notes, updated_at FROM routines WHERE id = ? AND is_deleted = 0',
      [id],
    )[0];
    if (!row) return null;
    const exercises = this.rows<{
      id: string;
      exercise_id: string;
      canonical_name: string;
      target_sets: number | null;
      target_reps: string | null;
      target_rir: number | null;
      rest_sec: number | null;
      seq: number;
    }>(
      `SELECT re.id, re.exercise_id, e.canonical_name, re.target_sets, re.target_reps, re.target_rir, re.rest_sec, re.seq
       FROM routine_exercises re JOIN exercises e ON e.id = re.exercise_id
       WHERE re.routine_id = ? ORDER BY re.seq`,
      [id],
    ).map((r) => ({
      id: r.id,
      exerciseId: r.exercise_id,
      name: r.canonical_name,
      targetSets: r.target_sets,
      targetReps: r.target_reps,
      targetRir: r.target_rir,
      restSec: r.rest_sec,
      seq: r.seq,
    }));
    return {
      id: row.id,
      name: row.name,
      notes: row.notes,
      exerciseCount: exercises.length,
      updatedAt: row.updated_at,
      exercises,
    };
  }

  saveRoutine(input: RoutineInput): string {
    const id = input.id ?? `rt_${uid()}`;
    const now = Date.now();
    this.db.run('BEGIN');
    try {
      const exists = this.rows<{ id: string }>('SELECT id FROM routines WHERE id = ?', [id])[0];
      if (exists) {
        this.run('UPDATE routines SET name = ?, notes = ?, updated_at = ?, is_deleted = 0 WHERE id = ?', [
          input.name,
          input.notes ?? null,
          now,
          id,
        ]);
        this.run('DELETE FROM routine_exercises WHERE routine_id = ?', [id]);
      } else {
        this.run(
          'INSERT INTO routines (id, name, notes, created_at, updated_at, is_deleted) VALUES (?, ?, ?, ?, ?, 0)',
          [id, input.name, input.notes ?? null, now, now],
        );
      }
      input.exercises.forEach((ex, i) => {
        this.run(
          `INSERT INTO routine_exercises (id, routine_id, exercise_id, target_sets, target_reps, target_rir, rest_sec, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `rte_${uid()}`,
            id,
            ex.exerciseId,
            ex.targetSets ?? null,
            ex.targetReps ?? null,
            ex.targetRir ?? null,
            ex.restSec ?? null,
            i,
          ],
        );
      });
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this.commit();
    return id;
  }

  deleteRoutine(id: string): void {
    this.run('UPDATE routines SET is_deleted = 1, updated_at = ? WHERE id = ?', [Date.now(), id]);
    this.commit();
  }

  startWorkoutFromRoutine(routineId: string, localDate: string, tzOffsetMin = 0): string | null {
    const routine = this.getRoutine(routineId);
    if (!routine) return null;
    const id = `wo_${uid()}`;
    const now = Date.now();
    this.db.run('BEGIN');
    try {
      this.run(
        'INSERT INTO workouts (id, routine_id, name, started_at, local_date, tz_offset_min, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, routine.id, routine.name, now, localDate, tzOffsetMin, now],
      );
      routine.exercises.forEach((ex, i) => {
        this.run(
          `INSERT INTO workout_exercises (id, workout_id, exercise_id, seq, target_sets, target_reps, target_rir)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [`we_${uid()}`, id, ex.exerciseId, i, ex.targetSets, ex.targetReps, ex.targetRir],
        );
        // Inline recents upsert (touchUse() persists and would break the txn).
        this.run(
          `INSERT INTO recent_uses (entity_type, entity_id, last_used_at) VALUES ('exercise', ?, ?)
           ON CONFLICT(entity_type, entity_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
          [ex.exerciseId, now],
        );
      });
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this.commit();
    return id;
  }

  /** Most recent completed working set for an exercise (prefill convenience). */
  getLastSetForExercise(exerciseId: string): LastSetHint | null {
    const r = this.rows<{ load_g: number | null; reps: number | null; rir: number | null }>(
      `SELECT s.load_g, s.reps, s.rir
       FROM sets s JOIN workout_exercises we ON we.id = s.workout_exercise_id
       WHERE we.exercise_id = ? AND s.is_completed = 1 AND s.set_type IN ('working','failure','amrap')
       ORDER BY s.created_at DESC, s.set_index DESC LIMIT 1`,
      [exerciseId],
    )[0];
    return r ? { loadG: r.load_g, reps: r.reps, rir: r.rir } : null;
  }

  getWeeklyVolume(fromDate: string, toDate: string, secondaryFactor = 0.5): Map<string, number> {
    const rows = this.rows<{
      reps: number | null;
      load_g: number | null;
      set_type: SetRecord['setType'];
      is_completed: number;
      is_bodyweight: number;
      exercise_id: string;
      canonical_name: string;
    }>(
      `SELECT s.reps, s.load_g, s.set_type, s.is_completed, s.is_bodyweight, we.exercise_id, e.canonical_name
       FROM sets s
       JOIN workout_exercises we ON we.id = s.workout_exercise_id
       JOIN workouts w ON w.id = we.workout_id
       JOIN exercises e ON e.id = we.exercise_id
       WHERE w.local_date >= ? AND w.local_date <= ?`,
      [fromDate, toDate],
    );
    const muscleMap = new Map<string, { primary: string[]; secondary: string[] }>();
    for (const r of rows) {
      if (!muscleMap.has(r.exercise_id)) muscleMap.set(r.exercise_id, this.getExerciseMuscles(r.exercise_id));
    }
    const entries: SetWithExercise[] = rows.map((r) => ({
      set: {
        setType: r.set_type,
        reps: r.reps,
        loadG: r.load_g,
        isBodyweight: r.is_bodyweight === 1,
        completed: r.is_completed === 1,
      },
      exercise: {
        id: r.exercise_id,
        canonicalName: r.canonical_name,
        primaryMuscles: muscleMap.get(r.exercise_id)?.primary ?? [],
        secondaryMuscles: muscleMap.get(r.exercise_id)?.secondary ?? [],
      },
    }));
    return workingSetVolumeByMuscle(entries, secondaryFactor);
  }

  // ── helpers ──────────────────────────────────────────────
  private buildWorkout(row: {
    id: string;
    name: string;
    routine_id: string | null;
    started_at: number;
    ended_at: number | null;
  }): WorkoutRow {
    const exercises = this.rows<{
      id: string;
      exercise_id: string;
      canonical_name: string;
      unilateral: number;
      target_sets: number | null;
      target_reps: string | null;
      target_rir: number | null;
    }>(
      `SELECT we.id, we.exercise_id, e.canonical_name, e.unilateral, we.target_sets, we.target_reps, we.target_rir
       FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id
       WHERE we.workout_id = ? ORDER BY we.seq`,
      [row.id],
    ).map((we) => ({
      id: we.id,
      exerciseId: we.exercise_id,
      name: we.canonical_name,
      unilateral: we.unilateral === 1,
      targetSets: we.target_sets,
      targetReps: we.target_reps,
      targetRir: we.target_rir,
      sets: this.rows<{ id: string; set_index: number; set_type: SetRecord['setType']; reps: number | null; load_g: number | null; rir: number | null; is_completed: number }>(
        'SELECT id, set_index, set_type, reps, load_g, rir, is_completed FROM sets WHERE workout_exercise_id = ? ORDER BY set_index',
        [we.id],
      ).map((s) => ({
        id: s.id,
        setIndex: s.set_index,
        setType: s.set_type,
        reps: s.reps,
        loadG: s.load_g,
        rir: s.rir,
        isCompleted: s.is_completed === 1,
      })),
    }));
    return {
      id: row.id,
      name: row.name,
      routineId: row.routine_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      exercises,
    };
  }

  private currentPRState(exerciseId: string): PRState {
    const state = emptyPRState();
    const rows = this.rows<{ reps: number | null; load_g: number | null }>(
      `SELECT s.reps, s.load_g FROM sets s
       JOIN workout_exercises we ON we.id = s.workout_exercise_id
       WHERE we.exercise_id = ? AND s.set_type = 'working' AND s.is_completed = 1`,
      [exerciseId],
    );
    for (const r of rows) {
      if (r.reps != null && r.load_g != null && r.load_g > 0) {
        const next = evaluateSet(state, r.load_g, r.reps);
        Object.assign(state, next.state);
      }
    }
    return state;
  }

  private groupBy(sql: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const r of this.rows<{ k: string; v: string }>(sql)) {
      const arr = map.get(r.k) ?? [];
      arr.push(r.v);
      map.set(r.k, arr);
    }
    return map;
  }

  private commit(): void {
    persist(this.db);
  }
}

function queryAll<T>(db: DB, sql: string, params: unknown[]): T[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params as never);
    const out: T[] = [];
    while (stmt.step()) out.push(stmt.getAsObject() as unknown as T);
    return out;
  } finally {
    stmt.free();
  }
}

function mapFood(r: Record<string, unknown>): FoodSummary {
  return {
    id: r.id as string,
    name: r.canonical_name as string,
    brand: (r.brand as string) || null,
    foodTypeId: (r.food_type_id as string) ?? null,
    entryType: (r.entry_type as string) ?? null,
    prepState: (r.prep_state as string) ?? 'unknown',
    basis: (r.basis as string) ?? 'per_100g',
    quality: (r.data_quality as string) ?? 'unverified',
    sourceId: r.source_id as string,
    publishedAt: (r.published_at as string) ?? null,
    matchedAlias: (r.matched_alias as string) ?? null,
  };
}

// Vocabulary lists used for facets. Fixed ids (real schema values); displayed
// names come from the schema vocabulary tables at runtime where possible and
// from app-authored labels otherwise. Kept in sync with db/schema.sql + db/seed.sql.
export const FOOD_TYPE_VOCAB: [string, string][] = [
  ['grains', 'Grains & cereals'],
  ['legumes', 'Pulses & legumes'],
  ['vegetables', 'Vegetables'],
  ['fruits', 'Fruits'],
  ['dairy', 'Dairy'],
  ['eggs', 'Eggs'],
  ['meat', 'Meat & poultry'],
  ['seafood', 'Seafood'],
  ['oils', 'Oils & fats'],
  ['nuts', 'Nuts & seeds'],
  ['snacks', 'Snacks & sweets'],
  ['beverages', 'Beverages'],
  ['supplements', 'Supplements'],
  ['mixed_dishes', 'Mixed dishes'],
  ['other', 'Other'],
];

export const ENTRY_TYPE_VOCAB: [string, string][] = [
  ['generic', 'Generic'],
  ['prepared', 'Prepared'],
  ['branded', 'Branded'],
  ['custom', 'My foods'],
];

const ENTRY_TYPE_VOCAB_BY_ID = Object.fromEntries(ENTRY_TYPE_VOCAB);

export const PREP_STATE_VOCAB: [string, string][] = [
  ['raw', 'Raw'],
  ['cooked', 'Cooked'],
  ['boiled', 'Boiled'],
  ['steamed', 'Steamed'],
  ['roasted', 'Roasted'],
  ['fried', 'Fried'],
  ['baked', 'Baked'],
  ['dried', 'Dried'],
  ['canned', 'Canned'],
  ['frozen', 'Frozen'],
  ['as_sold', 'As sold'],
  ['prepared', 'Prepared'],
  ['unknown', 'Unknown'],
];

const PREP_STATE_VOCAB_BY_ID = Object.fromEntries(PREP_STATE_VOCAB);

export const EXERCISE_CATEGORY_VOCAB: [string, string][] = [
  ['resistance', 'Resistance'],
  ['cardio', 'Cardio'],
  ['mobility', 'Mobility'],
  ['stretching', 'Stretching'],
  ['other', 'Other'],
];

const EXERCISE_CATEGORY_VOCAB_BY_ID = Object.fromEntries(EXERCISE_CATEGORY_VOCAB);

// Exercise devices from the Free Exercise DB importer + app seed.
export const EQUIPMENT_VOCAB: [string, string][] = [
  ['barbell', 'Barbell'],
  ['dumbbell', 'Dumbbell'],
  ['cable', 'Cable'],
  ['machine', 'Machine'],
  ['bodyweight', 'Bodyweight'],
  ['band', 'Band'],
  ['kettlebell', 'Kettlebell'],
  ['ez_bar', 'E-Z curl bar'],
  ['medicine_ball', 'Medicine ball'],
  ['exercise_ball', 'Exercise ball'],
];

// Primary-muscle facets (muscles actually used by exercises in the catalogue).
export const MUSCLE_COUNTS_VOCAB: [string, string][] = [
  ['chest', 'Chest'],
  ['shoulders', 'Shoulders'],
  ['triceps', 'Triceps'],
  ['biceps', 'Biceps'],
  ['back', 'Back'],
  ['lats', 'Lats'],
  ['traps', 'Traps'],
  ['forearms', 'Forearms'],
  ['core', 'Core'],
  ['neck', 'Neck'],
  ['quads', 'Quads'],
  ['hamstrings', 'Hamstrings'],
  ['glutes', 'Glutes'],
  ['calves', 'Calves'],
  ['adductors', 'Adductors'],
  ['abductors', 'Abductors'],
];

// Body metrics the user can log in the Metrics tab.
export const BODY_METRIC_TYPES: [BodyMetricType, string][] = [
  ['weight_kg', 'Weight (kg)'],
  ['body_fat_pct', 'Body fat (%)'],
  ['height_cm', 'Height (cm)'],
  ['waist_cm', 'Waist (cm)'],
  ['other', 'Other'],
];

/** WHERE fragment + params for food facet filters against the local foods table. */
function localFoodFilter(filters?: FoodFilters): { sql: string; params: unknown[] } {
  if (!filters) return { sql: '', params: [] };
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.foodTypeId) {
    clauses.push('food_type_id = ?');
    params.push(filters.foodTypeId);
  }
  if (filters.entryType) {
    clauses.push('entry_type = ?');
    params.push(filters.entryType);
  }
  if (filters.prepState) {
    clauses.push('prep_state = ?');
    params.push(filters.prepState);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

/** WHERE fragment + params for exercise facet filters against the exercises table. */
function localExerciseFilter(filters?: ExerciseFilters): { sql: string; params: unknown[] } {
  if (!filters) return { sql: '', params: [] };
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.categoryId) {
    clauses.push('e.category_id = ?');
    params.push(filters.categoryId);
  }
  if (filters.equipmentId) {
    clauses.push(
      'e.id IN (SELECT exercise_id FROM exercise_equipment WHERE equipment_id = ?)',
    );
    params.push(filters.equipmentId);
  }
  if (filters.muscleId) {
    clauses.push(
      'e.id IN (SELECT exercise_id FROM exercise_muscles WHERE muscle_id = ? AND role = \'primary\')',
    );
    params.push(filters.muscleId);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

/** WHERE-fragment predicates for reference-pack food filters (ref schema columns). */
function refFilterPredicates(filters?: FoodFilters): string[] {
  if (!filters) return [];
  const parts: string[] = [];
  if (filters.foodTypeId) {
    const cats = Object.entries(REF_CATEGORY_TO_FOOD_TYPE)
      .filter(([, t]) => t === filters.foodTypeId)
      .map(([c]) => `'${c.replace(/'/g, "''")}'`);
    if (!cats.length) return ['(0)'];
    parts.push(`(food_category IN (${cats.join(',')}))`);
  }
  if (filters.entryType) {
    const dts = Object.entries(REF_DATA_TYPE_TO_ENTRY_TYPE)
      .filter(([, t]) => t === filters.entryType)
      .map(([d]) => `'${d.replace(/'/g, "''")}'`);
    if (!dts.length) return ['(0)'];
    parts.push(`(data_type IN (${dts.join(',')}))`);
  }
  if (filters.prepState && filters.prepState !== 'unknown') return ['(0)'];
  return parts;
}
