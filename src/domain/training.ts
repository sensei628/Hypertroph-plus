// Hypertrophy analytics. All formulas are intentionally simple and documented,
// matching the definitions in the plan (doc 07 section 6).

export interface SetRecord {
  setType: 'working' | 'warmup' | 'drop' | 'failure' | 'amrap';
  reps: number | null;
  loadG: number | null; // load in grams (canonical); null for bodyweight-only
  isBodyweight: boolean;
  completed: boolean;
}

export interface ExerciseInfo {
  id: string;
  canonicalName: string;
  primaryMuscles: string[];
  secondaryMuscles: string[];
}

export interface SetWithExercise {
  set: SetRecord;
  exercise: ExerciseInfo;
}

/** Estimated 1RM via Epley: load * (1 + reps/30). Estimate only. */
export function e1rmG(loadG: number, reps: number): number {
  if (reps <= 0) return 0;
  return Math.round(loadG * (1 + reps / 30));
}

export function setVolumeG(loadG: number, reps: number): number {
  return loadG * reps;
}

export function volumeLoadG(sets: SetRecord[]): number {
  let total = 0;
  for (const s of sets) {
    if (!s.completed || s.setType !== 'working') continue;
    if (s.loadG == null || s.reps == null) continue;
    total += s.loadG * s.reps;
  }
  return total;
}

/**
 * Weekly working-set volume per muscle group.
 * Warm-up / incomplete sets excluded. Primary counted 1x; secondary counted at
 * `secondaryFactor` (default 0.5, configurable and shown in the UI).
 */
export function workingSetVolumeByMuscle(
  entries: SetWithExercise[],
  secondaryFactor = 0.5,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const { set, exercise } of entries) {
    if (!set.completed || set.setType !== 'working') continue;
    for (const m of exercise.primaryMuscles) {
      out.set(m, (out.get(m) ?? 0) + 1);
    }
    for (const m of exercise.secondaryMuscles) {
      out.set(m, (out.get(m) ?? 0) + secondaryFactor);
    }
  }
  return out;
}

export interface PRState {
  e1rmG: number;
  repsAtLoad: Map<number, number>;
  setVolumeG: number;
}

export function emptyPRState(): PRState {
  return { e1rmG: 0, repsAtLoad: new Map(), setVolumeG: 0 };
}

export type PRKind = 'e1rm' | 'reps_at_load' | 'set_volume';

/** Evaluate a completed working set against current PR state; returns updated state + new PR kinds. */
export function evaluateSet(
  state: PRState,
  loadG: number,
  reps: number,
): { state: PRState; prs: PRKind[] } {
  const prs: PRKind[] = [];
  const next: PRState = {
    e1rmG: state.e1rmG,
    repsAtLoad: new Map(state.repsAtLoad),
    setVolumeG: state.setVolumeG,
  };

  const e = e1rmG(loadG, reps);
  if (e > next.e1rmG) {
    next.e1rmG = e;
    prs.push('e1rm');
  }

  const bestReps = next.repsAtLoad.get(loadG) ?? 0;
  if (reps > bestReps) {
    next.repsAtLoad.set(loadG, reps);
    prs.push('reps_at_load');
  }

  const v = setVolumeG(loadG, reps);
  if (v > next.setVolumeG) {
    next.setVolumeG = v;
    prs.push('set_volume');
  }

  return { state: next, prs };
}

/** Unit helpers for kg/lb display. Canonical storage is grams. */
export const LB_PER_KG = 2.2046226218;

export function kgToG(kg: number): number {
  return Math.round(kg * 1000);
}

export function gToKg(g: number): number {
  return g / 1000;
}

export function lbToG(lb: number): number {
  return Math.round((lb / LB_PER_KG) * 1000);
}

export function gToLb(g: number): number {
  return (g / 1000) * LB_PER_KG;
}
