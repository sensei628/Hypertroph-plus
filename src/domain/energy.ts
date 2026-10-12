// Energy & macronutrient planning math.
//
// Mifflin–St Jeor is used only as an initial *estimate* of resting energy
// expenditure; it is then scaled by an activity factor to a maintenance (TDEE)
// estimate, and finally adjusted for a goal. Nothing here is persisted or
// auto-applied — the UI shows a preview and the user explicitly applies it.
// All outputs are plain numbers in kcal / grams for the requested day.

export const KCAL_PER_KG = 7700; // ≈ energy in 1 kg of body fat
const PROTEIN_KCAL_PER_G = 4;
const CARB_KCAL_PER_G = 4;
const FAT_KCAL_PER_G = 9;

export const LB_PER_KG = 2.2046226218;

export type Sex = 'male' | 'female';
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'very_active' | 'extra_active';
export type Goal = 'lose' | 'maintain' | 'gain' | 'recomp';

export const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very_active: 1.725,
  extra_active: 1.9,
};

export const ACTIVITY_OPTIONS: { id: ActivityLevel; label: string; factor: number }[] = [
  { id: 'sedentary', label: 'Sedentary — little or no exercise', factor: 1.2 },
  { id: 'light', label: 'Light — 1–3 days/week', factor: 1.375 },
  { id: 'moderate', label: 'Moderate — 3–5 days/week', factor: 1.55 },
  { id: 'very_active', label: 'Very active — 6–7 days/week', factor: 1.725 },
  { id: 'extra_active', label: 'Extra active — physical job / 2× per day', factor: 1.9 },
];

export const GOAL_LABELS: Record<Goal, string> = {
  lose: 'Lose fat',
  maintain: 'Maintain',
  gain: 'Build muscle',
  recomp: 'Recomposition',
};

export const GOAL_OPTIONS: Goal[] = ['lose', 'maintain', 'gain', 'recomp'];

export interface EnergyInputs {
  sex: Sex;
  age: number;
  heightCm: number;
  weightKg: number;
  activity: ActivityLevel;
  goal: Goal;
  /** Target rate of change, magnitude in kg/week (used for lose/gain). */
  rateKgPerWeek: number;
  /** Protein prescription in g per kg body weight. */
  proteinPerKg: number;
  /** Minimum fat floor in g per kg body weight (safety). */
  fatPerKg: number;
  /** Fat share of total calories, as a fraction (0–1). */
  fatPercent: number;
}

export const ENERGY_DEFAULTS = {
  activity: 'moderate' as ActivityLevel,
  goal: 'maintain' as Goal,
  rateKgPerWeek: 0.5,
  proteinPerKg: 1.8,
  fatPerKg: 0.6,
  fatPercent: 0.25,
};

export interface EnergyResult {
  bmr: number;
  tdee: number;
  targetKcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  /** Signed daily calorie change vs. maintenance (negative = deficit). */
  dailyDeltaKcal: number;
  warnings: string[];
}

/** Mifflin–St Jeor resting metabolic rate (kcal/day). */
export function mifflinStJeorBmr(input: { sex: Sex; age: number; heightCm: number; weightKg: number }): number {
  const base = 10 * input.weightKg + 6.25 * input.heightCm - 5 * input.age;
  return input.sex === 'male' ? base + 5 : base - 161;
}

export function activityFactor(level: ActivityLevel): number {
  return ACTIVITY_FACTORS[level] ?? ACTIVITY_FACTORS.moderate;
}

/** Maintenance energy (TDEE): BMR × activity factor. */
export function maintenanceKcal(input: Pick<EnergyInputs, 'sex' | 'age' | 'heightCm' | 'weightKg' | 'activity'>): number {
  return mifflinStJeorBmr(input) * activityFactor(input.activity);
}

/** Input-range warnings. Not blocking — surfaced so the user can adjust. */
export function validateEnergyInputs(i: EnergyInputs): string[] {
  const w: string[] = [];
  if (!(i.weightKg > 0)) w.push('Enter a body weight to estimate energy needs.');
  if (!(i.heightCm > 0)) w.push('Enter a height to estimate energy needs.');
  if (!(i.age > 0)) w.push('Enter an age to estimate energy needs.');
  if (i.proteinPerKg > 0 && i.proteinPerKg < 1) w.push('Protein below 1 g/kg is low for a training goal.');
  if (i.proteinPerKg > 3) w.push('Protein above 3 g/kg is unusually high.');
  if (i.fatPercent < 0.15) w.push('Fat below 15% of calories is below common minimums.');
  if (i.fatPercent > 0.5) w.push('Fat above 50% of calories leaves little room for carbohydrate.');
  const maxRate = i.weightKg * 0.01; // ~1% body weight per week
  if ((i.goal === 'lose' || i.goal === 'gain') && i.rateKgPerWeek > maxRate && maxRate > 0) {
    w.push(`A rate above ~1% of body weight/week (${maxRate.toFixed(2)} kg) is aggressive.`);
  }
  return w;
}

/**
 * Full plan: BMR, maintenance, goal-adjusted calories and a macro split.
 * Protein is set by body weight; fat takes the larger of a body-weight minimum
 * and a share of calories; carbohydrate fills the remainder and is never
 * allowed to go negative (a warning is raised instead).
 *
 * `opts.maintenanceKcal` overrides the BMR×activity estimate with a
 * data-driven value (see {@link calibrateMaintenance}).
 */
export function computeEnergyPlan(i: EnergyInputs, opts?: { maintenanceKcal?: number }): EnergyResult {
  const warnings = validateEnergyInputs(i);
  const bmr = mifflinStJeorBmr(i);
  const tdee = opts?.maintenanceKcal ?? bmr * activityFactor(i.activity);

  let delta = 0;
  if (i.goal === 'lose') delta = -(i.rateKgPerWeek * KCAL_PER_KG) / 7;
  else if (i.goal === 'gain') delta = (i.rateKgPerWeek * KCAL_PER_KG) / 7;

  let targetKcal = tdee + delta;
  const floor = i.sex === 'male' ? 1500 : 1200;
  if (targetKcal < floor) {
    warnings.push(`Target of ${Math.round(targetKcal)} kcal is below a safe floor (${floor} kcal) and was clamped up.`);
    targetKcal = floor;
    delta = targetKcal - tdee;
  }

  const proteinG = Math.max(0, i.proteinPerKg) * i.weightKg;
  const proteinKcal = proteinG * PROTEIN_KCAL_PER_G;

  const fatFromPct = (Math.max(0, i.fatPercent) * targetKcal) / FAT_KCAL_PER_G;
  const fatFloor = Math.max(0, i.fatPerKg) * i.weightKg;
  const fatG = Math.max(fatFromPct, fatFloor);
  const fatKcal = fatG * FAT_KCAL_PER_G;

  let carbKcal = targetKcal - proteinKcal - fatKcal;
  if (carbKcal < 0) {
    warnings.push('Protein and fat targets exceed the calorie target — lower one of them.');
    carbKcal = 0;
  }

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    targetKcal: Math.round(targetKcal),
    proteinG: Math.round(proteinG),
    fatG: Math.round(fatG),
    carbG: Math.round(carbKcal / CARB_KCAL_PER_G),
    dailyDeltaKcal: Math.round(delta),
    warnings,
  };
}

export function kgToLb(kg: number): number {
  return kg * LB_PER_KG;
}

export function lbToKg(lb: number): number {
  return lb / LB_PER_KG;
}

export interface CalibrationResult {
  /** Maintenance energy implied by real intake + measured weight change. */
  observedMaintenanceKcal: number;
  /** Implied daily energy balance (positive = surplus). */
  dailyBalanceKcal: number;
  weightChangeKg: number;
  days: number;
  avgIntakeKcal: number;
}

/**
 * Estimate real maintenance from a logging window. If the user averaged
 * `avgIntakeKcal`/day and changed weight by `weightChangeKg` over `days`, the
 * daily balance is (Δweight × 7700)/days, so maintenance ≈ intake − balance.
 * Returns null when there is not enough signal to be meaningful.
 */
export function calibrateMaintenance(
  avgIntakeKcal: number,
  weightChangeKg: number,
  days: number,
): CalibrationResult | null {
  if (!(days > 0) || !(avgIntakeKcal > 0)) return null;
  const dailyBalanceKcal = (weightChangeKg * KCAL_PER_KG) / days;
  return {
    observedMaintenanceKcal: Math.round(avgIntakeKcal - dailyBalanceKcal),
    dailyBalanceKcal: Math.round(dailyBalanceKcal),
    weightChangeKg,
    days,
    avgIntakeKcal: Math.round(avgIntakeKcal),
  };
}
