import { describe, it, expect } from 'vitest';
import { toMilli, formatNutrient, scalePer100, scaleRatio } from '../src/domain/nutrients';
import {
  FoodLike,
  perServing,
  computeRecipeTotals,
  snapshotLogItem,
  sumNutrients,
} from '../src/domain/nutrition';

describe('fixed-point nutrient math', () => {
  it('scales per-100 amounts to grams with integer math', () => {
    expect(scalePer100(389000, 80)).toBe(311200); // oats 389 kcal/100g * 80g
    expect(scalePer100(73000, 170)).toBe(124100); // greek yogurt 73 kcal/100g * 170g
  });

  it('keeps unknown (null) unknown through scaling', () => {
    expect(scalePer100(null, 100)).toBeNull();
    expect(scaleRatio(null, 1, 2)).toBeNull();
  });

  it('formats unknown as an em dash, never zero', () => {
    expect(formatNutrient(null, 'g')).toBe('\u2014');
    expect(formatNutrient(0, 'g')).toBe('0');
    expect(formatNutrient(toMilli(12.34), 'g')).toBe('12.3');
  });
});

const oats: FoodLike = {
  id: 'f_oats',
  name: 'Oats',
  basis: 'per_100g',
  nutrients: [
    { nutrientId: 'energy_kcal', amountMilli: 389000 },
    { nutrientId: 'protein_g', amountMilli: 16900 },
    { nutrientId: 'fiber_g', amountMilli: null }, // unknown
  ],
};

describe('snapshot-on-log integrity', () => {
  it('freezes nutrient values at log time, preserving unknowns', () => {
    const item = snapshotLogItem({ food: oats, quantityG: 80 });
    const energy = item.nutrients.find((n) => n.nutrientId === 'energy_kcal');
    const fiber = item.nutrients.find((n) => n.nutrientId === 'fiber_g');
    expect(energy?.amountMilli).toBe(311200);
    expect(fiber?.amountMilli).toBeNull();
    expect(fiber?.wasUnknown).toBe(true);
  });

  it('does not change a snapshot when the source food changes', () => {
    const item = snapshotLogItem({ food: oats, quantityG: 80 });
    const before = item.nutrients.find((n) => n.nutrientId === 'energy_kcal')?.amountMilli;
    // simulate editing the source food after logging
    oats.nutrients[0].amountMilli = 400000;
    const after = item.nutrients.find((n) => n.nutrientId === 'energy_kcal')?.amountMilli;
    expect(after).toBe(before);
    oats.nutrients[0].amountMilli = 389000; // restore
  });
});

describe('day totals', () => {
  it('sums known values and flags partial data without zeroing unknowns', () => {
    const a = snapshotLogItem({ food: oats, quantityG: 100 });
    const chicken: FoodLike = {
      id: 'f_chicken',
      name: 'Chicken',
      basis: 'per_100g',
      nutrients: [
        { nutrientId: 'energy_kcal', amountMilli: 165000 },
        { nutrientId: 'fiber_g', amountMilli: null },
      ],
    };
    const b = snapshotLogItem({ food: chicken, quantityG: 100 });
    const totals = sumNutrients([a, b]);
    expect(totals.get('energy_kcal')?.sumMilli).toBe(389000 + 165000);
    expect(totals.get('fiber_g')?.hasUnknown).toBe(true);
    expect(totals.get('fiber_g')?.sumMilli).toBe(0); // unknown contributed nothing, not coerced
  });
});

describe('recipe math', () => {
  it('computes per-serving totals from ingredients and yield', () => {
    const chicken: FoodLike = {
      id: 'f_chicken',
      name: 'Chicken',
      basis: 'per_100g',
      nutrients: [{ nutrientId: 'protein_g', amountMilli: 31000 }],
    };
    const rice: FoodLike = {
      id: 'f_rice',
      name: 'Rice',
      basis: 'per_100g',
      nutrients: [{ nutrientId: 'protein_g', amountMilli: 2700 }],
    };
    const totals = computeRecipeTotals({
      ingredients: [
        { food: chicken, quantityG: 200 },
        { food: rice, quantityG: 300 },
      ],
      cookedTotalG: 450,
      servings: 3,
    });
    // protein total = 31000*2 + 2700*3 = 62000 + 8100 = 70100; /3 = 23366.67 -> 23367
    const total = totals.get('protein_g')?.sumMilli;
    expect(total).toBe(70100);
    const per = perServing(totals, 3);
    expect(per.get('protein_g')?.sumMilli).toBe(Math.round(70100 / 3));
  });
});
