// Presentation grouping for nutrients. The DB stores a coarse `kind`
// (energy/macro/micro/fatty_acid/other); vitamins and minerals both arrive as
// `micro`, so this finer map drives how nutrients are grouped and ordered in
// the UI. Unknown ids fall back to 'other' (never invented).

export type NutrientGroup = 'energy' | 'macronutrient' | 'fat' | 'vitamin' | 'mineral' | 'other';

export const NUTRIENT_GROUP_ORDER: NutrientGroup[] = [
  'energy',
  'macronutrient',
  'fat',
  'vitamin',
  'mineral',
  'other',
];

export const NUTRIENT_GROUP_LABEL: Record<NutrientGroup, string> = {
  energy: 'Energy',
  macronutrient: 'Macronutrients',
  fat: 'Fats & cholesterol',
  vitamin: 'Vitamins',
  mineral: 'Minerals',
  other: 'Other',
};

const GROUP_OF: Record<string, NutrientGroup> = {
  energy_kcal: 'energy',
  protein_g: 'macronutrient',
  carb_g: 'macronutrient',
  fat_g: 'macronutrient',
  fiber_g: 'macronutrient',
  sugar_g: 'macronutrient',
  sugar_added_g: 'macronutrient',
  fat_saturated_g: 'fat',
  fat_mono_g: 'fat',
  fat_poly_g: 'fat',
  fat_trans_g: 'fat',
  cholesterol_mg: 'fat',
  vitamin_a_ug: 'vitamin',
  vitamin_c_mg: 'vitamin',
  vitamin_d_ug: 'vitamin',
  vitamin_e_mg: 'vitamin',
  vitamin_k_ug: 'vitamin',
  thiamin_mg: 'vitamin',
  riboflavin_mg: 'vitamin',
  niacin_mg: 'vitamin',
  pantothenic_acid_mg: 'vitamin',
  vitamin_b6_mg: 'vitamin',
  folate_ug: 'vitamin',
  vitamin_b12_ug: 'vitamin',
  choline_mg: 'vitamin',
  sodium_mg: 'mineral',
  calcium_mg: 'mineral',
  iron_mg: 'mineral',
  magnesium_mg: 'mineral',
  phosphorus_mg: 'mineral',
  potassium_mg: 'mineral',
  zinc_mg: 'mineral',
  copper_mg: 'mineral',
  manganese_mg: 'mineral',
  selenium_ug: 'mineral',
  iodine_ug: 'mineral',
};

export function nutrientGroup(nutrientId: string): NutrientGroup {
  return GROUP_OF[nutrientId] ?? 'other';
}
