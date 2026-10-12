import { describe, it, expect } from 'vitest';
import {
  mifflinStJeorBmr,
  activityFactor,
  maintenanceKcal,
  computeEnergyPlan,
  validateEnergyInputs,
  kgToLb,
  lbToKg,
  calibrateMaintenance,
  ACTIVITY_FACTORS,
  ENERGY_DEFAULTS,
  type EnergyInputs,
} from '../src/domain/energy';

const base: EnergyInputs = {
  sex: 'male',
  age: 30,
  heightCm: 180,
  weightKg: 80,
  activity: 'moderate',
  goal: 'maintain',
  rateKgPerWeek: 0.5,
  proteinPerKg: 1.8,
  fatPerKg: 0.6,
  fatPercent: 0.25,
};

describe('Mifflin–St Jeor', () => {
  it('computes the male BMR', () => {
    // 10*80 + 6.25*180 - 5*30 + 5 = 1780
    expect(mifflinStJeorBmr({ sex: 'male', age: 30, heightCm: 180, weightKg: 80 })).toBeCloseTo(1780, 5);
  });

  it('computes the female BMR (constant -161)', () => {
    expect(mifflinStJeorBmr({ sex: 'female', age: 30, heightCm: 180, weightKg: 80 })).toBeCloseTo(1614, 5);
  });

  it('applies the documented activity factors', () => {
    expect(activityFactor('sedentary')).toBe(1.2);
    expect(activityFactor('extra_active')).toBe(1.9);
    expect(ACTIVITY_FACTORS.moderate).toBe(1.55);
  });

  it('scales BMR to maintenance', () => {
    expect(maintenanceKcal(base)).toBeCloseTo(1780 * 1.55, 3);
  });
});

describe('computeEnergyPlan', () => {
  it('keeps maintenance at TDEE for maintain/recomp', () => {
    const m = computeEnergyPlan({ ...base, goal: 'maintain' });
    expect(m.targetKcal).toBe(m.tdee);
    expect(m.dailyDeltaKcal).toBe(0);
  });

  it('creates a deficit for a fat-loss goal', () => {
    const r = computeEnergyPlan({ ...base, goal: 'lose', rateKgPerWeek: 0.5 });
    const expectedDelta = (0.5 * 7700) / 7; // 550
    expect(r.tdee - r.targetKcal).toBeCloseTo(expectedDelta, 0);
    expect(r.dailyDeltaKcal).toBeLessThan(0);
    expect(r.targetKcal).toBeLessThan(r.tdee);
  });

  it('creates a surplus for a muscle-gain goal', () => {
    const r = computeEnergyPlan({ ...base, goal: 'gain', rateKgPerWeek: 0.25 });
    expect(r.targetKcal).toBeGreaterThan(r.tdee);
    expect(r.dailyDeltaKcal).toBeGreaterThan(0);
  });

  it('sets protein by body weight and fills carbs from the remainder', () => {
    const r = computeEnergyPlan(base);
    expect(r.proteinG).toBe(144); // 1.8 * 80
    const proteinKcal = r.proteinG * 4;
    const fatKcal = r.fatG * 9;
    // carbs (rounded) ≈ remainder / 4
    expect(r.carbG).toBeGreaterThan(0);
    expect(Math.abs(r.targetKcal - (proteinKcal + fatKcal + r.carbG * 4))).toBeLessThanOrEqual(6);
  });

  it('honours the fat body-weight floor when it exceeds the percentage', () => {
    const r = computeEnergyPlan({ ...base, goal: 'lose', rateKgPerWeek: 1, fatPercent: 0.15, fatPerKg: 1.0 });
    expect(r.fatG).toBeGreaterThanOrEqual(80); // 1.0 g/kg * 80 kg floor
  });

  it('clamps an unsafe low calorie target and warns', () => {
    const tiny: EnergyInputs = {
      ...base,
      sex: 'female',
      age: 20,
      heightCm: 150,
      weightKg: 45,
      activity: 'sedentary',
      goal: 'lose',
      rateKgPerWeek: 1,
    };
    const r = computeEnergyPlan(tiny);
    expect(r.targetKcal).toBeGreaterThanOrEqual(1200);
    expect(r.warnings.some((w) => /safe floor/i.test(w))).toBe(true);
  });

  it('never returns negative carbohydrate', () => {
    const r = computeEnergyPlan({ ...base, proteinPerKg: 6, fatPercent: 0.6 });
    expect(r.carbG).toBe(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('validateEnergyInputs', () => {
  it('flags an aggressive rate, low fat and high protein', () => {
    const w = validateEnergyInputs({ ...base, goal: 'lose', rateKgPerWeek: 2, fatPercent: 0.1, proteinPerKg: 4 });
    expect(w.some((m) => /aggressive/i.test(m))).toBe(true);
    expect(w.some((m) => /15%/i.test(m))).toBe(true);
    expect(w.some((m) => /unusually high/i.test(m))).toBe(true);
  });

  it('flags missing body stats', () => {
    const w = validateEnergyInputs({ ...base, weightKg: 0, heightCm: 0, age: 0 });
    expect(w.filter((m) => /estimate energy needs/i.test(m)).length).toBe(3);
  });
});

describe('unit conversion', () => {
  it('round-trips kg <-> lb', () => {
    expect(lbToKg(kgToLb(80))).toBeCloseTo(80, 9);
  });

  it('exposes sensible defaults', () => {
    expect(ENERGY_DEFAULTS.activity).toBe('moderate');
    expect(ENERGY_DEFAULTS.proteinPerKg).toBeGreaterThanOrEqual(1.6);
  });
});

describe('maintenance calibration', () => {
  it('derives maintenance from intake and a measured weight change', () => {
    // Gaining 2 kg over 28 days while eating 2500: daily surplus ≈ 550.
    const r = calibrateMaintenance(2500, 2, 28);
    expect(r).not.toBeNull();
    expect(r!.dailyBalanceKcal).toBe(550);
    expect(r!.observedMaintenanceKcal).toBe(1950);
  });

  it('treats stable weight as intake = maintenance', () => {
    expect(calibrateMaintenance(2600, 0, 30)!.observedMaintenanceKcal).toBe(2600);
  });

  it('raises maintenance when weight is falling', () => {
    const r = calibrateMaintenance(2200, -1.4, 28); // losing ~0.35 kg/wk
    expect(r!.observedMaintenanceKcal).toBeGreaterThan(2200);
  });

  it('returns null without enough signal', () => {
    expect(calibrateMaintenance(0, 1, 28)).toBeNull();
    expect(calibrateMaintenance(2400, 1, 0)).toBeNull();
  });
});

describe('calibrated plan (maintenance override)', () => {
  it('uses the observed maintenance instead of BMR × activity', () => {
    const estimated = computeEnergyPlan(base);
    const calibrated = computeEnergyPlan(base, { maintenanceKcal: 2400 });
    expect(calibrated.tdee).toBe(2400);
    expect(calibrated.tdee).not.toBe(estimated.tdee);
  });

  it('keeps maintenance target at the override for maintain goals', () => {
    const r = computeEnergyPlan({ ...base, goal: 'maintain' }, { maintenanceKcal: 2100 });
    expect(r.targetKcal).toBe(2100);
    expect(r.dailyDeltaKcal).toBe(0);
  });
});
