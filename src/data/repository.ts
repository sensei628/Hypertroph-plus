import type { DB } from './db';
import { persist } from './db';
import { NutrientUnit, Milli } from '../domain/nutrients';
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
  prepState: string;
  basis: string;
  quality: string;
  sourceId: string;
  matchedAlias: string | null;
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
  equipment: string[];
  primaryMuscles: string[];
  matchedAlias: string | null;
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
  sets: SetRow[];
}

export interface WorkoutRow {
  id: string;
  name: string;
  startedAt: number;
  endedAt: number | null;
  exercises: WorkoutExerciseRow[];
}

export interface DataPort {
  getNutrientDefs(): NutrientDef[];
  getTargets(): Map<string, Milli>;
  setTarget(nutrientId: string, targetMilli: Milli | null): void;
  getPreference(key: string, fallback: string): string;
  setPreference(key: string, value: string): void;

  searchFoods(query: string, limit?: number): FoodSummary[];
  getFood(id: string): FoodDetail | null;
  recentFoods(limit?: number): FoodSummary[];
  createCustomFood(name: string, nutrients: NutrientValue[]): FoodDetail;

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

  searchExercises(query: string, limit?: number): ExerciseSummary[];
  getExerciseMuscles(id: string): { primary: string[]; secondary: string[] };
  getMuscleNames(): Map<string, string>;

  startWorkout(name: string, localDate: string, tzOffsetMin?: number): string;
  getActiveWorkout(localDate: string): WorkoutRow | null;
  addExercise(workoutId: string, exerciseId: string): string;
  logSet(workoutExerciseId: string, input: LogSetInput): { setId: string; prs: PRKind[] };
  finishWorkout(workoutId: string): void;
  getWeeklyVolume(fromDate: string, toDate: string, secondaryFactor?: number): Map<string, number>;
}

export class SqliteRepository implements DataPort {
  constructor(private db: DB) {}

  private rows<T>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as never);
      const out: T[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as unknown as T);
      return out;
    } finally {
      stmt.free();
    }
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

  setPreference(key: string, value: string): void {
    this.run(
      `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), Date.now()],
    );
    this.commit();
  }

  // ── foods ────────────────────────────────────────────────
  searchFoods(query: string, limit = 25): FoodSummary[] {
    const key = normalizeKey(query);
    if (!key) {
      return this.rows<Record<string, unknown>>(
        `SELECT id, canonical_name, brand, prep_state, basis, data_quality, source_id FROM foods
         WHERE is_deleted = 0 ORDER BY canonical_name LIMIT ?`,
        [limit],
      ).map(mapFood);
    }
    const like = `%${key}%`;
    const prefix = `${key}%`;
    const escaped = key.replace(/([%_])/g, '\\$1');
    // Rank: alias match, then name-prefix, then name-substring.
    const foodRows = this.rows<Record<string, unknown>>(
      `SELECT f.id, f.canonical_name, f.brand, f.prep_state, f.basis, f.data_quality, f.source_id,
              (SELECT a.alias FROM food_aliases a WHERE a.food_id = f.id AND a.alias LIKE ? LIMIT 1) AS matched_alias,
              CASE WHEN f.search_key LIKE ? THEN 0 ELSE 1 END AS rank
       FROM foods f
       WHERE f.is_deleted = 0 AND (f.search_key LIKE ? OR f.id IN (SELECT food_id FROM food_aliases WHERE lower(alias) LIKE ?))
       ORDER BY rank, length(f.canonical_name) LIMIT ?`,
      [like, prefix, like, like, limit],
    );
    void escaped;
    return foodRows.map(mapFood);
  }

  getFood(id: string): FoodDetail | null {
    const row = this.rows<Record<string, unknown>>(
      `SELECT id, canonical_name, brand, prep_state, basis, data_quality, source_id FROM foods WHERE id = ?`,
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

  recentFoods(limit = 12): FoodSummary[] {
    return this.rows<Record<string, unknown>>(
      `SELECT f.id, f.canonical_name, f.brand, f.prep_state, f.basis, f.data_quality, f.source_id,
              NULL AS matched_alias, MAX(li.created_at) AS last_used
       FROM log_items li JOIN foods f ON f.id = li.food_id
       WHERE li.is_deleted = 0 AND li.food_id IS NOT NULL
       GROUP BY f.id ORDER BY last_used DESC LIMIT ?`,
      [limit],
    ).map(mapFood);
  }

  createCustomFood(name: string, nutrients: NutrientValue[]): FoodDetail {
    const id = `food_${uid()}`;
    const now = Date.now();
    this.db.run('BEGIN');
    try {
      this.run(
        `INSERT INTO foods (id, canonical_name, search_key, prep_state, basis, source_id, data_quality, is_custom, is_recipe, created_at, updated_at)
         VALUES (?, ?, ?, 'unknown', 'per_100g', 's_user', 'user', 1, 0, ?, ?)`,
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
         VALUES (?, ?, ?, ?, ?, ?, ?, 's_usda', ?, ?)`,
        [logId, input.localDate, input.mealSection, input.foodId, item.label, item.quantityG, input.portionLabel ?? null, now, now],
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

  // ── exercises / training ─────────────────────────────────
  searchExercises(query: string, limit = 25): ExerciseSummary[] {
    const key = normalizeKey(query);
    const rows = this.rows<Record<string, unknown>>(
      `SELECT e.id, e.canonical_name, e.unilateral,
              (SELECT a.alias FROM exercise_aliases a WHERE a.exercise_id = e.id AND lower(a.alias) LIKE ? LIMIT 1) AS matched_alias
       FROM exercises e
       WHERE e.is_deleted = 0 AND (? = '' OR e.search_key LIKE ? OR e.id IN (SELECT exercise_id FROM exercise_aliases WHERE lower(alias) LIKE ?))
       ORDER BY length(e.canonical_name) LIMIT ?`,
      [`%${key}%`, key, `%${key}%`, `%${key}%`, limit],
    );
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
      equipment: equipment.get(r.id as string) ?? [],
      primaryMuscles: primary.get(r.id as string) ?? [],
      matchedAlias: (r.matched_alias as string) ?? null,
    }));
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
    const row = this.rows<{ id: string; name: string; started_at: number; ended_at: number | null }>(
      'SELECT id, name, started_at, ended_at FROM workouts WHERE local_date = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
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
  private buildWorkout(row: { id: string; name: string; started_at: number; ended_at: number | null }): WorkoutRow {
    const exercises = this.rows<{ id: string; exercise_id: string; canonical_name: string; unilateral: number }>(
      `SELECT we.id, we.exercise_id, e.canonical_name, e.unilateral
       FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id
       WHERE we.workout_id = ? ORDER BY we.seq`,
      [row.id],
    ).map((we) => ({
      id: we.id,
      exerciseId: we.exercise_id,
      name: we.canonical_name,
      unilateral: we.unilateral === 1,
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
    return { id: row.id, name: row.name, startedAt: row.started_at, endedAt: row.ended_at, exercises };
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

function mapFood(r: Record<string, unknown>): FoodSummary {
  return {
    id: r.id as string,
    name: r.canonical_name as string,
    brand: (r.brand as string) || null,
    prepState: (r.prep_state as string) ?? 'unknown',
    basis: (r.basis as string) ?? 'per_100g',
    quality: (r.data_quality as string) ?? 'unverified',
    sourceId: r.source_id as string,
    matchedAlias: (r.matched_alias as string) ?? null,
  };
}
