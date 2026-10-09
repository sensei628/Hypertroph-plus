// Fixed-point nutrition math.
// All nutrient amounts are stored as integers: amount_milli = amount * 1000
// in the nutrient's canonical unit (kcal, g, mg, ug). Rounding happens ONLY at
// display time. Unknown values are represented as `null` and never coerced to 0.

export const SCALE = 1000;

/** An amount scaled by SCALE (i.e. amount * 1000). May be null (unknown). */
export type Milli = number;

export type NutrientUnit = 'kcal' | 'g' | 'mg' | 'ug' | 'iu';

export function toMilli(value: number): Milli {
  return Math.round(value * SCALE);
}

export function fromMilli(amountMilli: Milli | null | undefined): number | null {
  if (amountMilli === null || amountMilli === undefined) return null;
  return amountMilli / SCALE;
}

/**
 * Scale a per-100 g/ml amount to an arbitrary quantity in grams.
 * Unknown stays unknown. Uses integer math with explicit rounding to avoid float drift.
 */
export function scalePer100(amountMilli: Milli | null | undefined, quantityG: number): Milli | null {
  if (amountMilli === null || amountMilli === undefined) return null;
  return Math.round((amountMilli * quantityG) / 100);
}

/** Ratio scaling with explicit integer rounding. */
export function scaleRatio(amountMilli: Milli | null | undefined, numerator: number, denominator: number): Milli | null {
  if (amountMilli === null || amountMilli === undefined) return null;
  if (denominator === 0) return null;
  return Math.round((amountMilli * numerator) / denominator);
}

/** Format a milli amount for display. Unknown renders as an em dash, never "0". */
export function formatNutrient(amountMilli: Milli | null | undefined, unit: NutrientUnit): string {
  if (amountMilli === null || amountMilli === undefined) return '\u2014';
  const v = amountMilli / SCALE;
  switch (unit) {
    case 'kcal':
      return String(Math.round(v));
    case 'g':
      return (Math.round(v * 10) / 10).toString();
    case 'mg':
      return String(Math.round(v));
    case 'ug':
      return (Math.round(v * 10) / 10).toString();
    default:
      return String(Math.round(v));
  }
}
