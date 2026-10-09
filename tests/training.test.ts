import { describe, it, expect } from 'vitest';
import {
  SetWithExercise,
  evaluateSet,
  e1rmG,
  emptyPRState,
  gToKg,
  gToLb,
  kgToG,
  lbToG,
  volumeLoadG,
  workingSetVolumeByMuscle,
} from '../src/domain/training';

function entry(
  primary: string[],
  secondary: string[],
  reps: number,
  loadG: number,
  setType: 'working' | 'warmup' = 'working',
  completed = true,
): SetWithExercise {
  return {
    set: { setType, reps, loadG, isBodyweight: false, completed },
    exercise: { id: 'e', canonicalName: 'Ex', primaryMuscles: primary, secondaryMuscles: secondary },
  };
}

describe('hypertrophy metrics', () => {
  it('computes Epley e1RM', () => {
    expect(e1rmG(100000, 5)).toBe(116667); // 100kg x5 -> 116.67kg
    expect(e1rmG(100000, 0)).toBe(0);
  });

  it('counts working-set volume per muscle with a secondary factor', () => {
    const vol = workingSetVolumeByMuscle([
      entry(['chest'], ['triceps', 'shoulder_front'], 5, 100000),
      entry(['chest'], ['triceps'], 8, 80000),
      entry(['quads'], ['glutes'], 5, 120000),
    ]);
    expect(vol.get('chest')).toBe(2);
    expect(vol.get('triceps')).toBe(1.0); // 0.5 + 0.5
    expect(vol.get('quads')).toBe(1);
  });

  it('excludes warm-up and incomplete sets from volume', () => {
    const vol = workingSetVolumeByMuscle([
      entry(['chest'], [], 5, 100000, 'warmup'),
      entry(['chest'], [], 5, 100000, 'working', false),
      entry(['chest'], [], 5, 100000, 'working', true),
    ]);
    expect(vol.get('chest')).toBe(1);
  });

  it('computes volume load in grams for working sets only', () => {
    const total = volumeLoadG([
      { setType: 'working', reps: 5, loadG: 100000, isBodyweight: false, completed: true },
      { setType: 'warmup', reps: 10, loadG: 40000, isBodyweight: false, completed: true },
    ]);
    expect(total).toBe(500000);
  });
});

describe('personal record detection', () => {
  it('flags e1RM, reps-at-load, and set-volume PRs', () => {
    const first = evaluateSet(emptyPRState(), 100000, 5);
    expect(first.prs).toContain('e1rm');
    expect(first.prs).toContain('reps_at_load');
    expect(first.prs).toContain('set_volume');

    const weaker = evaluateSet(first.state, 100000, 4);
    expect(weaker.prs).toHaveLength(0);

    const stronger = evaluateSet(first.state, 102500, 5);
    expect(stronger.prs).toContain('e1rm');
  });
});

describe('unit conversions (canonical storage in grams)', () => {
  it('round-trips kilograms', () => {
    expect(gToKg(kgToG(100))).toBe(100);
  });

  it('round-trips pounds within rounding tolerance', () => {
    const g = lbToG(225);
    expect(Math.abs(gToLb(g) - 225)).toBeLessThan(0.01);
  });
});
