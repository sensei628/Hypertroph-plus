import { Milli, scalePer100 } from './nutrients';

export interface NutrientValue {
  nutrientId: string;
  amountMilli: Milli | null;
}

export interface FoodLike {
  id: string;
  name: string;
  basis: 'per_100g' | 'per_100ml';
  nutrients: NutrientValue[];
}

export interface LogItemInput {
  food: FoodLike;
  quantityG: number;
  portionLabel?: string;
}

export interface LoggedNutrient {
  nutrientId: string;
  amountMilli: Milli | null;
  wasUnknown: boolean;
}

export interface LogItem {
  foodId: string | null;
  label: string;
  quantityG: number | null;
  nutrients: LoggedNutrient[];
}

/**
 * Snapshot nutrients at log time. This is the core integrity guarantee:
 * once written, a log entry's numbers never change even if the source food is edited.
 * Unknown values are preserved as null (never coerced to 0).
 */
export function snapshotLogItem(input: LogItemInput): LogItem {
  const nutrients: LoggedNutrient[] = input.food.nutrients.map((n) => {
    const scaled = scalePer100(n.amountMilli, input.quantityG);
    return { nutrientId: n.nutrientId, amountMilli: scaled, wasUnknown: scaled === null };
  });
  return {
    foodId: input.food.id,
    label: input.food.name,
    quantityG: input.quantityG,
    nutrients,
  };
}

export interface NutrientTotal {
  nutrientId: string;
  sumMilli: Milli;
  hasUnknown: boolean;
}

/**
 * Sum known values only. If any contributing entry has an unknown value for a
 * nutrient, `hasUnknown` is flagged and the unknown is NOT counted as 0.
 */
export function sumNutrients(items: LogItem[]): Map<string, NutrientTotal> {
  const totals = new Map<string, NutrientTotal>();
  for (const item of items) {
    for (const n of item.nutrients) {
      const t = totals.get(n.nutrientId) ?? { nutrientId: n.nutrientId, sumMilli: 0, hasUnknown: false };
      if (n.amountMilli === null) {
        t.hasUnknown = true;
      } else {
        t.sumMilli += n.amountMilli;
      }
      totals.set(n.nutrientId, t);
    }
  }
  return totals;
}

export function computeDayTotals(items: LogItem[]): Map<string, NutrientTotal> {
  return sumNutrients(items);
}

export interface RecipeIngredient {
  food: FoodLike;
  quantityG: number;
}

export interface Recipe {
  ingredients: RecipeIngredient[];
  cookedTotalG: number | null;
  servings: number;
}

/** Total nutrients = sum of ingredient snapshots (raw/as-entered basis). */
export function computeRecipeTotals(recipe: Recipe): Map<string, NutrientTotal> {
  const items = recipe.ingredients.map((ing) =>
    snapshotLogItem({ food: ing.food, quantityG: ing.quantityG }),
  );
  return sumNutrients(items);
}

/** Per-serving totals = recipe total / servings (integer-rounded, unknowns preserved). */
export function perServing(
  totals: Map<string, NutrientTotal>,
  servings: number,
): Map<string, NutrientTotal> {
  const out = new Map<string, NutrientTotal>();
  for (const [id, t] of totals) {
    out.set(id, {
      nutrientId: id,
      sumMilli: servings === 0 ? 0 : Math.round(t.sumMilli / servings),
      hasUnknown: t.hasUnknown,
    });
  }
  return out;
}
