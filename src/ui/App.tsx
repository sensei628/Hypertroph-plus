import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { App as CapApp } from '@capacitor/app';
import { loadDatabase, exportDatabaseBytes, flushPersistence, type DB } from '../data/db';
import { loadRefDatabase } from '../data/refdb';
import { exportBackup, importBackup } from '../data/backup';
import { getDesktopBridge, type UpdateStatus } from '../desktop';
import {
  SqliteRepository,
  type BodyMetricType,
  type DayItemRow,
  type ExerciseFilters,
  type ExerciseSummary,
  type FoodDetail,
  type FoodFilters,
  type FoodSummary,
  type LastSetHint,
  type NutrientDef,
  type RoutineSummary,
  type WorkoutExerciseRow,
  type WorkoutRow,
} from '../data/repository';
import { formatNutrient, toMilli } from '../domain/nutrients';
import { LogItem, sumNutrients, snapshotLogItem } from '../domain/nutrition';
import { gToKg, gToLb, kgToG, lbToG, e1rmG } from '../domain/training';
import { CommandPalette } from './CommandPalette';

type Section = 'nutrition' | 'training' | 'settings';
type PaletteMode = 'food' | 'exercise';
type TrainingMode = 'random' | 'plan';
interface BuilderExercise {
  exerciseId: string;
  name: string;
  targetSets: string;
  targetReps: string;
  targetRir: string;
}
interface BuilderState {
  id: string | null;
  name: string;
  exercises: BuilderExercise[];
}
const DEFAULT_MEALS = ['breakfast', 'lunch', 'dinner'] as const;
const SUMMARY_NUTRIENTS = ['energy_kcal', 'protein_g', 'carb_g', 'fat_g'];

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

function weekRange(iso: string): [string, string] {
  const d = new Date(`${iso}T12:00:00`);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  const start = addDays(iso, -dow);
  return [start, addDays(start, 6)];
}

function rowsToTotals(items: DayItemRow[]) {
  const logItems: LogItem[] = items.map((r) => ({
    foodId: null,
    label: r.label,
    quantityG: r.quantityG,
    nutrients: r.nutrients,
  }));
  return sumNutrients(logItems);
}

// Meal list = defaults + saved customs (preferences) + any sections with live
// log items, deduped case-insensitively and order-preserving.
function buildMeals(r: SqliteRepository): string[] {
  let saved: string[] = [];
  try {
    const v = JSON.parse(r.getPreference('meals', '') || 'null');
    if (Array.isArray(v)) saved = v.map((s) => String(s)).filter(Boolean);
  } catch {
    saved = [];
  }
  const used = r.getUsedMealSections();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [...DEFAULT_MEALS, ...saved, ...used]) {
    const k = String(m).toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

export function App() {
  const [repo, setRepo] = useState<SqliteRepository | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dbRef = useRef<DB | null>(null);
  const [section, setSection] = useState<Section>('nutrition');
  const [date, setDate] = useState<string>(toISODate(new Date()));

  const [nutrientDefs, setNutrientDefs] = useState<NutrientDef[]>([]);
  const [targets, setTargets] = useState<Map<string, number>>(new Map());
  const [units, setUnits] = useState<'kg' | 'lb'>('kg');
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [secondaryFactor, setSecondaryFactor] = useState(0.5);
  const [muscleNames, setMuscleNames] = useState<Map<string, string>>(new Map());

  const [dayItems, setDayItems] = useState<DayItemRow[]>([]);
  const [recentFoods, setRecentFoods] = useState<FoodSummary[]>([]);
  const [pinnedFoods, setPinnedFoods] = useState<FoodSummary[]>([]);
  const [pinnedExercises, setPinnedExercises] = useState<ExerciseSummary[]>([]);
  const [recentFoodIds, setRecentFoodIds] = useState<string[]>([]);
  const [recentExerciseIds, setRecentExerciseIds] = useState<string[]>([]);
  const [favoriteFoodIds, setFavoriteFoodIds] = useState<string[]>([]);
  const [favoriteExerciseIds, setFavoriteExerciseIds] = useState<string[]>([]);
  const [meals, setMeals] = useState<string[]>([...DEFAULT_MEALS]);
  const [pendingMeal, setPendingMeal] = useState<string | undefined>(undefined);
  const [activeWorkout, setActiveWorkout] = useState<WorkoutRow | null>(null);
  const [weeklyVolume, setWeeklyVolume] = useState<Map<string, number>>(new Map());
  const [routines, setRoutines] = useState<RoutineSummary[]>([]);
  const [trainingMode, setTrainingMode] = useState<TrainingMode>('random');
  const [builder, setBuilder] = useState<BuilderState | null>(null);

  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [palettePurpose, setPalettePurpose] = useState<'log' | 'builder'>('log');
  const [logTarget, setLogTarget] = useState<FoodDetail | null>(null);
  const [logMealDefault, setLogMealDefault] = useState<string>(DEFAULT_MEALS[0]);
  const [customOpen, setCustomOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const desktop = getDesktopBridge();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await loadDatabase();
        const ref = await loadRefDatabase();
        const r = new SqliteRepository(db, ref);
        if (cancelled) return;
        dbRef.current = db;
        setRepo(r);
        setNutrientDefs(r.getNutrientDefs());
        setTargets(r.getTargets());
        setUnits(r.getPreference('units.mass', 'kg') === 'lb' ? 'lb' : 'kg');
        setSecondaryFactor(Number(r.getPreference('secondaryVolumeFactor', '0.5')));
        setMuscleNames(r.getMuscleNames());
        setMeals(buildMeals(r));
        setRoutines(r.listRoutines());
        setTrainingMode(r.getPreference('training.mode', 'random') === 'plan' ? 'plan' : 'random');
        setPinnedFoods(r.getPinnedFoods());
        setPinnedExercises(r.getPinnedExercises());
        const savedTheme = r.getPreference('theme', 'dark') === 'dark' ? 'dark' : 'light';
        setTheme(savedTheme);
        document.documentElement.classList.toggle('dark', savedTheme === 'dark');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(() => {
    if (!repo) return;
    setDayItems(repo.getDayItems(date));
    setRecentFoods(repo.recentFoods(8));
    setRecentFoodIds(repo.recentUses('food', 12));
    setRecentExerciseIds(repo.recentUses('exercise', 12));
    setFavoriteFoodIds([...repo.favoriteIds('food')]);
    setFavoriteExerciseIds([...repo.favoriteIds('exercise')]);
    setActiveWorkout(repo.getActiveWorkout(date));
    setRoutines(repo.listRoutines());
    const [ws, we] = weekRange(date);
    setWeeklyVolume(repo.getWeeklyVolume(ws, we, secondaryFactor));
  }, [repo, date, secondaryFactor]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  // Flush any pending on-device database write when the app is backgrounded or
  // closed, so nothing is lost between the debounced writes.
  useEffect(() => {
    const sub = CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) void flushPersistence();
    });
    const onHide = () => void flushPersistence();
    window.addEventListener('pagehide', onHide);
    window.addEventListener('visibilitychange', onHide);
    return () => {
      void sub.then((s) => s.remove());
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('visibilitychange', onHide);
    };
  }, []);

  const handleExportBackup = useCallback(async () => {
    if (!dbRef.current) return;
    try {
      const how = await exportBackup(exportDatabaseBytes(dbRef.current));
      setToast(how === 'shared' ? 'Backup ready — choose where to save it' : 'Backup file downloaded');
    } catch (e) {
      setToast(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const handleImportBackup = useCallback(async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const report = await importBackup(bytes);
      if (!report.ok) {
        setToast(`Import failed: ${report.error ?? 'invalid backup file'}`);
        return;
      }
      // importBackup only writes after validation; reload to rebuild from it.
      window.location.reload();
    } catch (e) {
      setToast(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // Desktop update lifecycle: show the version and stream update status from the
  // Electron main process (auto-download + install-on-quit, or a manual check).
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void desktop.getAppInfo().then((info) => {
      if (!cancelled) setAppVersion(info.version);
    });
    const off = desktop.onUpdateStatus((s) => setUpdate(s));
    return () => {
      cancelled = true;
      off();
    };
  }, [desktop]);

  const handleCheckUpdates = useCallback(() => {
    if (!desktop) return;
    setUpdate({ state: 'checking' });
    void desktop.checkForUpdates().then((r) => {
      if (!r.ok) setUpdate({ state: 'error', message: r.reason ?? 'updates unavailable' });
    });
  }, [desktop]);

  // Apply the active theme class to <html>; keeps the loading screen themed too.
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0e1512' : '#f3f4f3');
  }, [theme]);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    repo?.setPreference('theme', next);
  }

  // Context-aware Ctrl/Cmd-K: foods in Nutrition, exercises in Training.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        if (section !== 'nutrition' && section !== 'training') return;
        e.preventDefault();
        setPalettePurpose('log');
        setPalette(section === 'nutrition' ? 'food' : 'exercise');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [section]);

  const totals = useMemo(() => rowsToTotals(dayItems), [dayItems]);

  const defById = useMemo(() => {
    const m = new Map<string, NutrientDef>();
    for (const d of nutrientDefs) m.set(d.id, d);
    return m;
  }, [nutrientDefs]);

  const searchFoods = useCallback((q: string, limit?: number, filters?: FoodFilters) => repo?.searchFoods(q, limit, filters) ?? [], [repo]);
  const countFoods = useCallback((q: string, filters?: FoodFilters) => repo?.countFoods(q, filters) ?? 0, [repo]);
  const searchExercises = useCallback((q: string, limit?: number, filters?: ExerciseFilters) => repo?.searchExercises(q, limit, filters) ?? [], [repo]);
  const countExercises = useCallback((q: string, filters?: ExerciseFilters) => repo?.countExercises(q, filters) ?? 0, [repo]);
  const getFood = useCallback((id: string) => repo?.getFood(id) ?? null, [repo]);
  const getExercise = useCallback((id: string) => repo?.getExercise(id) ?? null, [repo]);
  const getLastSet = useCallback((id: string): LastSetHint | null => repo?.getLastSetForExercise(id) ?? null, [repo]);
  const getFoodFacets = useCallback(
    (q: string) => repo?.getFoodFacets(q) ?? { foodTypes: [], entryTypes: [], prepStates: [] },
    [repo],
  );
  const getExerciseFacets = useCallback(
    (q: string) => repo?.getExerciseFacets(q) ?? { categories: [], equipment: [], muscles: [] },
    [repo],
  );

  function go(next: Section) {
    setSection(next);
    setPalette(null);
  }

  function openFoodPalette(meal?: string) {
    setPendingMeal(meal);
    setPalettePurpose('log');
    setPalette('food');
  }

  function openExercisePalette() {
    setPalettePurpose('log');
    setPalette('exercise');
  }

  function openLog(food: FoodSummary, meal?: string) {
    if (!repo) return;
    const detail = repo.getFood(food.id);
    if (detail) {
      setLogTarget(detail);
      setLogMealDefault(meal ?? pendingMeal ?? meals[0] ?? DEFAULT_MEALS[0]);
    }
    setPendingMeal(undefined);
    setPalette(null);
  }

  function closePalette() {
    setPendingMeal(undefined);
    setPalette(null);
    setPalettePurpose('log');
  }

  function addMeal() {
    if (!repo) return;
    if (meals.length >= 12) {
      setToast('Maximum 12 meals');
      return;
    }
    let nextName = '';
    for (let n = 1; n <= meals.length + 1; n++) {
      const cand = `m${n}`;
      if (!meals.some((m) => m === cand)) {
        nextName = cand;
        break;
      }
    }
    const next = [...meals, nextName];
    setMeals(next);
    repo.setPreference('meals', next);
  }

  function removeMeal(m: string) {
    if (!repo || meals.length <= 1) return;
    const idx = meals.indexOf(m);
    const label = idx >= 0 ? `M${idx + 1}` : m;
    const next = meals.filter((x) => x !== m);
    setMeals(next);
    repo.setPreference('meals', next);
    const hadItems = dayItems.some((i) => i.mealSection === m);
    setToast(
      hadItems
        ? `Removed ${label} — items logged there still count toward today's totals`
        : `Removed ${label}`,
    );
  }

  function openExerciseInWorkout(ex: ExerciseSummary) {
    if (!repo) return;
    let wo = activeWorkout;
    if (!wo) {
      repo.startWorkout('Workout', date, -new Date().getTimezoneOffset());
      wo = repo.getActiveWorkout(date);
    }
    if (wo) {
      repo.addExercise(wo.id, ex.id);
      refresh();
      setToast(`Added ${ex.name}`);
    }
    setPalette(null);
  }

  function logFood(detail: FoodDetail, quantityG: number, portionLabel: string, meal: string) {
    if (!repo) return;
    const snapshot = snapshotLogItem({
      food: { id: detail.id, name: detail.name, basis: detail.basis as 'per_100g' | 'per_100ml', nutrients: detail.nutrients },
      quantityG,
    });
    repo.logFood({ foodId: detail.id, quantityG, portionLabel, mealSection: meal, localDate: date, tzOffsetMin: -new Date().getTimezoneOffset() });
    setToast(`Logged ${snapshot.label} (${Math.round(quantityG)} g)`);
    setLogTarget(null);
    refresh();
  }

  function startWorkout() {
    if (!repo) return;
    repo.startWorkout('Workout', date, -new Date().getTimezoneOffset());
    refresh();
  }

  function changeTrainingMode(mode: TrainingMode) {
    setTrainingMode(mode);
    repo?.setPreference('training.mode', mode);
  }

  function startRoutine(routineId: string) {
    if (!repo) return;
    const id = repo.startWorkoutFromRoutine(routineId, date, -new Date().getTimezoneOffset());
    if (id) {
      refresh();
      setToast('Workout started from plan');
    }
  }

  function newPlan() {
    setBuilder({ id: null, name: '', exercises: [] });
  }

  function editPlan(id: string) {
    const r = repo?.getRoutine(id);
    if (!r) return;
    setBuilder({
      id: r.id,
      name: r.name,
      exercises: r.exercises.map((e) => ({
        exerciseId: e.exerciseId,
        name: e.name,
        targetSets: e.targetSets != null ? String(e.targetSets) : '',
        targetReps: e.targetReps ?? '',
        targetRir: e.targetRir != null ? String(e.targetRir) : '',
      })),
    });
  }

  function deletePlan(id: string) {
    if (!repo) return;
    if (!window.confirm('Delete this workout plan?')) return;
    repo.deleteRoutine(id);
    refresh();
    setToast('Plan deleted');
  }

  function openBuilderPicker() {
    setPalettePurpose('builder');
    setPalette('exercise');
  }

  function addExerciseToBuilder(ex: ExerciseSummary) {
    setBuilder((prev) =>
      prev
        ? {
            ...prev,
            exercises: [
              ...prev.exercises,
              { exerciseId: ex.id, name: ex.name, targetSets: '3', targetReps: '', targetRir: '2' },
            ],
          }
        : prev,
    );
    setPalette(null);
    setPalettePurpose('log');
  }

  function updateBuilderExercise(index: number, patch: Partial<BuilderExercise>) {
    setBuilder((prev) =>
      prev ? { ...prev, exercises: prev.exercises.map((e, i) => (i === index ? { ...e, ...patch } : e)) } : prev,
    );
  }

  function moveBuilderExercise(index: number, dir: -1 | 1) {
    setBuilder((prev) => {
      if (!prev) return prev;
      const next = [...prev.exercises];
      const j = index + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[index], next[j]] = [next[j], next[index]];
      return { ...prev, exercises: next };
    });
  }

  function removeBuilderExercise(index: number) {
    setBuilder((prev) => (prev ? { ...prev, exercises: prev.exercises.filter((_, i) => i !== index) } : prev));
  }

  function saveBuilder() {
    if (!repo || !builder) return;
    const name = builder.name.trim();
    if (!name) {
      setToast('Name your plan first');
      return;
    }
    if (builder.exercises.length === 0) {
      setToast('Add at least one exercise');
      return;
    }
    repo.saveRoutine({
      id: builder.id ?? undefined,
      name,
      exercises: builder.exercises.map((e) => ({
        exerciseId: e.exerciseId,
        targetSets: e.targetSets ? Number(e.targetSets) : null,
        targetReps: e.targetReps.trim() || null,
        targetRir: e.targetRir ? Number(e.targetRir) : null,
      })),
    });
    setBuilder(null);
    refresh();
    setToast('Plan saved');
  }

  function pickExercise(ex: ExerciseSummary) {
    if (palettePurpose === 'builder') addExerciseToBuilder(ex);
    else openExerciseInWorkout(ex);
  }

  function addSet(we: WorkoutExerciseRow, loadStr: string, repsStr: string, rirStr: string, setType: 'working' | 'warmup') {
    if (!repo) return;
    const loadNum = Number(loadStr);
    const reps = Number(repsStr);
    if (!reps || reps <= 0) return;
    const loadG = loadNum > 0 ? (units === 'kg' ? kgToG(loadNum) : lbToG(loadNum)) : null;
    const { prs } = repo.logSet(we.id, {
      setType,
      reps,
      loadG,
      rir: rirStr ? Number(rirStr) : null,
      isBodyweight: loadG == null,
    });
    if (prs.length) setToast(`New PR: ${prs.join(', ')}`);
    refresh();
  }

  function finishWorkout() {
    if (!repo || !activeWorkout) return;
    repo.finishWorkout(activeWorkout.id);
    setToast('Workout saved');
    refresh();
  }

  function createCustomFood(name: string, kcal: number, protein: number, carb: number, fat: number) {
    if (!repo) return;
    repo.createCustomFood(name, [
      { nutrientId: 'energy_kcal', amountMilli: toMilli(kcal) },
      { nutrientId: 'protein_g', amountMilli: toMilli(protein) },
      { nutrientId: 'carb_g', amountMilli: toMilli(carb) },
      { nutrientId: 'fat_g', amountMilli: toMilli(fat) },
    ]);
    setCustomOpen(false);
    refresh();
    setToast(`Created custom food: ${name}`);
  }

  function changeUnits(u: 'kg' | 'lb') {
    setUnits(u);
    repo?.setPreference('units.mass', u);
  }

  function changeTarget(nutrientId: string, displayValue: number) {
    if (!repo) return;
    const milli = toMilli(displayValue);
    repo.setTarget(nutrientId, milli);
    setTargets(repo.getTargets());
  }

  function toggleFavorite(type: 'food' | 'exercise', id: string) {
    if (!repo) return;
    repo.toggleFavorite(type, id);
    refresh();
  }

  function addBodyMetric(input: { metricType: BodyMetricType; value: number; localDate: string; note?: string }) {
    if (!repo) return;
    repo.addBodyMetric(input);
    setToast('Logged body metric');
    refresh();
  }

  if (error) {
    return (
      <div className="content">
        <div className="card">
          <h2>Failed to start</h2>
          <p className="muted">{error}</p>
        </div>
      </div>
    );
  }

  if (!repo) {
    return (
      <div className="content">
        <div className="card">
          <h2>hypertroph+</h2>
          <p className="muted">Loading local database…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar
        section={section}
        onNavigate={go}
        nutritionCount={dayItems.length}
        trainingCount={activeWorkout?.exercises.length ?? 0}
      />

      <div className="main">
        <Topbar
          theme={theme}
          onToggleTheme={toggleTheme}
          onSearch={() => {
            setPalettePurpose('log');
            setPalette(section === 'training' ? 'exercise' : 'food');
          }}
        />

        <div className="content">
          {section === 'nutrition' && (
            <NutritionSection
              date={date}
              setDate={setDate}
              items={dayItems}
              totals={totals}
              targets={targets}
              defById={defById}
              recentFoods={recentFoods}
              meals={meals}
              onAddFood={openFoodPalette}
              onPickRecent={openLog}
              onDelete={(id) => {
                repo.deleteLogItem(id);
                refresh();
              }}
              onAddMeal={addMeal}
              onRemoveMeal={removeMeal}
              onCreateCustom={() => setCustomOpen(true)}
            />
          )}

          {section === 'training' && (
            <TrainingSection
              activeWorkout={activeWorkout}
              units={units}
              weeklyVolume={weeklyVolume}
              muscleNames={muscleNames}
              secondaryFactor={secondaryFactor}
              routines={routines}
              mode={trainingMode}
              onModeChange={changeTrainingMode}
              onStartRandom={startWorkout}
              onStartRoutine={startRoutine}
              onAddExercise={openExercisePalette}
              onAddSet={addSet}
              onFinish={finishWorkout}
              onNewPlan={newPlan}
              onEditPlan={editPlan}
              onDeletePlan={deletePlan}
              getLastSet={getLastSet}
            />
          )}

          {section === 'settings' && (
            <Settings
              units={units}
              onChangeUnits={changeUnits}
              secondaryFactor={secondaryFactor}
              onChangeSecondary={(n) => {
                setSecondaryFactor(n);
                repo.setPreference('secondaryVolumeFactor', String(n));
              }}
              targets={targets}
              defById={defById}
              onChangeTarget={changeTarget}
              onExportBackup={handleExportBackup}
              onImportBackup={handleImportBackup}
              isDesktop={!!desktop}
              appVersion={appVersion}
              update={update}
              onCheckUpdates={handleCheckUpdates}
            />
          )}
        </div>

        <nav className="tabbar" role="tablist" aria-label="Sections">
          <button
            role="tab"
            aria-selected={section === 'nutrition'}
            className={section === 'nutrition' ? 'active' : ''}
            onClick={() => go('nutrition')}
          >
            <Icon name="nutrition" />
            Nutrition
          </button>
          <button
            role="tab"
            aria-selected={section === 'training'}
            className={section === 'training' ? 'active' : ''}
            onClick={() => go('training')}
          >
            <Icon name="training" />
            Training
          </button>
          <button
            role="tab"
            aria-selected={section === 'settings'}
            className={section === 'settings' ? 'active' : ''}
            onClick={() => go('settings')}
          >
            <Icon name="settings" />
            Settings
          </button>
        </nav>
      </div>

      {palette && (
        <CommandPalette
          initialMode={palette}
          tabs={palettePurpose === 'builder' ? ['exercise'] : undefined}
          searchFoods={searchFoods}
          countFoods={countFoods}
          getFoodFacets={getFoodFacets}
          getFood={getFood}
          searchExercises={searchExercises}
          countExercises={countExercises}
          getExerciseFacets={getExerciseFacets}
          getExercise={getExercise}
          recentFoodIds={recentFoodIds}
          recentExerciseIds={recentExerciseIds}
          favoriteFoodIds={favoriteFoodIds}
          favoriteExerciseIds={favoriteExerciseIds}
          pinnedFoods={pinnedFoods}
          pinnedExercises={pinnedExercises}
          onToggleFavorite={toggleFavorite}
          onAddBodyMetric={addBodyMetric}
          onPickFood={openLog}
          onPickExercise={pickExercise}
          onClose={closePalette}
        />
      )}

      {builder && (
        <PlanBuilder
          plan={builder}
          onChangeName={(v) => setBuilder((prev) => (prev ? { ...prev, name: v } : prev))}
          onAddExercise={openBuilderPicker}
          onChangeExercise={updateBuilderExercise}
          onRemoveExercise={removeBuilderExercise}
          onMoveExercise={moveBuilderExercise}
          onSave={saveBuilder}
          onCancel={() => setBuilder(null)}
        />
      )}

      {logTarget && (
        <LogDialog
          food={logTarget}
          defById={defById}
          units={units}
          meals={meals}
          initialMeal={logMealDefault}
          onCancel={() => setLogTarget(null)}
          onLog={logFood}
        />
      )}

      {customOpen && <CustomFoodDialog onCancel={() => setCustomOpen(false)} onCreate={createCustomFood} />}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ── Icons (inline SVG, no icon dependency) ──────────────────
type IconName =
  | 'bolt'
  | 'nutrition'
  | 'training'
  | 'settings'
  | 'search'
  | 'sun'
  | 'moon'
  | 'arrow-up-right'
  | 'plus'
  | 'chevron-left'
  | 'chevron-right'
  | 'flame'
  | 'trash'
  | 'play'
  | 'pause'
  | 'stop'
  | 'target'
  | 'activity';

function Icon({ name, className }: { name: IconName; className?: string }) {
  let body: ReactNode = null;
  switch (name) {
    case 'bolt':
      body = <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />;
      break;
    case 'nutrition':
      body = (
        <>
          <path d="M12 8c0-3 2-5 5-5 0 3-2 5-5 5Z" />
          <path d="M12 8c-2-2-5-2-7 0-2 2-2 6 0 9 1.5 2.2 3 4 4 4s1.5-1 3-1 2 1 3 1 2.5-1.8 4-4c2-3 2-7 0-9-2-2-5-2-7 0Z" />
        </>
      );
      break;
    case 'training':
      body = (
        <>
          <path d="M6.5 6.5 17.5 17.5" />
          <rect x="1.5" y="9" width="4" height="6" rx="1.2" />
          <rect x="18.5" y="9" width="4" height="6" rx="1.2" />
          <rect x="5" y="7.5" width="3" height="9" rx="1" />
          <rect x="16" y="7.5" width="3" height="9" rx="1" />
        </>
      );
      break;
    case 'settings':
      body = (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
        </>
      );
      break;
    case 'search':
      body = (
        <>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </>
      );
      break;
    case 'sun':
      body = (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </>
      );
      break;
    case 'moon':
      body = <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />;
      break;
    case 'arrow-up-right':
      body = <path d="M7 17 17 7M8 7h9v9" />;
      break;
    case 'plus':
      body = <path d="M12 5v14M5 12h14" />;
      break;
    case 'chevron-left':
      body = <path d="m15 5-7 7 7 7" />;
      break;
    case 'chevron-right':
      body = <path d="m9 5 7 7-7 7" />;
      break;
    case 'flame':
      body = <path d="M12 3s5 4 5 9a5 5 0 0 1-10 0c0-2 1-3 1-3s0 1.5 1 2c0-3 3-5 3-8Z" />;
      break;
    case 'trash':
      body = <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13" />;
      break;
    case 'play':
      body = <path d="M7 4.5v15l12-7.5-12-7.5Z" />;
      break;
    case 'pause':
      body = <path d="M8 5v14M16 5v14" />;
      break;
    case 'stop':
      body = <rect x="6" y="6" width="12" height="12" rx="2" />;
      break;
    case 'target':
      body = (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="4.5" />
          <circle cx="12" cy="12" r="1" />
        </>
      );
      break;
    case 'activity':
      body = <path d="M3 12h4l2.5-7 4 14 2.5-7H21" />;
      break;
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {body}
    </svg>
  );
}

// ── Shell: sidebar + topbar ─────────────────────────────────
function Sidebar({
  section,
  onNavigate,
  nutritionCount,
  trainingCount,
}: {
  section: Section;
  onNavigate: (s: Section) => void;
  nutritionCount: number;
  trainingCount: number;
}) {
  return (
    <aside className="sidebar">
      <div className="brand side-brand">
        <span className="logo-mark">
          <Icon name="bolt" />
        </span>
        <span className="brand-text">
          hypertroph<b>+</b>
        </span>
      </div>

      <div className="side-section-label">Menu</div>
      <nav className="nav-list">
        <button
          className={`nav-item ${section === 'nutrition' ? 'active' : ''}`}
          aria-current={section === 'nutrition' ? 'page' : undefined}
          onClick={() => onNavigate('nutrition')}
        >
          <Icon name="nutrition" className="nav-icon" /> Nutrition
          {nutritionCount > 0 && <span className="nav-badge">{nutritionCount}</span>}
        </button>
        <button
          className={`nav-item ${section === 'training' ? 'active' : ''}`}
          aria-current={section === 'training' ? 'page' : undefined}
          onClick={() => onNavigate('training')}
        >
          <Icon name="training" className="nav-icon" /> Training
          {trainingCount > 0 && <span className="nav-badge">{trainingCount}</span>}
        </button>
      </nav>

      <div className="side-section-label">General</div>
      <nav className="nav-list">
        <button
          className={`nav-item ${section === 'settings' ? 'active' : ''}`}
          aria-current={section === 'settings' ? 'page' : undefined}
          onClick={() => onNavigate('settings')}
        >
          <Icon name="settings" className="nav-icon" /> Settings
        </button>
      </nav>

      <div className="promo">
        <h4>All your data, offline</h4>
        <p>Nutrition and training stay on your device — no account, no cloud.</p>
      </div>
    </aside>
  );
}

function Topbar({
  theme,
  onToggleTheme,
  onSearch,
}: {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onSearch: () => void;
}) {
  return (
    <header className="topbar">
      <button className="search-pill" onClick={onSearch} aria-label="Search foods or exercises">
        <Icon name="search" />
        <span>Search foods or exercises</span>
        <span className="kbd">Ctrl K</span>
      </button>
      <div className="spacer" />
      <button
        className="icon-circle"
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
        onClick={onToggleTheme}
      >
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
      </button>
      <div className="avatar" aria-hidden="true" title="Account (placeholder)">
        H
      </div>
    </header>
  );
}

function PageHead({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      <div className="head-actions">{children}</div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  unit,
  chip,
  featured,
  onClick,
  actionLabel,
}: {
  label: string;
  value: string;
  unit?: string;
  chip?: string;
  featured?: boolean;
  onClick?: () => void;
  actionLabel?: string;
}) {
  return (
    <div className={`kpi ${featured ? 'featured' : ''}`}>
      <span className="kpi-label">{label}</span>
      {onClick && (
        <button className="kpi-action" onClick={onClick} title={actionLabel} aria-label={actionLabel}>
          <Icon name="arrow-up-right" />
        </button>
      )}
      <span className="kpi-value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      {chip && <span className="kpi-chip">{chip}</span>}
    </div>
  );
}

function Gauge({ pct, label }: { pct: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const r = 80;
  const len = Math.PI * r;
  const filled = (clamped / 100) * len;
  const path = `M20 100 A80 80 0 0 1 180 100`;
  return (
    <div className="gauge">
      <svg viewBox="0 0 200 120" role="img" aria-label={`${Math.round(clamped)} percent of daily goal`}>
        <defs>
          <pattern id="gaugeHatch" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" fill="var(--hatch-bg)" />
            <line x1="0" y1="0" x2="0" y2="8" stroke="var(--hatch-color)" strokeWidth="2" />
          </pattern>
        </defs>
        <path d={path} fill="none" stroke="url(#gaugeHatch)" strokeWidth="16" strokeLinecap="round" />
        <path
          d={path}
          fill="none"
          stroke="var(--green-600)"
          strokeWidth="16"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${len}`}
        />
      </svg>
      <div className="gauge-center">
        <span className="gauge-val">{Math.round(clamped)}%</span>
        <span className="gauge-label">{label}</span>
      </div>
    </div>
  );
}

function fmtTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function Stopwatch() {
  const [running, setRunning] = useState(false);
  const [ms, setMs] = useState(0);
  const baseRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running) return;
    baseRef.current = performance.now() - ms;
    const tick = () => {
      setMs(performance.now() - baseRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  return (
    <>
      <div className="timer-value">{fmtTime(ms)}</div>
      <div className="timer-controls">
        <button className={`timer-btn ${running ? '' : 'solid'}`} onClick={() => setRunning((r) => !r)}>
          <Icon name={running ? 'pause' : 'play'} /> {running ? 'Pause' : 'Start'}
        </button>
        <button
          className="timer-btn"
          onClick={() => {
            setRunning(false);
            setMs(0);
          }}
        >
          <Icon name="stop" /> Reset
        </button>
      </div>
    </>
  );
}

// ── Nutrition ───────────────────────────────────────────────
function NutritionSection(props: {
  date: string;
  setDate: (d: string) => void;
  items: DayItemRow[];
  totals: Map<string, { sumMilli: number; hasUnknown: boolean }>;
  targets: Map<string, number>;
  defById: Map<string, NutrientDef>;
  recentFoods: FoodSummary[];
  meals: string[];
  onAddFood: (meal?: string) => void;
  onPickRecent: (f: FoodSummary) => void;
  onDelete: (id: string) => void;
  onAddMeal: () => void;
  onRemoveMeal: (meal: string) => void;
  onCreateCustom: () => void;
}) {
  const kcal = props.totals.get('energy_kcal');
  const kcalTarget = props.targets.get('energy_kcal');
  const kcalVal = kcal?.sumMilli ?? 0;
  const kcalPct = kcalTarget ? (kcalVal / kcalTarget) * 100 : 0;
  const protein = props.totals.get('protein_g');
  const proteinTarget = props.targets.get('protein_g');
  const remaining = kcalTarget != null ? Math.max(0, kcalTarget - kcalVal) : null;
  const isToday = props.date === toISODate(new Date());
  const macros = SUMMARY_NUTRIENTS.filter((n) => n !== 'energy_kcal');

  return (
    <>
      <PageHead
        title="Nutrition"
        subtitle={`${isToday ? 'Today' : props.date} · ${formatNutrient(kcalVal, 'kcal')} of ${
          kcalTarget ? formatNutrient(kcalTarget, 'kcal') : '—'
        } kcal`}
      >
        <div className="date-nav">
          <button
            className="icon-circle"
            aria-label="Previous day"
            title="Previous day"
            onClick={() => props.setDate(addDays(props.date, -1))}
          >
            <Icon name="chevron-left" />
          </button>
          <span className="date-label">{props.date}</span>
          <button
            className="icon-circle"
            aria-label="Next day"
            title="Next day"
            onClick={() => props.setDate(addDays(props.date, 1))}
          >
            <Icon name="chevron-right" />
          </button>
        </div>
        <button className="primary" onClick={() => props.onAddFood()}>
          <Icon name="plus" /> Log food
        </button>
      </PageHead>

      <div className="kpi-grid">
        <KpiCard
          featured
          label="Calories today"
          value={formatNutrient(kcalVal, 'kcal')}
          unit=" kcal"
          chip={`${Math.round(Math.min(100, kcalPct))}% of goal`}
          onClick={() => props.onAddFood()}
          actionLabel="Log food"
        />
        <KpiCard
          label="Protein today"
          value={protein ? formatNutrient(protein.sumMilli, 'g') : '0'}
          unit=" g"
          chip={proteinTarget ? `of ${formatNutrient(proteinTarget, 'g')} g` : 'no goal set'}
        />
        <KpiCard
          label="Entries logged"
          value={String(props.items.length)}
          unit={props.items.length === 1 ? ' item' : ' items'}
          chip={isToday ? 'today' : props.date}
        />
        <KpiCard
          label="Calories left"
          value={remaining != null ? formatNutrient(remaining, 'kcal') : '—'}
          unit=" kcal"
          chip={remaining != null ? 'to goal' : 'set a goal'}
        />
      </div>

      <div className="dash">
        <section className="card col-span-2">
          <div className="card-head">
            <h3>Macro breakdown</h3>
            {kcal?.hasUnknown && <span className="tag partial">partial data</span>}
          </div>
          <div className="bar-list">
            {macros.map((n) => {
              const t = props.totals.get(n);
              const target = props.targets.get(n);
              const def = props.defById.get(n);
              const p = t && target ? Math.min(100, (t.sumMilli / target) * 100) : 0;
              return (
                <div className="bar-item" key={n}>
                  <div className="row small">
                    <span>{def?.name ?? n}</span>
                    <span className="mono">
                      {t ? formatNutrient(t.sumMilli, def?.unit ?? 'g') : '0'} /{' '}
                      {target ? formatNutrient(target, def?.unit ?? 'g') : '—'} {def?.unit ?? 'g'}
                    </span>
                  </div>
                  <div className="pill-bar">
                    <span style={{ width: `${p}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Calorie goal</h3>
          </div>
          <Gauge pct={kcalPct} label={kcalTarget ? `of ${formatNutrient(kcalTarget, 'kcal')} kcal` : 'no goal set'} />
          <p className="muted small" style={{ textAlign: 'center', marginTop: 10 }}>
            {kcalTarget ? `${formatNutrient(kcalVal, 'kcal')} consumed today` : 'Set a daily calorie target in Settings.'}
          </p>
        </section>
      </div>

      <div className="dash">
        <section className="card col-span-2">
          <div className="card-head">
            <h3>Today's meals</h3>
            <button className="primary small" onClick={() => props.onAddMeal()}>
              <Icon name="plus" /> Add meal
            </button>
          </div>
          {props.meals.map((meal, i) => {
            const items = props.items.filter((it) => it.mealSection === meal);
            const mealKcal = items.reduce((acc, it) => {
              const e = it.nutrients.find((n) => n.nutrientId === 'energy_kcal');
              return acc + (e?.amountMilli ?? 0);
            }, 0);
            return (
              <div className="meal" key={meal}>
                <div className="meal-head row">
                  <strong className="meal-name">
                    <span className="meal-index">M{i + 1}</span>
                    {items.length > 0 ? (
                      <span className="status-chip done">{items.length} logged</span>
                    ) : (
                      <span className="status-chip miss">empty</span>
                    )}
                  </strong>
                  <span className="muted small">{formatNutrient(mealKcal, 'kcal')} kcal</span>
                  <div className="nav">
                    <button className="ghost small" title={`Add to M${i + 1}`} onClick={() => props.onAddFood(meal)}>
                      <Icon name="plus" /> Add
                    </button>
                    <button
                      className="ghost small danger"
                      title="Remove meal"
                      disabled={props.meals.length <= 1}
                      onClick={() => props.onRemoveMeal(meal)}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                </div>
                {items.map((it) => {
                  const e = it.nutrients.find((n) => n.nutrientId === 'energy_kcal');
                  const p = it.nutrients.find((n) => n.nutrientId === 'protein_g');
                  return (
                    <div className="item" key={it.id}>
                      <span>
                        {it.label}{' '}
                        <span className="muted small">
                          {it.quantityG ? `· ${it.portionLabel ?? `${Math.round(it.quantityG)} g`}` : ''}
                        </span>
                      </span>
                      <span className="mono small">
                        {formatNutrient(e?.amountMilli ?? null, 'kcal')} kcal · P{formatNutrient(p?.amountMilli ?? null, 'g')}
                      </span>
                      <button className="ghost small" onClick={() => props.onDelete(it.id)} title="Delete">
                        <Icon name="trash" />
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
          <p className="muted small" style={{ marginTop: 12 }}>
            Meals are just M1, M2, M3… Adding one appends M{props.meals.length + 1}. Removing a meal hides its section, but
            items logged under it still count toward today's totals.
          </p>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Recent foods</h3>
            <button className="ghost small" onClick={props.onCreateCustom}>
              <Icon name="plus" /> Custom
            </button>
          </div>
          {props.recentFoods.length === 0 && <p className="muted small">Nothing logged yet.</p>}
          {props.recentFoods.map((f) => (
            <button key={f.id} className="list-row" onClick={() => props.onPickRecent(f)}>
              <span className="icon-tile soft">
                <Icon name="nutrition" />
              </span>
              <span className="grow ellipsis">{f.name}</span>
              <Icon name="chevron-right" className="chev" />
            </button>
          ))}
        </section>
      </div>
    </>
  );
}

// ── Training ────────────────────────────────────────────────
function TrainingSection(props: {
  activeWorkout: WorkoutRow | null;
  units: 'kg' | 'lb';
  weeklyVolume: Map<string, number>;
  muscleNames: Map<string, string>;
  secondaryFactor: number;
  routines: RoutineSummary[];
  mode: TrainingMode;
  onModeChange: (m: TrainingMode) => void;
  onStartRandom: () => void;
  onStartRoutine: (id: string) => void;
  onAddExercise: () => void;
  onAddSet: (we: WorkoutExerciseRow, load: string, reps: string, rir: string, setType: 'working' | 'warmup') => void;
  onFinish: () => void;
  onNewPlan: () => void;
  onEditPlan: (id: string) => void;
  onDeletePlan: (id: string) => void;
  getLastSet: (exerciseId: string) => LastSetHint | null;
}) {
  const totalSets = [...props.weeklyVolume.values()].reduce((a, b) => a + b, 0);
  const exerciseCount = props.activeWorkout?.exercises.length ?? 0;
  const nextRoutine = props.routines[0];

  return (
    <>
      <PageHead
        title={props.activeWorkout ? props.activeWorkout.name : 'Training'}
        subtitle={
          props.activeWorkout
            ? `Active workout · ${exerciseCount} exercise${exerciseCount === 1 ? '' : 's'}`
            : 'Track sets, follow a plan and watch your weekly volume.'
        }
      >
        <button className="ghost" onClick={props.onAddExercise}>
          <Icon name="plus" /> Exercise
        </button>
        {props.activeWorkout && (
          <button className="primary" onClick={props.onFinish}>
            Finish workout
          </button>
        )}
      </PageHead>

      <div className="kpi-grid">
        <KpiCard featured label="Working sets (7d)" value={totalSets.toFixed(0)} unit=" sets" chip="this week" />
        <KpiCard
          label="Active workout"
          value={props.activeWorkout ? 'On' : '—'}
          chip={props.activeWorkout ? `${exerciseCount} exercises` : 'none yet'}
        />
        <KpiCard
          label="Saved plans"
          value={String(props.routines.length)}
          unit={props.routines.length === 1 ? ' plan' : ' plans'}
          chip="ready to start"
        />
        <KpiCard
          label="Exercises today"
          value={String(exerciseCount)}
          unit={exerciseCount === 1 ? ' exercise' : ' exercises'}
          chip="in this session"
        />
      </div>

      <div className="dash">
        <section className="card col-span-2">
          <Progress weeklyVolume={props.weeklyVolume} muscleNames={props.muscleNames} secondaryFactor={props.secondaryFactor} />
        </section>

        <section className="card next-card">
          <div className="card-head">
            <h3>Next session</h3>
          </div>
          {props.activeWorkout ? (
            <>
              <div className="list-row">
                <span className="icon-tile">
                  <Icon name="activity" />
                </span>
                <span className="grow">
                  <strong>In progress</strong>
                  <div className="muted small">
                    {exerciseCount} exercise{exerciseCount === 1 ? '' : 's'} logged
                  </div>
                </span>
              </div>
              <button className="primary block" onClick={props.onFinish}>
                Finish workout
              </button>
            </>
          ) : nextRoutine ? (
            <>
              <div className="list-row">
                <span className="icon-tile blue">
                  <Icon name="training" />
                </span>
                <span className="grow">
                  <strong>{nextRoutine.name}</strong>
                  <div className="muted small">
                    {nextRoutine.exerciseCount} {nextRoutine.exerciseCount === 1 ? 'exercise' : 'exercises'}
                  </div>
                </span>
              </div>
              <button className="primary block" onClick={() => props.onStartRoutine(nextRoutine.id)}>
                Start {nextRoutine.name}
              </button>
            </>
          ) : (
            <>
              <p className="muted small">No saved plans yet. Start a free workout, or build a plan below.</p>
              <button className="primary block" onClick={props.onStartRandom}>
                Start workout
              </button>
            </>
          )}
        </section>
      </div>

      <div className="dash">
        <section className="card col-span-2">
          <div className="card-head">
            <h3>{props.activeWorkout ? 'Exercises' : 'Workout plans'}</h3>
            {!props.activeWorkout && (
              <div className="segments" role="tablist" aria-label="Workout start mode">
                <button
                  role="tab"
                  aria-selected={props.mode === 'random'}
                  className={`segment ${props.mode === 'random' ? 'active' : ''}`}
                  onClick={() => props.onModeChange('random')}
                >
                  Random
                </button>
                <button
                  role="tab"
                  aria-selected={props.mode === 'plan'}
                  className={`segment ${props.mode === 'plan' ? 'active' : ''}`}
                  onClick={() => props.onModeChange('plan')}
                >
                  Plan
                </button>
              </div>
            )}
          </div>

          {props.activeWorkout ? (
            props.activeWorkout.exercises.length === 0 ? (
              <p className="muted">Add an exercise to begin.</p>
            ) : (
              <div className="grid">
                {props.activeWorkout.exercises.map((we) => (
                  <ExerciseCard key={we.id} we={we} units={props.units} onAddSet={props.onAddSet} getLastSet={props.getLastSet} />
                ))}
              </div>
            )
          ) : props.mode === 'random' ? (
            <>
              <p className="muted">No active workout. Start one to log sets.</p>
              <div className="nav" style={{ marginTop: 12 }}>
                <button className="primary" onClick={props.onStartRandom}>
                  <Icon name="play" /> Start workout
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="row" style={{ marginBottom: 12 }}>
                <span className="muted small">Pick a saved plan to start, or build a new one.</span>
                <button className="ghost" onClick={props.onNewPlan}>
                  <Icon name="plus" /> New plan
                </button>
              </div>
              {props.routines.length === 0 && (
                <p className="muted">You don't have any workout plans yet. Create one to get started.</p>
              )}
              <div className="grid">
                {props.routines.map((r) => (
                  <div className="card plan-card" key={r.id}>
                    <div className="row">
                      <h3>{r.name}</h3>
                      <span className="muted small">
                        {r.exerciseCount} {r.exerciseCount === 1 ? 'exercise' : 'exercises'}
                      </span>
                    </div>
                    {r.notes && <p className="muted small">{r.notes}</p>}
                    <div className="nav" style={{ marginTop: 8 }}>
                      <button className="primary" onClick={() => props.onStartRoutine(r.id)}>
                        Start
                      </button>
                      <button className="ghost" onClick={() => props.onEditPlan(r.id)}>
                        Edit
                      </button>
                      <button className="ghost danger" onClick={() => props.onDeletePlan(r.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        <section className="timer-card">
          <h3>Session timer</h3>
          <Stopwatch />
        </section>
      </div>
    </>
  );
}

function ExerciseCard({
  we,
  units,
  onAddSet,
  getLastSet,
}: {
  we: WorkoutExerciseRow;
  units: 'kg' | 'lb';
  onAddSet: (we: WorkoutExerciseRow, load: string, reps: string, rir: string, setType: 'working' | 'warmup') => void;
  getLastSet: (exerciseId: string) => LastSetHint | null;
}) {
  // Prefill the first set from the exercise's most recent logged set, falling
  // back to the plan's targets, so the user isn't retyping the same numbers.
  const [load, setLoad] = useState(() => {
    const h = getLastSet(we.exerciseId);
    if (!h || h.loadG == null) return '';
    const v = units === 'kg' ? gToKg(h.loadG) : gToLb(h.loadG);
    return String(Math.round(v * 10) / 10);
  });
  const [reps, setReps] = useState(() => {
    const h = getLastSet(we.exerciseId);
    if (h && h.reps != null) return String(h.reps);
    if (we.targetReps && /^\d+$/.test(we.targetReps.trim())) return we.targetReps.trim();
    return '8';
  });
  const [rir, setRir] = useState(() => {
    const h = getLastSet(we.exerciseId);
    if (h && h.rir != null) return String(h.rir);
    if (we.targetRir != null) return String(we.targetRir);
    return '2';
  });

  const hasTarget = we.targetSets != null || we.targetReps != null || we.targetRir != null;

  return (
    <div className="card">
      <h3>{we.name}</h3>
      {hasTarget && (
        <p className="muted small target-hint">
          Target: {we.targetSets ?? '—'} × {we.targetReps ?? '—'}
          {we.targetRir != null ? ` @ RIR ${we.targetRir}` : ''}
        </p>
      )}
      <div className="set-row small muted">
        <span>Set</span>
        <span>Load ({units})</span>
        <span>Reps</span>
        <span>RIR</span>
        <span>e1RM</span>
      </div>
      {we.sets.map((s) => (
        <div className="set-row mono small" key={s.id}>
          <span className={s.setType === 'warmup' ? 'muted' : ''}>{s.setType === 'warmup' ? 'W' : s.setIndex}</span>
          <span>{s.loadG ? (units === 'kg' ? gToKg(s.loadG) : gToLb(s.loadG)).toFixed(1) : '—'}</span>
          <span>{s.reps ?? '—'}</span>
          <span>{s.rir ?? '—'}</span>
          <span>{s.loadG && s.reps ? Math.round((units === 'kg' ? gToKg(e1rmG(s.loadG, s.reps)) : gToLb(e1rmG(s.loadG, s.reps)))) : '—'}</span>
        </div>
      ))}
      <div className="set-row" style={{ marginTop: 8 }}>
        <span />
        <input value={load} onChange={(e) => setLoad(e.target.value)} placeholder={units} inputMode="decimal" />
        <input value={reps} onChange={(e) => setReps(e.target.value)} inputMode="numeric" />
        <input value={rir} onChange={(e) => setRir(e.target.value)} inputMode="numeric" />
        <button className="primary" onClick={() => onAddSet(we, load, reps, rir, 'working')}>
          +
        </button>
      </div>
      <button className="ghost small" onClick={() => onAddSet(we, load, reps, rir, 'warmup')}>
        + warm-up set
      </button>
    </div>
  );
}

// ── Plan builder ────────────────────────────────────────────
function PlanBuilder(props: {
  plan: BuilderState;
  onChangeName: (v: string) => void;
  onAddExercise: () => void;
  onChangeExercise: (index: number, patch: Partial<BuilderExercise>) => void;
  onRemoveExercise: (index: number) => void;
  onMoveExercise: (index: number, dir: -1 | 1) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="palette-overlay builder-overlay" onMouseDown={props.onCancel}>
      <div className="palette builder" onMouseDown={(e) => e.stopPropagation()}>
        <div className="builder-head">
          <strong>{props.plan.id ? 'Edit workout plan' : 'New workout plan'}</strong>
          <button className="ghost small" onClick={props.onCancel}>
            Close
          </button>
        </div>
        <div className="builder-body">
          <label className="builder-name">
            <span className="muted small">Plan name</span>
            <input
              value={props.plan.name}
              placeholder="e.g. Push day"
              onChange={(e) => props.onChangeName(e.target.value)}
              autoFocus
            />
          </label>

          {props.plan.exercises.length === 0 && (
            <p className="muted small">No exercises yet. Add one to build your plan.</p>
          )}

          {props.plan.exercises.map((ex, i) => (
            <div className="builder-row" key={`${ex.exerciseId}-${i}`}>
              <div className="builder-row-head">
                <span>{ex.name}</span>
                <div className="nav">
                  <button className="icon-btn small" title="Move up" onClick={() => props.onMoveExercise(i, -1)} disabled={i === 0}>
                    ↑
                  </button>
                  <button
                    className="icon-btn small"
                    title="Move down"
                    onClick={() => props.onMoveExercise(i, 1)}
                    disabled={i === props.plan.exercises.length - 1}
                  >
                    ↓
                  </button>
                  <button className="ghost danger small" onClick={() => props.onRemoveExercise(i)}>
                    Remove
                  </button>
                </div>
              </div>
              <div className="builder-targets">
                <label>
                  <span className="muted small">Sets</span>
                  <input
                    value={ex.targetSets}
                    inputMode="numeric"
                    placeholder="3"
                    onChange={(e) => props.onChangeExercise(i, { targetSets: e.target.value })}
                  />
                </label>
                <label>
                  <span className="muted small">Reps</span>
                  <input
                    value={ex.targetReps}
                    placeholder="8-12"
                    onChange={(e) => props.onChangeExercise(i, { targetReps: e.target.value })}
                  />
                </label>
                <label>
                  <span className="muted small">RIR</span>
                  <input
                    value={ex.targetRir}
                    inputMode="numeric"
                    placeholder="2"
                    onChange={(e) => props.onChangeExercise(i, { targetRir: e.target.value })}
                  />
                </label>
              </div>
            </div>
          ))}

          <button className="ghost" onClick={props.onAddExercise}>
            + Add exercise
          </button>
        </div>
        <div className="builder-foot">
          <button className="ghost" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="primary" onClick={props.onSave}>
            Save plan
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Progress ────────────────────────────────────────────────
function Progress(props: { weeklyVolume: Map<string, number>; muscleNames: Map<string, string>; secondaryFactor: number }) {
  const max = Math.max(1, ...props.weeklyVolume.values());
  const rows = [...props.weeklyVolume.entries()].sort((a, b) => b[1] - a[1]);
  return (
    <>
      <div className="card-head">
        <h3>Weekly working-set volume</h3>
        <span className="muted small">7 days · secondary ×{props.secondaryFactor}</span>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No working sets logged this week.</p>
      ) : (
        <div className="bar-list">
          {rows.map(([m, v]) => (
            <div className="bar-item" key={m}>
              <div className="row small">
                <span>{props.muscleNames.get(m) ?? m}</span>
                <span className="mono">{v.toFixed(1)} sets</span>
              </div>
              <div className="pill-bar">
                <span style={{ width: `${(v / max) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── Settings ────────────────────────────────────────────────
function Settings(props: {
  units: 'kg' | 'lb';
  onChangeUnits: (u: 'kg' | 'lb') => void;
  secondaryFactor: number;
  onChangeSecondary: (n: number) => void;
  targets: Map<string, number>;
  defById: Map<string, NutrientDef>;
  onChangeTarget: (id: string, value: number) => void;
  onExportBackup: () => void;
  onImportBackup: (file: File) => void;
  isDesktop: boolean;
  appVersion: string | null;
  update: UpdateStatus | null;
  onCheckUpdates: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <PageHead title="Settings" subtitle="Preferences, daily targets and local backups" />
      <div className="grid" style={{ marginTop: 16 }}>
        <div className="card">
          <h3>Units</h3>
          <div className="row">
            <span>Weight units</span>
            <div className="nav">
              <button className={props.units === 'kg' ? 'primary' : ''} onClick={() => props.onChangeUnits('kg')}>
                kg
              </button>
              <button className={props.units === 'lb' ? 'primary' : ''} onClick={() => props.onChangeUnits('lb')}>
                lb
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <h3>Training</h3>
          <div className="row">
            <span>Secondary volume factor</span>
            <input
              type="number"
              step="0.1"
              value={props.secondaryFactor}
              onChange={(e) => props.onChangeSecondary(Number(e.target.value))}
              style={{ width: 90 }}
            />
          </div>
        </div>

        <div className="card">
          <h3>Daily targets</h3>
          {[...props.defById.values()]
            .filter((d) => d.targetable)
            .map((d) => {
              const t = props.targets.get(d.id);
              const display = t != null ? t / 1000 : '';
              return (
                <div className="row" key={d.id} style={{ marginBottom: 10 }}>
                  <span>{d.name}</span>
                  <span>
                    <input
                      type="number"
                      defaultValue={display}
                      onBlur={(e) => props.onChangeTarget(d.id, Number(e.target.value))}
                      style={{ width: 110 }}
                    />{' '}
                    <span className="muted small">{d.unit}</span>
                  </span>
                </div>
              );
            })}
        </div>

        <div className="card">
          <h3>Backup &amp; restore</h3>
          <p className="small muted">
            Your records live only on this device. Export a portable backup file regularly and keep it somewhere safe — if the app
            is uninstalled or the device is lost without a backup, the data cannot be recovered.
          </p>
          <div className="nav" style={{ marginTop: 10 }}>
            <button className="primary" onClick={props.onExportBackup}>
              Export backup
            </button>
            <button onClick={() => fileRef.current?.click()}>Import backup…</button>
            <input
              ref={fileRef}
              type="file"
              accept=".sqlite,.db,application/vnd.sqlite3,application/octet-stream"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) props.onImportBackup(f);
                e.target.value = '';
              }}
            />
          </div>
        </div>

        <div className="card">
          <h3>Data &amp; privacy</h3>
          <p className="small muted">
            Local-only. No account, no telemetry, no network access. Stored in a private SQLite file on this device.
          </p>
        </div>

        {props.isDesktop && (
          <div className="card">
            <h3>App updates</h3>
            <p className="small muted">
              {props.appVersion ? `hypertroph+ ${props.appVersion}. ` : ''}
              Updates download automatically and install the next time you quit. You can also check now.
            </p>
            <div className="nav" style={{ marginTop: 10 }}>
              <button
                onClick={props.onCheckUpdates}
                disabled={props.update?.state === 'checking' || props.update?.state === 'downloading'}
              >
                {props.update?.state === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>
            </div>
            {props.update && <p className="small muted" style={{ marginTop: 8 }}>{describeUpdate(props.update)}</p>}
          </div>
        )}
      </div>
    </>
  );
}

function describeUpdate(u: UpdateStatus): string {
  switch (u.state) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `Update ${u.version} found — downloading…`;
    case 'downloading':
      return `Downloading update… ${u.percent}%`;
    case 'downloaded':
      return `Update ${u.version} ready — it will install when you quit.`;
    case 'not-available':
      return 'You’re on the latest version.';
    case 'error':
      return `Update check failed: ${u.message}`;
    default:
      return '';
  }
}

// ── Log dialog ──────────────────────────────────────────────
function LogDialog(props: {
  food: FoodDetail;
  defById: Map<string, NutrientDef>;
  units: 'kg' | 'lb';
  meals: string[];
  initialMeal?: string;
  onCancel: () => void;
  onLog: (food: FoodDetail, quantityG: number, portionLabel: string, meal: string) => void;
}) {
  const mealOptions = props.meals.length ? props.meals : [...DEFAULT_MEALS];
  const defaultPortion = props.food.portions.find((p) => p.isDefault) ?? props.food.portions[0];
  const [meal, setMeal] = useState<string>(
    props.initialMeal && mealOptions.includes(props.initialMeal) ? props.initialMeal : mealOptions[0],
  );
  const [unitKey, setUnitKey] = useState<string>(defaultPortion ? defaultPortion.id : 'g');
  const [quantity, setQuantity] = useState(defaultPortion ? '1' : '100');

  const portions = props.food.portions;
  const selectedPortion = portions.find((p) => p.id === unitKey);
  const quantityG = selectedPortion ? Number(quantity) * selectedPortion.gramWeight : Number(quantity);
  const preview = snapshotLogItem({
    food: { id: props.food.id, name: props.food.name, basis: 'per_100g', nutrients: props.food.nutrients },
    quantityG: quantityG || 0,
  });

  return (
    <div className="palette-overlay" onMouseDown={props.onCancel}>
      <div className="palette" style={{ maxHeight: '70vh' }} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <strong>{props.food.name}</strong> <span className="tag">{props.food.prepState}</span>{' '}
          <span className="tag">{props.food.quality}</span>
        </div>
        <div style={{ padding: 16, display: 'grid', gap: 12 }}>
          <div className="row">
            <span>Quantity</span>
            <span>
              <input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" style={{ width: 80 }} />
              <select value={unitKey} onChange={(e) => setUnitKey(e.target.value)} style={{ marginLeft: 6 }}>
                <option value="g">grams</option>
                {portions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} ({p.gramWeight} g)
                  </option>
                ))}
              </select>
            </span>
          </div>
          <div className="row">
            <span>Meal</span>
            <select value={meal} onChange={(e) => setMeal(e.target.value)}>
              {mealOptions.map((m, i) => (
                <option key={m} value={m}>
                  M{i + 1}
                </option>
              ))}
            </select>
          </div>
          <div className="card" style={{ background: 'var(--panel-2)' }}>
            <div className="row small">
              <span>={unitKey === 'g' ? `${Math.round(quantityG)} g` : `${quantity} × ${selectedPortion?.label}`}</span>
            </div>
            <div style={{ marginTop: 6 }}>
              {SUMMARY_NUTRIENTS.map((n) => {
                const val = preview.nutrients.find((x) => x.nutrientId === n);
                const def = props.defById.get(n);
                return (
                  <span key={n} style={{ marginRight: 14 }} className="mono">
                    {def?.name} {formatNutrient(val?.amountMilli ?? null, def?.unit ?? 'g')}
                  </span>
                );
              })}
            </div>
          </div>
          <div className="row">
            <button className="ghost" onClick={props.onCancel}>
              Cancel
            </button>
            <button
              className="primary"
              onClick={() => props.onLog(props.food, quantityG, selectedPortion?.label ?? `${Math.round(quantityG)} g`, meal)}
            >
              Log
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Custom food dialog ──────────────────────────────────────
function CustomFoodDialog(props: { onCancel: () => void; onCreate: (name: string, kcal: number, protein: number, carb: number, fat: number) => void }) {
  const [name, setName] = useState('');
  const [kcal, setKcal] = useState('0');
  const [protein, setProtein] = useState('0');
  const [carb, setCarb] = useState('0');
  const [fat, setFat] = useState('0');

  return (
    <div className="palette-overlay" onMouseDown={props.onCancel}>
      <div className="palette" style={{ maxHeight: '70vh' }} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <strong>Create custom food</strong> <span className="muted small">values per 100 g</span>
        </div>
        <div style={{ padding: 16, display: 'grid', gap: 10 }}>
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="row">
            <span>Calories (kcal)</span>
            <input value={kcal} onChange={(e) => setKcal(e.target.value)} inputMode="decimal" style={{ width: 100 }} />
          </div>
          <div className="row">
            <span>Protein (g)</span>
            <input value={protein} onChange={(e) => setProtein(e.target.value)} inputMode="decimal" style={{ width: 100 }} />
          </div>
          <div className="row">
            <span>Carbs (g)</span>
            <input value={carb} onChange={(e) => setCarb(e.target.value)} inputMode="decimal" style={{ width: 100 }} />
          </div>
          <div className="row">
            <span>Fat (g)</span>
            <input value={fat} onChange={(e) => setFat(e.target.value)} inputMode="decimal" style={{ width: 100 }} />
          </div>
          <div className="row">
            <button className="ghost" onClick={props.onCancel}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={!name.trim()}
              onClick={() => props.onCreate(name.trim(), Number(kcal), Number(protein), Number(carb), Number(fat))}
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
