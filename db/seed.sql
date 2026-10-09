-- hypertroph+ base-model seed data
-- Small curated set to exercise the schema, math, and UX. Values are illustrative
-- and derived from public USDA-style figures; not a substitute for the full pack.

INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (1, 1700000000000, 'base-v1');

INSERT INTO sources (id, name, license, license_url, attribution, redistribution, pack_version, retrieved_at) VALUES
  ('s_usda', 'USDA FoodData Central', 'CC0-1.0', 'https://fdc.nal.usda.gov/', 'Contains data from USDA FoodData Central (public domain).', 'allowed', 'base-model-1', 1700000000000),
  ('s_user', 'User-entered', 'user', NULL, NULL, 'forbidden', NULL, NULL),
  ('s_unlicense', 'Free Exercise DB', 'Unlicense', 'https://github.com/yuhonas/free-exercise-db', 'Exercise data seeded from the public-domain Free Exercise DB.', 'allowed', 'base-model-1', 1700000000000);

INSERT INTO nutrients (id, name, unit, kind, display_order, targetable) VALUES
  ('energy_kcal', 'Calories', 'kcal', 'energy', 1, 1),
  ('protein_g',   'Protein',  'g',    'macro',  2, 1),
  ('carb_g',      'Carbs',    'g',    'macro',  3, 1),
  ('fat_g',       'Fat',      'g',    'macro',  4, 1),
  ('fiber_g',     'Fiber',    'g',    'macro',  5, 0),
  ('sugar_g',     'Sugar',    'g',    'macro',  6, 0),
  ('sodium_mg',   'Sodium',   'mg',   'micro',  7, 0);

-- Foods (amounts per 100 g, stored as amount * 1000). NULL = unknown.
INSERT INTO foods (id, canonical_name, search_key, brand, category, prep_state, basis, language, source_id, source_record_id, data_quality, is_custom, is_recipe, created_at, updated_at) VALUES
  ('f_oats',    'Oats, rolled, dry',        'oats rolled dry',     NULL, 'grains',   'raw',    'per_100g', 'en', 's_usda', 'seed-1', 'verified', 0, 0, 1700000000000, 1700000000000),
  ('f_greek',   'Greek yogurt, plain, 2%',  'greek yogurt plain 2','',   'dairy',    'as_sold','per_100g', 'en', 's_usda', 'seed-2', 'verified', 0, 0, 1700000000000, 1700000000000),
  ('f_berry',   'Blueberries, raw',         'blueberries raw',     NULL, 'fruit',    'raw',    'per_100g', 'en', 's_usda', 'seed-3', 'verified', 0, 0, 1700000000000, 1700000000000),
  ('f_chicken', 'Chicken breast, cooked',   'chicken breast cooked',NULL,'meat',     'cooked', 'per_100g', 'en', 's_usda', 'seed-4', 'verified', 0, 0, 1700000000000, 1700000000000),
  ('f_rice',    'White rice, cooked',       'white rice cooked',   NULL, 'grains',   'cooked', 'per_100g', 'en', 's_usda', 'seed-5', 'verified', 0, 0, 1700000000000, 1700000000000),
  ('f_oil',     'Olive oil',                'olive oil',           NULL, 'fats',     'as_sold','per_100g', 'en', 's_usda', 'seed-6', 'verified', 0, 0, 1700000000000, 1700000000000),
  ('f_whey',    'Whey protein powder',      'whey protein powder', 'MyProtein','supplement','as_sold','per_100g','en','s_usda','seed-7','verified',0,0,1700000000000,1700000000000);

INSERT INTO food_nutrients (food_id, nutrient_id, amount_milli) VALUES
  ('f_oats','energy_kcal',389000),('f_oats','protein_g',16900),('f_oats','carb_g',66300),('f_oats','fat_g',6900),('f_oats','fiber_g',10600),('f_oats','sugar_g',1000),('f_oats','sodium_mg',2000),
  ('f_greek','energy_kcal',73000),('f_greek','protein_g',9900),('f_greek','carb_g',3900),('f_greek','fat_g',1900),('f_greek','fiber_g',0),('f_greek','sugar_g',3200),('f_greek','sodium_mg',34000),
  ('f_berry','energy_kcal',57000),('f_berry','protein_g',700),('f_berry','carb_g',14500),('f_berry','fat_g',300),('f_berry','fiber_g',2400),('f_berry','sugar_g',10000),('f_berry','sodium_mg',1000),
  -- chicken: fiber UNKNOWN (explicit NULL row -> "partial data", never counted as 0)
  ('f_chicken','energy_kcal',165000),('f_chicken','protein_g',31000),('f_chicken','carb_g',0),('f_chicken','fat_g',3600),('f_chicken','fiber_g',NULL),('f_chicken','sugar_g',0),('f_chicken','sodium_mg',74000),
  -- rice: sugar UNKNOWN
  ('f_rice','energy_kcal',130000),('f_rice','protein_g',2700),('f_rice','carb_g',28000),('f_rice','fat_g',300),('f_rice','fiber_g',400),('f_rice','sugar_g',NULL),('f_rice','sodium_mg',1000),
  ('f_oil','energy_kcal',884000),('f_oil','protein_g',0),('f_oil','carb_g',0),('f_oil','fat_g',100000),('f_oil','fiber_g',0),('f_oil','sugar_g',0),('f_oil','sodium_mg',2000),
  ('f_whey','energy_kcal',400000),('f_whey','protein_g',80000),('f_whey','carb_g',8000),('f_whey','fat_g',5000),('f_whey','fiber_g',1000),('f_whey','sugar_g',4000),('f_whey','sodium_mg',300000);

INSERT INTO food_portions (id, food_id, label, gram_weight, is_default, seq) VALUES
  ('p_oats_cup','f_oats','1 cup (dry)',80,1,0),('p_oats_half','f_oats','1/2 cup',40,0,1),
  ('p_greek_cup','f_greek','1 container',170,1,0),
  ('p_berry_cup','f_berry','1 cup',140,1,0),
  ('p_chicken_breast','f_chicken','1 breast',170,1,0),
  ('p_rice_cup','f_rice','1 cup (cooked)',158,1,0),
  ('p_oil_tbsp','f_oil','1 tbsp',13.5,1,0),
  ('p_whey_scoop','f_whey','1 scoop',30,1,0);

INSERT INTO food_aliases (id, food_id, alias, language) VALUES
  ('a_oats1','f_oats','oatmeal','en'),('a_oats2','f_oats','porridge','en'),
  ('a_greek1','f_greek','yogurt','en'),('a_greek2','f_greek','yoghurt','en'),
  ('a_chicken1','f_chicken','chicken','en'),('a_rice1','f_rice','rice','en');

INSERT INTO muscles (id, name, region, parent_id) VALUES
  ('chest','Chest','upper',NULL),('shoulder_front','Front delts','upper',NULL),('shoulder_side','Side delts','upper',NULL),
  ('triceps','Triceps','upper',NULL),('biceps','Biceps','upper',NULL),('lats','Lats','upper',NULL),('back','Upper back','upper',NULL),
  ('quads','Quads','lower',NULL),('glutes','Glutes','lower',NULL),('hamstrings','Hamstrings','lower',NULL),('erectors','Spinal erectors','core',NULL),('core','Core','core',NULL);

INSERT INTO equipment (id, name) VALUES
  ('barbell','Barbell'),('dumbbell','Dumbbell'),('cable','Cable'),('machine','Machine'),('bodyweight','Bodyweight'),('band','Band'),('kettlebell','Kettlebell');

INSERT INTO movement_patterns (id, name) VALUES
  ('horizontal_push','Horizontal push'),('vertical_push','Vertical push'),('horizontal_pull','Horizontal pull'),('vertical_pull','Vertical pull'),('squat','Squat'),('hinge','Hinge');

INSERT INTO exercises (id, canonical_name, search_key, source_id, source_record_id, unilateral, is_custom, variation_group, created_at, updated_at) VALUES
  ('e_bench',     'Barbell Bench Press',     'barbell bench press',     's_unlicense','ex-bench',0,0,'bench',   1700000000000,1700000000000),
  ('e_incline_db','Incline Dumbbell Press',  'incline dumbbell press',  's_unlicense','ex-inc-db',0,0,'bench',  1700000000000,1700000000000),
  ('e_squat',     'Back Squat',              'back squat',              's_unlicense','ex-squat',0,0,'squat',   1700000000000,1700000000000),
  ('e_deadlift',  'Deadlift',                'deadlift',                's_unlicense','ex-dl',0,0,'hinge',     1700000000000,1700000000000),
  ('e_ohp',       'Overhead Press',          'overhead press',          's_unlicense','ex-ohp',0,0,'press',    1700000000000,1700000000000),
  ('e_pullup',    'Pull-Up',                 'pull up',                 's_unlicense','ex-pullup',0,0,'pull',   1700000000000,1700000000000),
  ('e_row',       'Barbell Row',             'barbell row',             's_unlicense','ex-row',0,0,'row',     1700000000000,1700000000000),
  ('e_rdl',       'Romanian Deadlift',       'romanian deadlift',       's_unlicense','ex-rdl',0,0,'hinge',   1700000000000,1700000000000),
  ('e_latraise',  'Dumbbell Lateral Raise',  'dumbbell lateral raise',  's_unlicense','ex-lat',0,1,'raise',   1700000000000,1700000000000);

INSERT INTO exercise_aliases (id, exercise_id, alias, language) VALUES
  ('ea_bench1','e_bench','bench press','en'),('ea_bench2','e_bench','bp','en'),('ea_ohp1','e_ohp','OHP','en'),('ea_ohp2','e_ohp','military press','en'),('ea_pullup1','e_pullup','pullups','en'),('ea_lat1','e_latraise','lateral raise','en');

INSERT INTO exercise_muscles (exercise_id, muscle_id, role) VALUES
  ('e_bench','chest','primary'),('e_bench','triceps','secondary'),('e_bench','shoulder_front','secondary'),
  ('e_incline_db','chest','primary'),('e_incline_db','shoulder_front','secondary'),('e_incline_db','triceps','secondary'),
  ('e_squat','quads','primary'),('e_squat','glutes','secondary'),('e_squat','hamstrings','secondary'),('e_squat','erectors','secondary'),
  ('e_deadlift','hamstrings','primary'),('e_deadlift','glutes','secondary'),('e_deadlift','erectors','secondary'),('e_deadlift','lats','secondary'),
  ('e_ohp','shoulder_front','primary'),('e_ohp','triceps','secondary'),
  ('e_pullup','lats','primary'),('e_pullup','biceps','secondary'),
  ('e_row','back','primary'),('e_row','biceps','secondary'),('e_row','lats','secondary'),
  ('e_rdl','hamstrings','primary'),('e_rdl','glutes','secondary'),('e_rdl','erectors','secondary'),
  ('e_latraise','shoulder_side','primary');

INSERT INTO exercise_equipment (exercise_id, equipment_id) VALUES
  ('e_bench','barbell'),('e_incline_db','dumbbell'),('e_squat','barbell'),('e_deadlift','barbell'),('e_ohp','barbell'),('e_pullup','bodyweight'),('e_row','barbell'),('e_rdl','barbell'),('e_latraise','dumbbell');

INSERT INTO preferences (key, value, updated_at) VALUES
  ('units.mass', '"kg"', 1700000000000),
  ('secondaryVolumeFactor', '0.5', 1700000000000);

INSERT INTO targets (nutrient_id, target_milli, updated_at) VALUES
  ('energy_kcal', 2600000, 1700000000000),
  ('protein_g', 180000, 1700000000000),
  ('carb_g', 290000, 1700000000000),
  ('fat_g', 73000, 1700000000000);
