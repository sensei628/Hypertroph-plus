import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { loadDatabase, exportDatabaseBytes, flushPersistence, type DB } from '../data/db';
import { loadRefDatabase } from '../data/refdb';
import {
  exportBackup,
  exportBackupToFolder,
  isNativeMobile,
  importBackup,
  importSqlBackup,
  buildAiPrompt,
  type ExportResult,
  type ImportMode,
} from '../data/backup';
import { getDesktopBridge, type UpdateStatus } from '../desktop';
import {
  SqliteRepository,
  BODY_METRIC_TYPES,
  bodyMetricUnit,
  isWeightMetric,
  type BodyMetric,
  type BodyMetricType,
  type DayItemRow,
  type DeleteMode,
  type DeleteScope,
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
  type RecordStats,
  type ScopeStats,
  type NutritionPlan,
  type NutritionPlanInput,
  type NutritionDayTotals,
  type TrainingSetRow,
  type LoggedExercise,
  type DietPlan,
  type DietPlanDetail,
  type DietPlanMeal,
  type DietPlanCheck,
  type DietPlanMode,
  type ProteinSource,
  type ProteinSourceInput,
  type MicroTarget,
} from '../data/repository';
import { formatNutrient, toMilli } from '../domain/nutrients';
import { LogItem, sumNutrients, snapshotLogItem } from '../domain/nutrition';
import {
  NUTRIENT_GROUP_LABEL,
  NUTRIENT_GROUP_ORDER,
  nutrientGroup,
  type NutrientGroup,
} from '../domain/nutrientGroups';
import {
  computeEnergyPlan,
  calibrateMaintenance,
  ACTIVITY_OPTIONS,
  GOAL_OPTIONS,
  GOAL_LABELS,
  kgToLb,
  lbToKg,
  type EnergyInputs,
  type CalibrationResult,
  type Goal,
  type ActivityLevel,
  type Sex,
} from '../domain/energy';
import { gToKg, gToLb, kgToG, lbToG, e1rmG } from '../domain/training';
import { addDaysISO, dailySeries, recentWeekStarts, sumByWeek, mean, macroEnergySplit, shortLabel } from '../domain/stats';
import { checkForUpdate, type UpdateCheck } from '../domain/updates';
import { BarChart, LineChart, StackedBar, Ring } from './charts';
import { CommandPalette } from './CommandPalette';

type Section = 'nutrition' | 'diet' | 'training' | 'body' | 'stats' | 'settings';
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
interface CalibrationInfo extends CalibrationResult {
  spanDays: number;
  loggedDays: number;
  weightEntries: number;
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

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back to a hidden textarea */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
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

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MEAL_TYPE_OPTIONS = ['breakfast', 'lunch', 'dinner', 'snack'];
const DIET_MODES: { value: DietPlanMode; label: string }[] = [
  { value: 'whole', label: 'Whole foods' },
  { value: 'protein', label: 'Protein rotation' },
];

// Sum the planned macros for one meal by scaling each food's per-100 g values
// to the stored grams. Foods that can't be resolved are flagged, never zeroed.
function plannedMealTotals(meal: DietPlanMeal, getFood: (id: string) => FoodDetail | null) {
  let kcal = 0;
  let protein = 0;
  let carb = 0;
  let fat = 0;
  let missing = false;
  for (const it of meal.items) {
    const food = getFood(it.foodId);
    if (!food) {
      missing = true;
      continue;
    }
    const snap = snapshotLogItem({
      food: { id: food.id, name: food.name, basis: food.basis as 'per_100g' | 'per_100ml', nutrients: food.nutrients },
      quantityG: it.grams,
    });
    for (const n of snap.nutrients) {
      const v = n.amountMilli;
      if (v === null || v === undefined) {
        missing = true;
        continue;
      }
      if (n.nutrientId === 'energy_kcal') kcal += v;
      else if (n.nutrientId === 'protein_g') protein += v;
      else if (n.nutrientId === 'carb_g') carb += v;
      else if (n.nutrientId === 'fat_g') fat += v;
    }
  }
  return { kcal, protein, carb, fat, missing };
}

// Editable grams field that keeps the raw text while typing and commits on blur
// or Enter, so intermediate values ("1." or "") never hit the database.
function GramsInput({ value, onCommit, step = 5 }: { value: number; onCommit: (v: number) => void; step?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  function commit() {
    const n = Number(text);
    if (Number.isFinite(n) && n >= 0) onCommit(n);
    else setText(String(value));
  }
  return (
    <input
      className="grams-input"
      type="number"
      min={0}
      step={step}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      aria-label="Grams of this food"
    />
  );
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
  const [recordStats, setRecordStats] = useState<RecordStats>({
    nutrition: { count: 0, firstDate: null, lastDate: null },
    training: { count: 0, firstDate: null, lastDate: null },
    body: { count: 0, firstDate: null, lastDate: null },
  });
  const [refReady, setRefReady] = useState(false);
  const [nutritionPlans, setNutritionPlans] = useState<NutritionPlan[]>([]);
  const [activePlan, setActivePlan] = useState<NutritionPlan | null>(null);
  const [latestWeightKg, setLatestWeightKg] = useState<number | null>(null);
  const [bodyMetrics, setBodyMetrics] = useState<BodyMetric[]>([]);
  const [dietPlans, setDietPlans] = useState<DietPlan[]>([]);
  const [dietPlan, setDietPlan] = useState<DietPlanDetail | null>(null);
  const [dietChecks, setDietChecks] = useState<DietPlanCheck[]>([]);
  const [dietPickMeal, setDietPickMeal] = useState<string | null>(null);
  const [proteinSources, setProteinSources] = useState<ProteinSource[]>([]);
  const [microTargets, setMicroTargets] = useState<MicroTarget[]>([]);

  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [palettePurpose, setPalettePurpose] = useState<'log' | 'builder'>('log');
  const [logTarget, setLogTarget] = useState<FoodDetail | null>(null);
  const [logMealDefault, setLogMealDefault] = useState<string>(DEFAULT_MEALS[0]);
  const [customOpen, setCustomOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const desktop = getDesktopBridge();
  const [appVersion, setAppVersion] = useState<string | null>(
    typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null,
  );
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [webUpdate, setWebUpdate] = useState<UpdateCheck | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await loadDatabase();
        // The reference pack (USDA catalog, ~14 MB gzipped) is fetched in the
        // background and attached when ready so it never blocks first render.
        const r = new SqliteRepository(db);
        void loadRefDatabase().then((ref) => {
          if (cancelled) return;
          if (ref) r.setRefDatabase(ref);
          setRefReady(true);
        });
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
        setNutritionPlans(r.listNutritionPlans());
        setActivePlan(r.getActiveNutritionPlan());
        setDietPlans(r.listDietPlans());
        setDietPlan(r.getActivePlan());
        setProteinSources(r.listProteinSources());
        setMicroTargets(r.getMicroTargets());
        setBodyMetrics(r.listBodyMetrics());
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
    setRecordStats(repo.getRecordStats());
    setNutritionPlans(repo.listNutritionPlans());
    setActivePlan(repo.getActiveNutritionPlan());
    setDietPlans(repo.listDietPlans());
    setDietPlan(repo.getActivePlan());
    setProteinSources(repo.listProteinSources());
    setMicroTargets(repo.getMicroTargets());
    setDietChecks(repo.getChecksForDate(date));
    setLatestWeightKg(repo.getBodyMetrics('weight_kg', 1)[0]?.value ?? null);
    setBodyMetrics(repo.listBodyMetrics());
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
      const messages: Record<ExportResult, string> = {
        saved: 'Backup saved',
        shared: 'Backup ready — choose where to save it',
        downloaded: 'Backup file downloaded',
        cancelled: 'Export cancelled',
      };
      setToast(messages[how]);
    } catch (e) {
      setToast(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // Mobile-only: write the backup straight to the device file area instead of
  // going through the share sheet.
  const handleSaveBackupToFolder = useCallback(async () => {
    if (!dbRef.current) return;
    try {
      const res = await exportBackupToFolder(exportDatabaseBytes(dbRef.current));
      setToast(res.ok ? 'Backup saved to the app folder' : `Could not save backup: ${res.error ?? 'unknown error'}`);
    } catch (e) {
      setToast(`Could not save backup: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const runImport = useCallback(async (name: string, bytes: Uint8Array, mode: ImportMode) => {
    const db = dbRef.current;
    if (!db) return;
    if (mode === 'replace') {
      const confirmed = window.confirm(
        'Replace ALL current data with this backup?\n\nThe current database will be saved as a safety copy first.',
      );
      if (!confirmed) return;
    }
    try {
      const current = exportDatabaseBytes(db);
      const isSql = /\.sql$/i.test(name);
      const report = isSql
        ? await importSqlBackup(new TextDecoder().decode(bytes), mode, current)
        : await importBackup(bytes, mode, current);
      if (!report.ok) {
        setToast(`Import failed: ${report.error ?? 'invalid backup file'}`);
        return;
      }
      const parts: string[] = [];
      if (report.migratedFrom !== null) parts.push(`upgraded from v${report.migratedFrom}`);
      if (mode === 'merge') parts.push(`merged ${report.inserted} new · skipped ${report.skipped}`);
      if (report.safetyCopy) parts.push('safety copy saved');
      const note = `Import complete${parts.length ? ` — ${parts.join(' · ')}` : ''}`;
      try {
        sessionStorage.setItem('hypertroph.flash', note);
      } catch {
        /* ignore */
      }
      // importBackup only writes after full validation; reload to rebuild from it.
      window.location.reload();
    } catch (e) {
      setToast(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const handleImportBackup = useCallback(
    async (file: File, mode: ImportMode) => {
      await runImport(file.name, new Uint8Array(await file.arrayBuffer()), mode);
    },
    [runImport],
  );

  // Desktop: prefer the native Open dialog. Anything else (or an older shell
  // without the bridge method) falls back to the hidden file input.
  const handleImportBackupRequest = useCallback(
    async (mode: ImportMode, fallback: () => void) => {
      if (!desktop?.openBackup) {
        fallback();
        return;
      }
      try {
        const res = await desktop.openBackup();
        if (!res.ok) {
          if (!res.canceled) setToast(`Import failed: ${res.error ?? 'could not open file'}`);
          return;
        }
        if (!res.data) return;
        await runImport(res.name ?? 'backup.sqlite', res.data, mode);
      } catch (e) {
        setToast(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [desktop, runImport],
  );

  useEffect(() => {
    try {
      const flash = sessionStorage.getItem('hypertroph.flash');
      if (flash) {
        sessionStorage.removeItem('hypertroph.flash');
        setToast(flash);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const handleCopyAiPrompt = useCallback(async () => {
    if (!dbRef.current) return;
    try {
      const prompt = buildAiPrompt(dbRef.current);
      const ok = await copyText(prompt);
      setToast(ok ? 'AI prompt copied to clipboard' : 'Copy failed — select the text manually');
    } catch (e) {
      setToast(`Copy failed: ${e instanceof Error ? e.message : String(e)}`);
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
    if (desktop) {
      setUpdate({ state: 'checking' });
      void desktop.checkForUpdates().then((r) => {
        if (!r.ok) setUpdate({ state: 'error', message: r.reason ?? 'updates unavailable' });
      });
      return;
    }
    setWebUpdate(null);
    setUpdate({ state: 'checking' });
    void checkForUpdate(appVersion ?? '0.0.0').then((r) => {
      if (!r) {
        setUpdate({ state: 'error', message: 'could not reach the release server' });
        return;
      }
      setWebUpdate(r);
      setUpdate(r.hasUpdate ? { state: 'available', version: r.latest, notes: r.notes } : { state: 'not-available' });
      if (r.hasUpdate) setToast(`Update ${r.latest} available — see Settings → App updates`);
    });
  }, [desktop, appVersion]);

  // Web/mobile: quietly check once per session so the user is told what changed
  // when a newer release is published. Never blocks or breaks startup.
  useEffect(() => {
    if (desktop || !appVersion) return;
    const t = setTimeout(() => {
      void checkForUpdate(appVersion).then((r) => {
        if (r?.hasUpdate) {
          setWebUpdate(r);
          setUpdate({ state: 'available', version: r.latest, notes: r.notes });
          setToast(`Update ${r.latest} available — see Settings → App updates`);
        }
      });
    }, 6000);
    return () => clearTimeout(t);
  }, [desktop, appVersion]);

  const handleDeleteRecords = useCallback(
    (scope: DeleteScope, mode: DeleteMode, date?: string): number => {
      if (!repo) return 0;
      const n = repo.deleteRecords(scope, mode, date);
      refresh();
      setToast(n > 0 ? `Deleted ${n} record${n === 1 ? '' : 's'}` : 'Nothing to delete');
      return n;
    },
    [repo, refresh],
  );

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

  const searchFoods = useCallback((q: string, limit?: number, filters?: FoodFilters) => repo?.searchFoods(q, limit, filters) ?? [], [repo, refReady]);
  const countFoods = useCallback((q: string, filters?: FoodFilters) => repo?.countFoods(q, filters) ?? 0, [repo, refReady]);
  const searchExercises = useCallback((q: string, limit?: number, filters?: ExerciseFilters) => repo?.searchExercises(q, limit, filters) ?? [], [repo]);
  const countExercises = useCallback((q: string, filters?: ExerciseFilters) => repo?.countExercises(q, filters) ?? 0, [repo]);
  const getFood = useCallback((id: string) => repo?.getFood(id) ?? null, [repo, refReady]);
  const getExercise = useCallback((id: string) => repo?.getExercise(id) ?? null, [repo]);
  const getLastSet = useCallback((id: string): LastSetHint | null => repo?.getLastSetForExercise(id) ?? null, [repo]);
  const getFoodFacets = useCallback(
    (q: string) => repo?.getFoodFacets(q) ?? { foodTypes: [], entryTypes: [], prepStates: [] },
    [repo, refReady],
  );
  const getExerciseFacets = useCallback(
    (q: string) => repo?.getExerciseFacets(q) ?? { categories: [], equipment: [], muscles: [] },
    [repo],
  );

  function go(next: Section) {
    setSection(next);
    setPalette(null);
    setDietPickMeal(null);
  }

  function openFoodPalette(meal?: string) {
    setDietPickMeal(null);
    setPendingMeal(meal);
    setPalettePurpose('log');
    setPalette('food');
  }

  function openExercisePalette() {
    setDietPickMeal(null);
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

  // Foods picked while building a diet plan are appended to the open meal
  // (default 100 g, adjusted inline); otherwise fall through to the log dialog.
  function pickFood(food: FoodSummary) {
    if (!repo) return;
    if (dietPickMeal) {
      const meal = dietPlan?.meals.find((m) => m.id === dietPickMeal);
      const items = meal ? meal.items.map((i) => ({ foodId: i.foodId, grams: i.grams })) : [];
      items.push({ foodId: food.id, grams: 100 });
      repo.setPlanItems(dietPickMeal, items);
      setDietPickMeal(null);
      setPalette(null);
      refresh();
      return;
    }
    openLog(food);
  }

  function closePalette() {
    setDietPickMeal(null);
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

  function deleteBodyMetric(id: string) {
    if (!repo) return;
    repo.deleteBodyMetric(id);
    refresh();
  }

  function saveAndApplyPlan(input: EnergyInputs) {
    if (!repo) return;
    const result = computeEnergyPlan(input);
    const plan: NutritionPlanInput = {
      id: activePlan?.id,
      ...input,
      fatPerKg: input.fatPerKg,
      bmrKcal: result.bmr,
      tdeeKcal: result.tdee,
      targetKcal: result.targetKcal,
      proteinG: result.proteinG,
      fatG: result.fatG,
      carbG: result.carbG,
    };
    const id = repo.saveNutritionPlan(plan);
    repo.applyNutritionPlan(id, date);
    setTargets(repo.getTargets());
    refresh();
    setToast('Nutrition plan applied to daily targets');
  }

  function applyPlan(id: string) {
    if (!repo) return;
    repo.applyNutritionPlan(id, date);
    setTargets(repo.getTargets());
    refresh();
    setToast('Plan applied to daily targets');
  }

  /** Observed maintenance from the last ~4 weeks of real intake + weight data. */
  function computeCalibration(): CalibrationInfo | null {
    if (!repo) return null;
    const end = date;
    const from = addDaysISO(end, -27);
    const days = repo.getNutritionDailySince(from).filter((d) => d.localDate <= end);
    const logged = days.filter((d) => (d.totalsMilli.get('energy_kcal') ?? 0) > 0);
    if (logged.length < 14) return null;
    const avgIntakeKcal = logged.reduce((a, d) => a + (d.totalsMilli.get('energy_kcal') ?? 0) / 1000, 0) / logged.length;

    const weights = bodyMetrics
      .filter((m) => m.metricType === 'weight_kg' && m.localDate >= from && m.localDate <= end)
      .sort((a, b) => a.localDate.localeCompare(b.localDate));
    if (weights.length < 2) return null;
    const first = weights[0];
    const last = weights[weights.length - 1];
    const spanDays = Math.round((new Date(`${last.localDate}T12:00:00`).getTime() - new Date(`${first.localDate}T12:00:00`).getTime()) / 86_400_000);
    if (spanDays < 14) return null;
    const cal = calibrateMaintenance(avgIntakeKcal, last.value - first.value, spanDays);
    if (!cal) return null;
    return { ...cal, spanDays, loggedDays: logged.length, weightEntries: weights.length };
  }

  /** Recompute the active plan using an observed maintenance value. */
  function recalibratePlan(observedMaintenanceKcal: number) {
    if (!repo || !activePlan) return;
    const inputs: EnergyInputs = {
      sex: activePlan.sex,
      age: activePlan.age,
      heightCm: activePlan.heightCm,
      weightKg: activePlan.weightKg,
      activity: activePlan.activity,
      goal: activePlan.goal,
      rateKgPerWeek: activePlan.rateKgPerWeek,
      proteinPerKg: activePlan.proteinPerKg,
      fatPerKg: activePlan.fatPerKg ?? 0.6,
      fatPercent: activePlan.fatPercent,
    };
    const result = computeEnergyPlan(inputs, { maintenanceKcal: observedMaintenanceKcal });
    const id = repo.saveNutritionPlan({
      id: activePlan.id,
      ...inputs,
      bmrKcal: result.bmr,
      tdeeKcal: result.tdee,
      targetKcal: result.targetKcal,
      proteinG: result.proteinG,
      fatG: result.fatG,
      carbG: result.carbG,
      notes: `Calibrated from observed maintenance ${observedMaintenanceKcal} kcal`,
    });
    repo.applyNutritionPlan(id, date);
    setTargets(repo.getTargets());
    refresh();
    setToast('Plan recalibrated from your logged data');
  }

  function deleteNutritionPlan(id: string) {
    if (!repo) return;
    repo.deleteNutritionPlan(id);
    refresh();
    setToast('Plan deleted');
  }

  function createDietPlan(name: string, mode: DietPlanMode) {
    if (!repo) return;
    const id = repo.createPlan({ name, mode });
    repo.setActivePlan(id);
    refresh();
    setToast('Diet plan created');
  }

  function selectDietPlan(id: string) {
    if (!repo) return;
    repo.setActivePlan(id);
    refresh();
  }

  function deleteDietPlan(id: string) {
    if (!repo) return;
    if (!window.confirm('Delete this diet plan? Logged foods are kept.')) return;
    repo.deletePlan(id);
    refresh();
    setToast('Diet plan deleted');
  }

  function addDietMeal() {
    if (!repo || !dietPlan) return;
    const nextOrder = dietPlan.meals.reduce((m, meal) => Math.max(m, meal.sortOrder), 0) + 1;
    repo.upsertPlanMeal({ planId: dietPlan.id, mealType: 'breakfast', dayOfWeek: null, sortOrder: nextOrder });
    refresh();
  }

  function updateDietMeal(id: string, patch: { mealType?: string; dayOfWeek?: number | null; sortOrder?: number }) {
    if (!repo || !dietPlan) return;
    const meal = dietPlan.meals.find((m) => m.id === id);
    if (!meal) return;
    repo.upsertPlanMeal({
      id,
      planId: dietPlan.id,
      mealType: patch.mealType ?? meal.mealType,
      dayOfWeek: patch.dayOfWeek !== undefined ? patch.dayOfWeek : meal.dayOfWeek,
      sortOrder: patch.sortOrder ?? meal.sortOrder,
    });
    refresh();
  }

  function deleteDietMeal(id: string) {
    if (!repo) return;
    repo.deletePlanMeal(id);
    refresh();
    setToast('Meal removed');
  }

  function setDietItems(mealId: string, items: { foodId: string; grams: number }[]) {
    if (!repo) return;
    repo.setPlanItems(mealId, items);
    refresh();
  }

  function toggleDietCheck(mealId: string) {
    if (!repo) return;
    repo.toggleMealCheck(mealId, date);
    refresh();
  }

  function addDietFood(mealId: string) {
    setDietPickMeal(mealId);
    setPalettePurpose('log');
    setPalette('food');
  }

  function setDietPlanMode(mode: DietPlanMode) {
    if (!repo || !dietPlan) return;
    repo.setPlanMode(dietPlan.id, mode);
    refresh();
  }

  function setDietProteinItems(mealId: string, items: { sourceId: string; grams: number }[]) {
    if (!repo) return;
    repo.setPlanProteinItems(mealId, items);
    refresh();
  }

  /** Create a custom protein source and return it so callers can select it. */
  function addProteinSource(input: ProteinSourceInput): ProteinSource | null {
    if (!repo) return null;
    const id = repo.addCustomProteinSource(input);
    refresh();
    return { id, ...input, isCustom: true };
  }

  function saveMicroTarget(key: string, value: number) {
    if (!repo) return;
    repo.saveMicroTarget(key, value);
    refresh();
  }

  function resetMicroTarget(key: string) {
    if (!repo) return;
    repo.resetMicroTarget(key);
    refresh();
  }

  function resetAllMicroTargets() {
    if (!repo) return;
    repo.resetAllMicroTargets();
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
        dietCount={dietPlan?.meals.length ?? 0}
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

          {section === 'diet' && (
            <DietSection
              date={date}
              setDate={setDate}
              plans={dietPlans}
              plan={dietPlan}
              checks={dietChecks}
              items={dayItems}
              getFood={getFood}
              onCreatePlan={createDietPlan}
              onSelectPlan={selectDietPlan}
              onDeletePlan={deleteDietPlan}
              onAddMeal={addDietMeal}
              onUpdateMeal={updateDietMeal}
              onDeleteMeal={deleteDietMeal}
              onSetItems={setDietItems}
              onAddFood={addDietFood}
              onToggleCheck={toggleDietCheck}
              onSetMode={setDietPlanMode}
              onSetProteinItems={setDietProteinItems}
              onAddSource={addProteinSource}
              sources={proteinSources}
              targets={targets}
              micros={microTargets}
              onSaveMicroTarget={saveMicroTarget}
              onResetMicroTarget={resetMicroTarget}
              onResetAllMicroTargets={resetAllMicroTargets}
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

          {section === 'body' && (
            <BodySection
              metrics={bodyMetrics}
              units={units}
              date={date}
              onAdd={addBodyMetric}
              onDelete={deleteBodyMetric}
            />
          )}

          {section === 'stats' && (
            <StatsSection
              repo={repo}
              units={units}
              date={date}
              targets={targets}
              bodyMetrics={bodyMetrics}
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
              plans={nutritionPlans}
              activePlan={activePlan}
              latestWeightKg={latestWeightKg}
              calibration={computeCalibration()}
              onSaveAndApplyPlan={saveAndApplyPlan}
              onApplyPlan={applyPlan}
              onRecalibrate={recalibratePlan}
              onDeletePlan={deleteNutritionPlan}
              onExportBackup={handleExportBackup}
              onSaveBackupToFolder={handleSaveBackupToFolder}
              isMobile={isNativeMobile()}
              onImportBackup={handleImportBackup}
              onImportBackupRequest={handleImportBackupRequest}
              onCopyAiPrompt={handleCopyAiPrompt}
              stats={recordStats}
              onCountDelete={(scope, mode, date) => repo.countRecords(scope, mode, date)}
              onDeleteRecords={handleDeleteRecords}
              isDesktop={!!desktop}
              appVersion={appVersion}
              update={update}
              webUpdate={webUpdate}
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
            aria-selected={section === 'diet'}
            className={section === 'diet' ? 'active' : ''}
            onClick={() => go('diet')}
          >
            <Icon name="diet" />
            Diet
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
            aria-selected={section === 'body'}
            className={section === 'body' ? 'active' : ''}
            onClick={() => go('body')}
          >
            <Icon name="activity" />
            Body
          </button>
          <button
            role="tab"
            aria-selected={section === 'stats'}
            className={section === 'stats' ? 'active' : ''}
            onClick={() => go('stats')}
          >
            <Icon name="stats" />
            Stats
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
          refLoading={!refReady}
          onToggleFavorite={toggleFavorite}
          onAddBodyMetric={addBodyMetric}
          onPickFood={pickFood}
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
// ── Diet plan ───────────────────────────────────────────────
const EGG_GRAMS = 50;

function isEggSource(source: ProteinSource | undefined): boolean {
  return !!source && /egg/i.test(source.name);
}

function scaleSourceMacros(source: ProteinSource, grams: number) {
  const f = grams / 100;
  return {
    kcal: source.kcal100g * f,
    protein: source.protein100g * f,
    carbs: source.carbs100g * f,
    fat: source.fat100g * f,
  };
}

function ProteinSourcePicker({
  sources,
  onPick,
  onAddSource,
  onClose,
}: {
  sources: ProteinSource[];
  onPick: (source: ProteinSource) => void;
  onAddSource: (input: ProteinSourceInput) => ProteinSource | null;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [custom, setCustom] = useState(false);
  const [name, setName] = useState('');
  const [kcal, setKcal] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');

  const query = q.trim().toLowerCase();
  const filtered = sources.filter((s) => s.name.toLowerCase().includes(query));

  function submitCustom() {
    const n = name.trim();
    if (!n) return;
    const created = onAddSource({
      name: n,
      kcal100g: Number(kcal) || 0,
      protein100g: Number(protein) || 0,
      carbs100g: Number(carbs) || 0,
      fat100g: Number(fat) || 0,
    });
    if (created) onPick(created);
  }

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input autoFocus value={q} placeholder="Search protein sources…" onChange={(e) => setQ(e.target.value)} />
        <div className="results">
          {custom ? (
            <div className="metrics-form">
              <label className="field">
                <span className="muted small">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Seitan" />
              </label>
              <div className="builder-targets">
                <label>
                  <span className="muted small">kcal /100g</span>
                  <input type="number" value={kcal} onChange={(e) => setKcal(e.target.value)} />
                </label>
                <label>
                  <span className="muted small">Protein /100g</span>
                  <input type="number" value={protein} onChange={(e) => setProtein(e.target.value)} />
                </label>
                <label>
                  <span className="muted small">Carbs /100g</span>
                  <input type="number" value={carbs} onChange={(e) => setCarbs(e.target.value)} />
                </label>
                <label>
                  <span className="muted small">Fat /100g</span>
                  <input type="number" value={fat} onChange={(e) => setFat(e.target.value)} />
                </label>
              </div>
              <div className="nav" style={{ justifyContent: 'flex-end' }}>
                <button className="ghost small" onClick={() => setCustom(false)}>
                  Back
                </button>
                <button className="primary small" onClick={submitCustom} disabled={!name.trim()}>
                  <Icon name="plus" /> Add &amp; select
                </button>
              </div>
            </div>
          ) : (
            <>
              <button className="result" onClick={() => setCustom(true)}>
                <span className="icon-tile soft">
                  <Icon name="plus" />
                </span>
                <span className="grow ellipsis">Custom source…</span>
              </button>
              {filtered.map((s) => (
                <button key={s.id} className="result" onClick={() => onPick(s)}>
                  <span className="icon-tile soft">
                    <Icon name="diet" />
                  </span>
                  <span className="grow ellipsis">{s.name}</span>
                  <span className="mono small muted">
                    {Math.round(s.kcal100g)} kcal · P{Math.round(s.protein100g)} · C{Math.round(s.carbs100g)} · F
                    {Math.round(s.fat100g)} /100g
                  </span>
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="muted small" style={{ padding: '12px 16px' }}>
                  No matching sources.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MicroTargetsPanel({
  targets,
  onSave,
  onReset,
  onResetAll,
}: {
  targets: MicroTarget[];
  onSave: (key: string, value: number) => void;
  onReset: (key: string) => void;
  onResetAll: () => void;
}) {
  const editedCount = targets.filter((t) => t.userValue !== null).length;

  function confirmResetAll() {
    if (editedCount === 0) return;
    const ok = window.confirm(
      `Reset all ${editedCount} edited micronutrient target${editedCount === 1 ? '' : 's'} to their defaults?`,
    );
    if (ok) onResetAll();
  }

  return (
    <div className="dash">
      <section className="card col-span-3">
        <div className="card-head">
          <h3>Micronutrient targets</h3>
          <button className="ghost small danger" onClick={confirmResetAll} disabled={editedCount === 0}>
            <Icon name="trash" /> Reset all
          </button>
        </div>
        {targets.length === 0 && <p className="muted small">No micronutrient targets found.</p>}
        {targets.map((t) => (
          <MicroTargetRow key={t.key} target={t} onSave={onSave} onReset={onReset} />
        ))}
        <p className="muted small" style={{ marginTop: 12 }}>
          These are daily reference targets only. Values you edit are saved as your personal goals; no intake is tracked here.
        </p>
      </section>
    </div>
  );
}

function MicroTargetRow({
  target,
  onSave,
  onReset,
}: {
  target: MicroTarget;
  onSave: (key: string, value: number) => void;
  onReset: (key: string) => void;
}) {
  const effective = target.userValue ?? target.defaultValue;
  const [text, setText] = useState(String(effective));
  useEffect(() => setText(String(effective)), [effective]);

  const edited = target.userValue !== null;
  const parsed = Number(text);
  const valid = text.trim() !== '' && Number.isFinite(parsed) && parsed >= 0;
  const dirty = valid && parsed !== effective;

  function save() {
    if (valid) onSave(target.key, parsed);
  }

  return (
    <div className="micro-row">
      <span className="micro-label">
        {target.label}
        {edited && <span className="tag">edited</span>}
      </span>
      <span className="gram-wrap">
        <input
          className="grams-input"
          type="number"
          min={0}
          step="any"
          value={text}
          aria-invalid={!valid}
          aria-label={`${target.label} target in ${target.unit}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
        />
        <span className="muted small micro-unit">{target.unit}</span>
      </span>
      <span className="micro-actions">
        <button className="primary small" disabled={!valid || !dirty} onClick={save}>
          Save
        </button>
        <button className="ghost small" disabled={!edited} onClick={() => onReset(target.key)}>
          Reset to default
        </button>
      </span>
    </div>
  );
}

function DietSection(props: {
  date: string;
  setDate: (d: string) => void;
  plans: DietPlan[];
  plan: DietPlanDetail | null;
  checks: DietPlanCheck[];
  items: DayItemRow[];
  getFood: (id: string) => FoodDetail | null;
  onCreatePlan: (name: string, mode: DietPlanMode) => void;
  onSelectPlan: (id: string) => void;
  onDeletePlan: (id: string) => void;
  onAddMeal: () => void;
  onUpdateMeal: (id: string, patch: { mealType?: string; dayOfWeek?: number | null; sortOrder?: number }) => void;
  onDeleteMeal: (id: string) => void;
  onSetItems: (mealId: string, items: { foodId: string; grams: number }[]) => void;
  onAddFood: (mealId: string) => void;
  onToggleCheck: (mealId: string) => void;
  onSetMode: (mode: DietPlanMode) => void;
  onSetProteinItems: (mealId: string, items: { sourceId: string; grams: number }[]) => void;
  onAddSource: (input: ProteinSourceInput) => ProteinSource | null;
  sources: ProteinSource[];
  targets: Map<string, number>;
  micros: MicroTarget[];
  onSaveMicroTarget: (key: string, value: number) => void;
  onResetMicroTarget: (key: string) => void;
  onResetAllMicroTargets: () => void;
}) {
  const [newName, setNewName] = useState('');
  const [newMode, setNewMode] = useState<DietPlanMode>('whole');
  const [pickForMeal, setPickForMeal] = useState<string | null>(null);
  const [view, setView] = useState<'plan' | 'micros'>('plan');

  const meals = props.plan?.meals ?? [];
  const mode: DietPlanMode = props.plan?.mode ?? 'whole';
  const isToday = props.date === toISODate(new Date());
  const dow = new Date(`${props.date}T12:00:00`).getDay();
  const applicable = meals.filter((m) => m.dayOfWeek === null || m.dayOfWeek === dow);
  const checkedSet = new Set(props.checks.map((c) => c.planMealId));
  const completed = applicable.filter((m) => checkedSet.has(m.id)).length;
  const progressPct = applicable.length > 0 ? (completed / applicable.length) * 100 : 0;
  const sourceById = useMemo(() => new Map(props.sources.map((s) => [s.id, s])), [props.sources]);

  const logged = useMemo(() => rowsToTotals(props.items), [props.items]);
  const loggedKcal = logged.get('energy_kcal')?.sumMilli ?? 0;
  const loggedProtein = logged.get('protein_g')?.sumMilli ?? 0;

  const sortedMeals = useMemo(
    () =>
      [...meals].sort((a, b) => {
        const ad = a.dayOfWeek === null ? -1 : a.dayOfWeek;
        const bd = b.dayOfWeek === null ? -1 : b.dayOfWeek;
        if (ad !== bd) return ad - bd;
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.mealType.localeCompare(b.mealType);
      }),
    [meals],
  );

  function create() {
    const name = newName.trim();
    if (!name) return;
    props.onCreatePlan(name, newMode);
    setNewName('');
  }

  function updateItem(meal: DietPlanMeal, index: number, grams: number) {
    props.onSetItems(
      meal.id,
      meal.items.map((it, i) => ({ foodId: it.foodId, grams: i === index ? grams : it.grams })),
    );
  }

  function removeItem(meal: DietPlanMeal, index: number) {
    props.onSetItems(
      meal.id,
      meal.items.filter((_, i) => i !== index).map((it) => ({ foodId: it.foodId, grams: it.grams })),
    );
  }

  function proteinTotalsFor(meal: DietPlanMeal) {
    return meal.proteinItems.reduce(
      (acc, it) => {
        const s = sourceById.get(it.proteinSourceId);
        if (!s) return acc;
        const m = scaleSourceMacros(s, it.grams);
        return { kcal: acc.kcal + m.kcal, protein: acc.protein + m.protein, carbs: acc.carbs + m.carbs, fat: acc.fat + m.fat };
      },
      { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    );
  }

  function updateProteinItem(meal: DietPlanMeal, index: number, grams: number) {
    props.onSetProteinItems(
      meal.id,
      meal.proteinItems.map((it, i) => ({ sourceId: it.proteinSourceId, grams: i === index ? grams : it.grams })),
    );
  }

  function removeProteinItem(meal: DietPlanMeal, index: number) {
    props.onSetProteinItems(
      meal.id,
      meal.proteinItems.filter((_, i) => i !== index).map((it) => ({ sourceId: it.proteinSourceId, grams: it.grams })),
    );
  }

  function addProteinSource(meal: DietPlanMeal, source: ProteinSource) {
    const grams = isEggSource(source) ? EGG_GRAMS : 100;
    props.onSetProteinItems(meal.id, [
      ...meal.proteinItems.map((it) => ({ sourceId: it.proteinSourceId, grams: it.grams })),
      { sourceId: source.id, grams },
    ]);
    setPickForMeal(null);
  }

  const plannedProtein = applicable.reduce(
    (acc, meal) => {
      const t = proteinTotalsFor(meal);
      return { kcal: acc.kcal + t.kcal, protein: acc.protein + t.protein, carbs: acc.carbs + t.carbs, fat: acc.fat + t.fat };
    },
    { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  );

  function macroRow(label: string, unit: string, targetMilli: number | undefined, provided: number) {
    const target = targetMilli == null ? null : targetMilli / 1000;
    const rem = target == null ? null : target - provided;
    const met = rem != null && rem <= 0;
    const pct = target ? Math.min(100, (provided / target) * 100) : 0;
    return (
      <div className="bar-item" key={label}>
        <div className="row small">
          <span>{label}</span>
          <span className="mono">
            {target == null ? 'no target' : met ? 'target met' : `${Math.round(rem ?? 0)} ${unit} left`}
          </span>
        </div>
        {target != null && (
          <div className="pill-bar">
            <span style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
    );
  }

  const targetProteinG = props.targets.get('protein_g') != null ? props.targets.get('protein_g')! / 1000 : null;
  const proteinMet = targetProteinG != null && plannedProtein.protein >= targetProteinG;
  const proteinPct = targetProteinG ? Math.min(100, (plannedProtein.protein / targetProteinG) * 100) : 0;

  return (
    <>
      <PageHead
        title="Diet Plan"
        subtitle={
          props.plan
            ? `${props.plan.name} · ${props.plan.mode === 'protein' ? 'protein focus' : 'whole diet'}`
            : 'No plan yet — create one below'
        }
      >
        <div className="segments" role="tablist" aria-label="Diet view">
          <button
            className={`segment ${view === 'plan' ? 'active' : ''}`}
            aria-selected={view === 'plan'}
            onClick={() => setView('plan')}
          >
            Plan
          </button>
          <button
            className={`segment ${view === 'micros' ? 'active' : ''}`}
            aria-selected={view === 'micros'}
            onClick={() => setView('micros')}
          >
            Micronutrients
          </button>
        </div>
        {view === 'plan' && (
          <>
        <div className="segments mode-switch" role="tablist" aria-label="Diet mode">
          <button
            className={`segment ${mode === 'whole' ? 'active' : ''}`}
            aria-selected={mode === 'whole'}
            disabled={!props.plan}
            onClick={() => props.onSetMode('whole')}
          >
            Whole diet
          </button>
          <button
            className={`segment ${mode === 'protein' ? 'active' : ''}`}
            aria-selected={mode === 'protein'}
            disabled={!props.plan}
            onClick={() => props.onSetMode('protein')}
          >
            Protein focus
          </button>
        </div>
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
          </>
        )}
      </PageHead>

      {view === 'micros' ? (
        <MicroTargetsPanel
          targets={props.micros}
          onSave={props.onSaveMicroTarget}
          onReset={props.onResetMicroTarget}
          onResetAll={props.onResetAllMicroTargets}
        />
      ) : (
        <>
      <div className="dash">
        <section className="card col-span-2">
          <div className="card-head">
            <h3>Diet plan</h3>
            {props.plan && (
              <span className="tag">
                {props.plan.meals.length} meal{props.plan.meals.length === 1 ? '' : 's'}
              </span>
            )}
          </div>

          {props.plans.length > 0 && (
            <div className="row">
              <label className="field grow">
                <span className="muted small">Active plan</span>
                <select value={props.plan?.id ?? ''} onChange={(e) => props.onSelectPlan(e.target.value)}>
                  {props.plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.mode === 'protein' ? 'protein' : 'whole'}
                    </option>
                  ))}
                </select>
              </label>
              {props.plan && (
                <button className="ghost small danger" onClick={() => props.onDeletePlan(props.plan!.id)}>
                  <Icon name="trash" /> Delete plan
                </button>
              )}
            </div>
          )}

          <div className="row" style={{ marginTop: 14 }}>
            <label className="field grow">
              <span className="muted small">{props.plans.length > 0 ? 'New plan name' : 'Plan name'}</span>
              <input
                value={newName}
                placeholder="e.g. Lean bulk"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create();
                }}
              />
            </label>
            <label className="field">
              <span className="muted small">Mode</span>
              <select value={newMode} onChange={(e) => setNewMode(e.target.value as DietPlanMode)}>
                {DIET_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary small" onClick={create} disabled={!newName.trim()}>
              <Icon name="plus" /> Create
            </button>
          </div>
          <p className="muted small" style={{ marginTop: 12 }}>
            A whole-diet plan lists fixed foods with a daily checklist; a protein-focus plan tracks protein sources against
            your remaining macros. Switch modes any time without losing the other setup.
          </p>
        </section>

        {mode === 'whole' && (
          <section className="card">
            <div className="card-head">
              <h3>{isToday ? "Today's progress" : 'Progress'}</h3>
              <span className="muted small">
                {completed}/{applicable.length} meals
              </span>
            </div>
            <div className="pill-bar">
              <span style={{ width: `${progressPct}%` }} />
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              {applicable.length === 0
                ? 'Add meals to the plan to start checking them off.'
                : `${Math.round(progressPct)}% of ${DOW_LABELS[dow]}'s meals logged from the plan.`}
            </p>
            <div className="bar-list" style={{ marginTop: 14 }}>
              <div className="bar-item">
                <div className="row small">
                  <span>Logged {isToday ? 'today' : 'on this day'}</span>
                  <span className="mono">{formatNutrient(loggedKcal, 'kcal')} kcal</span>
                </div>
              </div>
              <div className="bar-item">
                <div className="row small">
                  <span>Protein</span>
                  <span className="mono">{formatNutrient(loggedProtein, 'g')} g</span>
                </div>
              </div>
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              Ticking a meal logs its foods to {isToday ? 'today' : props.date} and updates these totals; unticking removes them.
              Checks are per-day and start empty each morning.
            </p>
          </section>
        )}

        {mode === 'protein' && (
          <section className="card">
            <div className="card-head">
              <h3>Remaining macros</h3>
              <span className="muted small">daily target − planned</span>
            </div>
            <div className="bar-list" style={{ marginTop: 6 }}>
              {macroRow('Calories', 'kcal', props.targets.get('energy_kcal'), plannedProtein.kcal)}
              {macroRow('Carbs', 'g', props.targets.get('carb_g'), plannedProtein.carbs)}
              {macroRow('Fat', 'g', props.targets.get('fat_g'), plannedProtein.fat)}
              <div className="bar-item">
                <div className="row small">
                  <span>Protein</span>
                  <span className="mono">
                    {Math.round(plannedProtein.protein)}
                    {targetProteinG != null ? ` / ${Math.round(targetProteinG)}` : ' / —'} g
                  </span>
                </div>
                <div className="pill-bar">
                  <span style={{ width: `${proteinPct}%` }} />
                </div>
              </div>
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              {props.targets.size === 0
                ? 'Set daily targets in Nutrition to see what is left to hit.'
                : proteinMet
                  ? 'Protein target met by these sources.'
                  : 'Totals are the protein sources scheduled for this day; eggs count as 50 g each.'}
            </p>
          </section>
        )}
      </div>

      {mode === 'whole' && (
      <div className="dash">
        <section className="card col-span-3">
          <div className="card-head">
            <h3>{isToday ? "Today's checklist" : `Checklist · ${props.date}`}</h3>
            <span className="muted small">{DOW_LABELS[dow]}</span>
          </div>
          {!props.plan && <p className="muted small">Create a plan to see its checklist.</p>}
          {props.plan && applicable.length === 0 && (
            <p className="muted small">No meals scheduled for {DOW_LABELS[dow]}. Add meals in the builder below.</p>
          )}
          {applicable.map((meal) => {
            const checked = checkedSet.has(meal.id);
            const tot = plannedMealTotals(meal, props.getFood);
            return (
              <div className="meal" key={meal.id}>
                <div className="meal-head row">
                  <strong className="meal-name">
                    <input
                      type="checkbox"
                      className="meal-check"
                      checked={checked}
                      onChange={() => props.onToggleCheck(meal.id)}
                      aria-label={`Toggle ${cap(meal.mealType)}`}
                    />
                    <span className="meal-index">{cap(meal.mealType)}</span>
                    {meal.dayOfWeek !== null && <span className="tag">{DOW_LABELS[meal.dayOfWeek]}</span>}
                    {checked ? (
                      <span className="status-chip done">logged</span>
                    ) : (
                      <span className="status-chip miss">pending</span>
                    )}
                  </strong>
                  <span className="muted small mono">
                    {formatNutrient(tot.kcal, 'kcal')} kcal · P{formatNutrient(tot.protein, 'g')} · C{formatNutrient(tot.carb, 'g')} · F
                    {formatNutrient(tot.fat, 'g')}
                    {tot.missing ? ' · partial' : ''}
                  </span>
                </div>
                {meal.items.length === 0 && <p className="muted small">No foods yet.</p>}
                {meal.items.map((it, index) => {
                  const food = props.getFood(it.foodId);
                  return (
                    <div className="item" key={`${it.foodId}-${index}`}>
                      <span>{food?.name ?? it.foodId}</span>
                      <span className="mono small muted">{Math.round(it.grams)} g</span>
                      <span />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </section>
      </div>
      )}

      <div className="dash">
        <section className="card col-span-3">
          <div className="card-head">
            <h3>{mode === 'protein' ? 'Build the protein rotation' : 'Build the plan'}</h3>
            <button className="primary small" onClick={props.onAddMeal} disabled={!props.plan}>
              <Icon name="plus" /> Add meal
            </button>
          </div>
          {!props.plan && <p className="muted small">Create a plan to start building it.</p>}
          {props.plan && sortedMeals.length === 0 && <p className="muted small">No meals yet — add one above.</p>}
          {sortedMeals.map((meal) => {
            const tot = mode === 'protein' ? proteinTotalsFor(meal) : plannedMealTotals(meal, props.getFood);
            const typeOptions = MEAL_TYPE_OPTIONS.includes(meal.mealType.toLowerCase())
              ? MEAL_TYPE_OPTIONS
              : [meal.mealType, ...MEAL_TYPE_OPTIONS];
            return (
              <div className="builder-row" key={meal.id}>
                <div className="builder-row-head">
                  <span>{cap(meal.mealType)}</span>
                  <div className="nav">
                    <span className="muted small mono">
                      {formatNutrient(tot.kcal, 'kcal')} kcal · P{formatNutrient(tot.protein, 'g')}
                    </span>
                    <button className="ghost small danger" onClick={() => props.onDeleteMeal(meal.id)} title="Remove meal">
                      <Icon name="trash" />
                    </button>
                  </div>
                </div>

                <div className="builder-targets">
                  <label>
                    <span className="muted small">Type</span>
                    <select value={meal.mealType} onChange={(e) => props.onUpdateMeal(meal.id, { mealType: e.target.value })}>
                      {typeOptions.map((t) => (
                        <option key={t} value={t}>
                          {cap(t)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="muted small">Day</span>
                    <select
                      value={meal.dayOfWeek === null ? 'daily' : String(meal.dayOfWeek)}
                      onChange={(e) =>
                        props.onUpdateMeal(meal.id, {
                          dayOfWeek: e.target.value === 'daily' ? null : Number(e.target.value),
                        })
                      }
                    >
                      <option value="daily">Every day</option>
                      {DOW_LABELS.map((d, i) => (
                        <option key={d} value={String(i)}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="muted small">{mode === 'protein' ? 'Sources' : 'Foods'}</span>
                    {mode === 'protein' ? (
                      <button className="ghost small" onClick={() => setPickForMeal(meal.id)}>
                        <Icon name="plus" /> Add source
                      </button>
                    ) : (
                      <button className="ghost small" onClick={() => props.onAddFood(meal.id)}>
                        <Icon name="plus" /> Add food
                      </button>
                    )}
                  </label>
                </div>

                {mode === 'whole' ? (
                  <div style={{ marginTop: 8 }}>
                    {meal.items.length === 0 && <p className="muted small">No foods — add some.</p>}
                    {meal.items.map((it, index) => {
                      const food = props.getFood(it.foodId);
                      return (
                        <div className="item" key={`${it.foodId}-${index}`}>
                          <span>{food?.name ?? it.foodId}</span>
                          <span className="gram-wrap">
                            <GramsInput value={it.grams} onCommit={(g) => updateItem(meal, index, g)} />
                            <span className="muted small">g</span>
                          </span>
                          <button className="ghost small danger" onClick={() => removeItem(meal, index)} title="Remove food">
                            <Icon name="trash" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ marginTop: 8 }}>
                    {meal.proteinItems.length === 0 && <p className="muted small">No sources — add some.</p>}
                    {meal.proteinItems.map((it, index) => {
                      const s = sourceById.get(it.proteinSourceId);
                      const egg = isEggSource(s);
                      return (
                        <div className="item" key={`${it.proteinSourceId}-${index}`}>
                          <span>
                            {s?.name ?? it.proteinSourceId}
                            {s && <span className="muted small"> · {Math.round(s.kcal100g)} kcal/100g</span>}
                          </span>
                          <span className="gram-wrap">
                            <GramsInput
                              value={egg ? it.grams / EGG_GRAMS : it.grams}
                              step={egg ? 1 : 5}
                              onCommit={(v) => updateProteinItem(meal, index, egg ? v * EGG_GRAMS : v)}
                            />
                            <span className="muted small">{egg ? 'pcs' : 'g'}</span>
                          </span>
                          <button className="ghost small danger" onClick={() => removeProteinItem(meal, index)} title="Remove source">
                            <Icon name="trash" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {props.plan && props.plan.meals.length > 0 && (
            <p className="muted small" style={{ marginTop: 12 }}>
              {mode === 'protein'
                ? 'Sources are stored as grams (eggs as 50 g pieces). Switch to Whole diet to log exact foods.'
                : 'Weights are grams of the food as stored. Ticking a meal in the checklist logs these exact amounts to that day.'}
            </p>
          )}
        </section>
      </div>
        </>
      )}

      {pickForMeal && (
        <ProteinSourcePicker
          sources={props.sources}
          onPick={(s) => {
            const meal = meals.find((m) => m.id === pickForMeal);
            if (meal) addProteinSource(meal, s);
            else setPickForMeal(null);
          }}
          onAddSource={props.onAddSource}
          onClose={() => setPickForMeal(null)}
        />
      )}
    </>
  );
}

type IconName =
  | 'bolt'
  | 'nutrition'
  | 'diet'
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
  | 'activity'
  | 'stats'
  | 'info'
  | 'copy'
  | 'close';

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
    case 'diet':
      body = (
        <>
          <rect x="5" y="4" width="14" height="17" rx="2" />
          <path d="M9 3h6v3H9z" />
          <path d="m8.5 11.5 1.5 1.5 3-3" />
          <path d="M8.5 17h7" />
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
    case 'stats':
      body = (
        <>
          <path d="M3 20h18" />
          <rect x="5" y="11" width="3" height="7" rx="0.6" />
          <rect x="10.5" y="5" width="3" height="13" rx="0.6" />
          <rect x="16" y="9" width="3" height="9" rx="0.6" />
        </>
      );
      break;
    case 'info':
      body = (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5" />
          <path d="M12 7.6h.01" />
        </>
      );
      break;
    case 'copy':
      body = (
        <>
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
        </>
      );
      break;
    case 'close':
      body = <path d="M6 6l12 12M18 6 6 18" />;
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
  dietCount,
}: {
  section: Section;
  onNavigate: (s: Section) => void;
  nutritionCount: number;
  trainingCount: number;
  dietCount: number;
}) {
  return (
    <aside className="sidebar">
      <div className="brand side-brand">
        <span className="logo-mark">
          <span className="logo-mark-word">H+</span>
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
          className={`nav-item ${section === 'diet' ? 'active' : ''}`}
          aria-current={section === 'diet' ? 'page' : undefined}
          onClick={() => onNavigate('diet')}
        >
          <Icon name="diet" className="nav-icon" /> Diet Plan
          {dietCount > 0 && <span className="nav-badge">{dietCount}</span>}
        </button>
        <button
          className={`nav-item ${section === 'training' ? 'active' : ''}`}
          aria-current={section === 'training' ? 'page' : undefined}
          onClick={() => onNavigate('training')}
        >
          <Icon name="training" className="nav-icon" /> Training
          {trainingCount > 0 && <span className="nav-badge">{trainingCount}</span>}
        </button>
        <button
          className={`nav-item ${section === 'body' ? 'active' : ''}`}
          aria-current={section === 'body' ? 'page' : undefined}
          onClick={() => onNavigate('body')}
        >
          <Icon name="activity" className="nav-icon" /> Body
        </button>
        <button
          className={`nav-item ${section === 'stats' ? 'active' : ''}`}
          aria-current={section === 'stats' ? 'page' : undefined}
          onClick={() => onNavigate('stats')}
        >
          <Icon name="stats" className="nav-icon" /> Stats
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
        <path d={path} fill="none" stroke="var(--track)" strokeWidth="16" strokeLinecap="round" />
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

  // Every tracked nutrient except the four headline macros, grouped for display.
  // A nutrient appears once it has any recorded value (known or unknown) or a
  // target; empty groups are hidden so the card stays useful, not noisy.
  const detailGroups = useMemo(() => {
    const byGroup = new Map<NutrientGroup, NutrientDef[]>();
    for (const d of props.defById.values()) {
      if (SUMMARY_NUTRIENTS.includes(d.id)) continue;
      const g = nutrientGroup(d.id);
      const arr = byGroup.get(g);
      if (arr) arr.push(d);
      else byGroup.set(g, [d]);
    }
    for (const arr of byGroup.values()) arr.sort((a, b) => a.displayOrder - b.displayOrder);
    return NUTRIENT_GROUP_ORDER.map((g) => ({
      group: g,
      label: NUTRIENT_GROUP_LABEL[g],
      defs: (byGroup.get(g) ?? []).filter((d) => props.totals.has(d.id) || props.targets.has(d.id)),
    })).filter((grp) => grp.defs.length > 0);
  }, [props.defById, props.totals, props.targets]);

  const detailPartial = detailGroups.some((grp) => grp.defs.some((d) => props.totals.get(d.id)?.hasUnknown));

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

      {detailGroups.length > 0 && (
        <div className="dash">
          <section className="card col-span-2">
            <div className="card-head">
              <h3>Micronutrients</h3>
              {detailPartial && <span className="tag partial">partial data</span>}
            </div>
            {detailGroups.map((grp) => (
              <div className="nutrient-group" key={grp.group}>
                <div className="nutrient-group-label">{grp.label}</div>
                <div className="bar-list">
                  {grp.defs.map((d) => {
                    const t = props.totals.get(d.id);
                    const target = props.targets.get(d.id);
                    const unknownOnly = !!t && t.hasUnknown && t.sumMilli === 0;
                    const p = t && target ? Math.min(100, (t.sumMilli / target) * 100) : 0;
                    return (
                      <div className="bar-item" key={d.id}>
                        <div className="row small">
                          <span>
                            {d.name}
                            {t?.hasUnknown && !unknownOnly ? <span className="muted"> · partial</span> : null}
                          </span>
                          <span className="mono">
                            {unknownOnly ? '\u2014' : formatNutrient(t?.sumMilli ?? null, d.unit)} /{' '}
                            {target ? formatNutrient(target, d.unit) : '\u2014'} {d.unit}
                          </span>
                        </div>
                        {target ? (
                          <div className="pill-bar">
                            <span style={{ width: `${p}%` }} />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            <p className="muted small" style={{ marginTop: 12 }}>
              Values come from the foods you log. USDA reference foods carry the full set; set daily targets in Settings to
              see progress. A dot marks nutrients where some foods didn't report a value — unknowns are never counted as zero.
            </p>
          </section>
        </div>
      )}

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

// ── Stats ───────────────────────────────────────────────────
type StatTab = 'nutrition' | 'training' | 'body';

function StatsSection(props: {
  repo: SqliteRepository;
  units: 'kg' | 'lb';
  date: string;
  targets: Map<string, number>;
  bodyMetrics: BodyMetric[];
}) {
  const [tab, setTab] = useState<StatTab>('nutrition');
  const [range, setRange] = useState(14);
  const [weeks, setWeeks] = useState(8);
  const [exerciseId, setExerciseId] = useState('');
  const [bodyType, setBodyType] = useState<BodyMetricType>('weight_kg');

  const [nutritionDays, setNutritionDays] = useState<NutritionDayTotals[]>([]);
  const [trainingSets, setTrainingSets] = useState<TrainingSetRow[]>([]);
  const [loggedExercises, setLoggedExercises] = useState<LoggedExercise[]>([]);

  useEffect(() => {
    setNutritionDays(props.repo.getNutritionDailySince(addDaysISO(props.date, -(range - 1))));
  }, [props.repo, props.date, range]);

  useEffect(() => {
    setTrainingSets(props.repo.getTrainingSets());
    const ex = props.repo.listLoggedExercises();
    setLoggedExercises(ex);
    setExerciseId((cur) => cur || ex[0]?.id || '');
  }, [props.repo]);

  // ── nutrition ──
  const totalByDate = new Map(nutritionDays.map((d) => [d.localDate, d.totalsMilli]));
  const perDay = (date: string, id: string) => (totalByDate.get(date)?.get(id) ?? 0) / 1000;
  const kcalRows = nutritionDays.map((d) => ({ date: d.localDate, value: (d.totalsMilli.get('energy_kcal') ?? 0) / 1000 }));
  const kcalSeries = dailySeries(addDaysISO(props.date, -(range - 1)), props.date, kcalRows);
  const kcalBars = kcalSeries.map((d) => ({ label: shortLabel(d.date), value: Math.round(d.value) }));
  const targetKcal = (props.targets.get('energy_kcal') ?? 0) / 1000;
  const loggedDays = kcalSeries.filter((d) => d.value > 0);
  const avgKcal = mean(loggedDays.map((d) => d.value));
  const avgP = mean(loggedDays.map((d) => perDay(d.date, 'protein_g')));
  const avgF = mean(loggedDays.map((d) => perDay(d.date, 'fat_g')));
  const avgC = mean(loggedDays.map((d) => perDay(d.date, 'carb_g')));
  const split = macroEnergySplit(avgP, avgF, avgC);

  // ── training ──
  const working = trainingSets.filter((s) => s.completed && s.setType === 'working');
  const volRows = working
    .filter((s) => s.loadG != null && s.reps != null)
    .map((s) => ({ date: s.localDate, value: (s.loadG as number) * (s.reps as number) }));
  const weekStarts = recentWeekStarts(weeks, props.date);
  const volByWeek = sumByWeek(volRows, weekStarts);
  const setsByWeek = sumByWeek(working.map((s) => ({ date: s.localDate, value: 1 })), weekStarts);
  const toDispLoad = (g: number) => (props.units === 'lb' ? gToLb(g) : gToKg(g));
  const volBars = weekStarts.map((w, i) => ({ label: shortLabel(w), value: Math.round(toDispLoad(volByWeek[i])) }));
  const setBars = weekStarts.map((w, i) => ({ label: shortLabel(w), value: Math.round(setsByWeek[i]) }));

  const exSets = working.filter(
    (s) => s.exerciseId === exerciseId && s.loadG != null && s.reps != null && (s.loadG as number) > 0 && (s.reps as number) > 0,
  );
  const e1rmByDate = new Map<string, number>();
  for (const s of exSets) {
    const e = e1rmG(s.loadG as number, s.reps as number);
    e1rmByDate.set(s.localDate, Math.max(e1rmByDate.get(s.localDate) ?? 0, e));
  }
  const e1rmPoints = [...e1rmByDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, g]) => ({ label: shortLabel(date), value: Math.round(toDispLoad(g) * 10) / 10 }));
  const exName = loggedExercises.find((e) => e.id === exerciseId)?.name ?? '';

  // ── body ──
  const bodyEntries = props.bodyMetrics
    .filter((m) => m.metricType === bodyType)
    .slice()
    .sort((a, b) => a.localDate.localeCompare(b.localDate));
  const bodyToDisp = (v: number) => (isWeightMetric(bodyType) && props.units === 'lb' ? kgToLb(v) : v);
  const bodyPoints = bodyEntries.map((m) => ({ label: shortLabel(m.localDate), value: Math.round(bodyToDisp(m.value) * 10) / 10 }));
  const bodyUnit = isWeightMetric(bodyType) ? props.units : bodyMetricUnit(bodyType);
  const bodyTypesWithData = BODY_METRIC_TYPES.filter(([id]) => props.bodyMetrics.some((m) => m.metricType === id));

  return (
    <>
      <PageHead title="Stats" subtitle="Nutrition, training and body trends" />

      <div className="subtabs" role="tablist" aria-label="Stat category">
        {(['nutrition', 'training', 'body'] as StatTab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`segment ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'nutrition' && (
        <div className="grid" style={{ marginTop: 16 }}>
          <div className="card stat-tile">
            <Ring
              value={avgKcal}
              max={targetKcal}
              label={
                <>
                  {Math.round(avgKcal)}
                  <small> kcal</small>
                </>
              }
              sub={`avg · target ${Math.round(targetKcal)}`}
            />
            <div className="stat-col">
              <div className="stat-line">
                <span className="muted small">Days logged</span>
                <span className="mono">{loggedDays.length} / {range}</span>
              </div>
              <div className="stat-line">
                <span className="muted small">Avg protein</span>
                <span className="mono">{Math.round(avgP)} g</span>
              </div>
              <div className="stat-line">
                <span className="muted small">Avg fat</span>
                <span className="mono">{Math.round(avgF)} g</span>
              </div>
              <div className="stat-line">
                <span className="muted small">Avg carbs</span>
                <span className="mono">{Math.round(avgC)} g</span>
              </div>
            </div>
          </div>

          <div className="card col-span-2">
            <div className="card-head">
              <h3>Calories per day</h3>
              <div className="segments">
                {[14, 30, 90].map((r) => (
                  <button key={r} className={`segment ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>
                    {r}d
                  </button>
                ))}
              </div>
            </div>
            <BarChart data={kcalBars} target={targetKcal} unit="kcal" />
          </div>

          <div className="card col-span-2">
            <h3>Average macro energy split</h3>
            <StackedBar
              segments={[
                { label: 'Protein', value: split.protein, color: 'var(--green-600)' },
                { label: 'Carbs', value: split.carb, color: '#4f8ff7' },
                { label: 'Fat', value: split.fat, color: 'var(--amber)' },
              ]}
            />
          </div>
        </div>
      )}

      {tab === 'training' && (
        <div className="grid" style={{ marginTop: 16 }}>
          <div className="card col-span-2">
            <div className="card-head">
              <h3>Weekly training volume ({props.units})</h3>
              <div className="segments">
                {[8, 12, 26].map((w) => (
                  <button key={w} className={`segment ${weeks === w ? 'active' : ''}`} onClick={() => setWeeks(w)}>
                    {w}w
                  </button>
                ))}
              </div>
            </div>
            <BarChart data={volBars} unit={props.units} />
          </div>

          <div className="card col-span-2">
            <h3>Working sets per week</h3>
            <BarChart data={setBars} unit="sets" color="var(--amber)" />
          </div>

          <div className="card col-span-2">
            <div className="card-head">
              <h3>Estimated 1RM{exName ? ` · ${exName}` : ''}</h3>
              {loggedExercises.length > 0 && (
                <select value={exerciseId} onChange={(e) => setExerciseId(e.target.value)}>
                  {loggedExercises.map((ex) => (
                    <option key={ex.id} value={ex.id}>
                      {ex.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {loggedExercises.length === 0 ? (
              <p className="muted small">Log some working sets to see strength trends.</p>
            ) : (
              <LineChart data={e1rmPoints} unit={props.units} />
            )}
          </div>
        </div>
      )}

      {tab === 'body' && (
        <div className="grid" style={{ marginTop: 16 }}>
          <div className="card col-span-2">
            <div className="card-head">
              <h3>Body trend</h3>
              {(bodyTypesWithData.length > 0 ? bodyTypesWithData : BODY_METRIC_TYPES).length > 0 && (
                <select value={bodyType} onChange={(e) => setBodyType(e.target.value as BodyMetricType)}>
                  {(bodyTypesWithData.length > 0 ? bodyTypesWithData : BODY_METRIC_TYPES).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {bodyPoints.length === 0 ? (
              <p className="muted small">No measurements logged for this metric yet.</p>
            ) : (
              <LineChart data={bodyPoints} unit={bodyUnit} />
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ── Body measurements ───────────────────────────────────────
function BodySection(props: {
  metrics: BodyMetric[];
  units: 'kg' | 'lb';
  date: string;
  onAdd: (input: { metricType: BodyMetricType; value: number; localDate: string; note?: string }) => void;
  onDelete: (id: string) => void;
}) {
  const [metricType, setMetricType] = useState<BodyMetricType>('weight_kg');
  const [value, setValue] = useState('');
  const [logDate, setLogDate] = useState(props.date);
  const [note, setNote] = useState('');
  const valueOk = Number.isFinite(Number(value)) && Number(value) > 0;

  useEffect(() => setLogDate(props.date), [props.date]);

  const toDisplay = (type: BodyMetricType, v: number) =>
    isWeightMetric(type) && props.units === 'lb' ? kgToLb(v) : v;
  const unitFor = (type: BodyMetricType) => (isWeightMetric(type) ? props.units : bodyMetricUnit(type));

  const byType = new Map<BodyMetricType, BodyMetric[]>();
  for (const m of props.metrics) {
    const arr = byType.get(m.metricType);
    if (arr) arr.push(m);
    else byType.set(m.metricType, [m]);
  }

  function submit() {
    if (!valueOk) return;
    const raw = Number(value);
    const stored = isWeightMetric(metricType) && props.units === 'lb' ? lbToKg(raw) : raw;
    props.onAdd({ metricType, value: roundTo(stored, 2), localDate: logDate, note: note.trim() || undefined });
    setValue('');
    setNote('');
  }

  const activeTypes = BODY_METRIC_TYPES.filter(([id]) => (byType.get(id)?.length ?? 0) > 0);

  return (
    <>
      <PageHead title="Body" subtitle="Weight and measurements over time" />

      <div className="grid" style={{ marginTop: 16 }}>
        <div className="card">
          <h3>Log a measurement</h3>
          <div className="plan-form" style={{ gridTemplateColumns: '1fr' }}>
            <label className="plan-field">
              <span>Metric</span>
              <select value={metricType} onChange={(e) => setMetricType(e.target.value as BodyMetricType)}>
                {BODY_METRIC_TYPES.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="plan-field">
              <span>
                Value ({isWeightMetric(metricType) ? props.units : bodyMetricUnit(metricType) || 'value'})
              </span>
              <input value={value} inputMode="decimal" placeholder="e.g. 82.5" onChange={(e) => setValue(e.target.value)} />
            </label>
            <label className="plan-field">
              <span>Date</span>
              <input type="date" value={logDate} onChange={(e) => setLogDate(e.target.value)} />
            </label>
            <label className="plan-field">
              <span>Note</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
            </label>
          </div>
          <div className="nav" style={{ marginTop: 12 }}>
            <button className="primary" disabled={!valueOk} onClick={submit}>
              Log measurement
            </button>
          </div>
        </div>

        {activeTypes.length === 0 && (
          <div className="card">
            <h3>No measurements yet</h3>
            <p className="muted small">Log your weight, body fat or tape measurements to track them here.</p>
          </div>
        )}

        {activeTypes.map(([id]) => {
          const entries = byType.get(id) ?? [];
          const latest = entries[0];
          const prev = entries[1];
          const delta = prev ? latest.value - prev.value : null;
          const unit = unitFor(id);
          return (
            <div className={`card ${id === 'weight_kg' ? 'featured' : ''}`} key={id}>
              <div className="card-head">
                <h3>{BODY_METRIC_LABEL(id)}</h3>
                <span className="muted small">
                  {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
                </span>
              </div>
              <div className="metric-latest">
                <span className="metric-value">
                  {roundTo(toDisplay(id, latest.value), 1)}
                  {unit && <small> {unit}</small>}
                </span>
                {delta != null && Math.abs(delta) > 1e-9 && (
                  <span className={`metric-delta ${delta > 0 ? 'up' : 'down'}`}>
                    {delta > 0 ? '▲' : '▼'} {roundTo(Math.abs(toDisplay(id, latest.value) - toDisplay(id, prev.value)), 1)} {unit}
                  </span>
                )}
                <span className="muted small">{latest.localDate}</span>
              </div>
              <div className="metric-list">
                {entries.slice(0, 6).map((e) => (
                  <div className="metric-entry" key={e.id}>
                    <span className="mono">{roundTo(toDisplay(id, e.value), 1)}{unit && ` ${unit}`}</span>
                    <span className="muted small grow ellipsis">
                      {e.localDate}
                      {e.note ? ` · ${e.note}` : ''}
                    </span>
                    <button className="ghost small danger" onClick={() => props.onDelete(e.id)} title="Delete entry">
                      <Icon name="trash" />
                    </button>
                  </div>
                ))}
                {entries.length > 6 && <div className="muted small">+{entries.length - 6} older</div>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function BODY_METRIC_LABEL(type: BodyMetricType): string {
  const found = BODY_METRIC_TYPES.find(([id]) => id === type);
  if (!found) return type;
  return found[1].replace(/\s*\(.*\)$/, '');
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
const DELETE_SCOPES: { id: DeleteScope; label: string }[] = [
  { id: 'nutrition', label: 'Nutrition' },
  { id: 'training', label: 'Training' },
  { id: 'body', label: 'Body metrics' },
];

const DELETE_MODES: { id: DeleteMode; label: string; needsDate: boolean }[] = [
  { id: 'all', label: 'Erase all', needsDate: false },
  { id: 'before', label: 'Before…', needsDate: true },
  { id: 'on', label: 'On…', needsDate: true },
  { id: 'last', label: 'Last', needsDate: false },
];

function deleteScopeName(scope: DeleteScope): string {
  if (scope === 'nutrition') return 'nutrition log';
  if (scope === 'training') return 'training entries';
  return 'body metrics';
}

function deleteActionLabel(scope: DeleteScope, mode: DeleteMode, date: string, count: number): string {
  switch (mode) {
    case 'all':
      return `all ${deleteScopeName(scope)} (${count})`;
    case 'last':
      return `the most recent ${deleteScopeName(scope)}`;
    case 'before':
      return `${count} records dated before ${date}`;
    case 'on':
      return `${count} records dated ${date}`;
  }
}

function scopeRangeLabel(stat: ScopeStats): string {
  if (stat.count === 0) return 'No entries yet';
  return `${stat.count} entr${stat.count === 1 ? 'y' : 'ies'} · ${stat.firstDate} → ${stat.lastDate}`;
}

// ── Nutrition planner ───────────────────────────────────────
function roundTo(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function NutritionPlanner(props: {
  units: 'kg' | 'lb';
  plans: NutritionPlan[];
  activePlan: NutritionPlan | null;
  latestWeightKg: number | null;
  calibration: CalibrationInfo | null;
  onSaveAndApply: (input: EnergyInputs) => void;
  onApply: (id: string) => void;
  onRecalibrate: (observedMaintenanceKcal: number) => void;
  onDelete: (id: string) => void;
}) {
  const a = props.activePlan;
  const toDisplayWeight = (kg: number) => roundTo(props.units === 'lb' ? kgToLb(kg) : kg, 1);

  const [sex, setSex] = useState<Sex>(a?.sex ?? 'male');
  const [age, setAge] = useState<string>(a ? String(a.age) : '30');
  const [heightCm, setHeightCm] = useState<string>(a ? String(a.heightCm) : '');
  const [weight, setWeight] = useState<string>(
    a ? String(toDisplayWeight(a.weightKg)) : props.latestWeightKg != null ? String(toDisplayWeight(props.latestWeightKg)) : '',
  );
  const [activity, setActivity] = useState<ActivityLevel>(a?.activity ?? 'moderate');
  const [goal, setGoal] = useState<Goal>(a?.goal ?? 'maintain');
  const [rate, setRate] = useState<string>(a ? String(a.rateKgPerWeek) : '0.5');
  const [proteinPerKg, setProteinPerKg] = useState<string>(a ? String(a.proteinPerKg) : '1.8');
  const [fatPerKg, setFatPerKg] = useState<string>(a?.fatPerKg != null ? String(a.fatPerKg) : '0.6');
  const [fatPercent, setFatPercent] = useState<string>(a ? String(Math.round(a.fatPercent * 100)) : '25');

  const weightKg = weight ? (props.units === 'lb' ? lbToKg(Number(weight)) : Number(weight)) : 0;
  const inputs: EnergyInputs = {
    sex,
    age: Number(age) || 0,
    heightCm: Number(heightCm) || 0,
    weightKg,
    activity,
    goal,
    rateKgPerWeek: Number(rate) || 0,
    proteinPerKg: Number(proteinPerKg) || 0,
    fatPerKg: Number(fatPerKg) || 0,
    fatPercent: (Number(fatPercent) || 0) / 100,
  };
  const valid = inputs.weightKg > 0 && inputs.heightCm > 0 && inputs.age > 0;
  const result = computeEnergyPlan(inputs);
  const unit = props.units;

  return (
    <>
      <div className="card-head">
        <h3>Nutrition plan</h3>
        <span className="muted small">Estimates only — apply to your daily targets when you're happy with them</span>
      </div>

      <div className="plan-form">
        <label className="plan-field">
          <span>Sex</span>
          <select value={sex} onChange={(e) => setSex(e.target.value as Sex)}>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </select>
        </label>
        <label className="plan-field">
          <span>Age</span>
          <input type="number" min={1} value={age} onChange={(e) => setAge(e.target.value)} />
        </label>
        <label className="plan-field">
          <span>Height (cm)</span>
          <input type="number" min={0} value={heightCm} onChange={(e) => setHeightCm(e.target.value)} placeholder="e.g. 180" />
        </label>
        <label className="plan-field">
          <span>Weight ({unit})</span>
          <input type="number" min={0} value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 80" />
        </label>
        <label className="plan-field plan-field-wide">
          <span>Activity</span>
          <select value={activity} onChange={(e) => setActivity(e.target.value as ActivityLevel)}>
            {ACTIVITY_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="plan-field">
          <span>Goal</span>
          <select value={goal} onChange={(e) => setGoal(e.target.value as Goal)}>
            {GOAL_OPTIONS.map((g) => (
              <option key={g} value={g}>
                {GOAL_LABELS[g]}
              </option>
            ))}
          </select>
        </label>
        <label className="plan-field">
          <span>{goal === 'gain' ? 'Surplus' : 'Deficit'} rate (kg/week)</span>
          <input
            type="number"
            min={0}
            step="0.05"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            disabled={goal === 'maintain' || goal === 'recomp'}
          />
        </label>
        <label className="plan-field">
          <span>Protein (g/kg)</span>
          <input type="number" min={0} step="0.1" value={proteinPerKg} onChange={(e) => setProteinPerKg(e.target.value)} />
        </label>
        <label className="plan-field">
          <span>Fat (% of kcal)</span>
          <input type="number" min={0} step="1" value={fatPercent} onChange={(e) => setFatPercent(e.target.value)} />
        </label>
        <label className="plan-field">
          <span>Fat floor (g/kg)</span>
          <input type="number" min={0} step="0.1" value={fatPerKg} onChange={(e) => setFatPerKg(e.target.value)} />
        </label>
      </div>

      {valid ? (
        <div className="plan-preview">
          <div className="plan-stat">
            <span className="plan-stat-label">BMR</span>
            <span className="plan-stat-value">{result.bmr.toLocaleString()} <small>kcal</small></span>
          </div>
          <div className="plan-stat">
            <span className="plan-stat-label">Maintenance</span>
            <span className="plan-stat-value">{result.tdee.toLocaleString()} <small>kcal</small></span>
          </div>
          <div className="plan-stat featured">
            <span className="plan-stat-label">Target</span>
            <span className="plan-stat-value">{result.targetKcal.toLocaleString()} <small>kcal</small></span>
          </div>
          <div className="plan-stat">
            <span className="plan-stat-label">Protein</span>
            <span className="plan-stat-value">{result.proteinG} <small>g</small></span>
          </div>
          <div className="plan-stat">
            <span className="plan-stat-label">Fat</span>
            <span className="plan-stat-value">{result.fatG} <small>g</small></span>
          </div>
          <div className="plan-stat">
            <span className="plan-stat-label">Carbs</span>
            <span className="plan-stat-value">{result.carbG} <small>g</small></span>
          </div>
        </div>
      ) : (
        <p className="muted small">Enter sex, age, height and weight to see your energy estimate.</p>
      )}

      {valid && result.warnings.length > 0 && (
        <ul className="plan-warnings">
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <div className="nav" style={{ marginTop: 12 }}>
        <button className="primary" disabled={!valid} onClick={() => props.onSaveAndApply(inputs)}>
          Apply to daily targets
        </button>
      </div>

      {props.plans.length > 0 && (
        <div className="plan-saved">
          <div className="plan-saved-label">Saved plans</div>
          {props.plans.map((p) => (
            <div className="plan-saved-row" key={p.id}>
              <span className="grow ellipsis">
                {GOAL_LABELS[p.goal]} · {p.targetKcal.toLocaleString()} kcal · {roundTo(toDisplayWeight(p.weightKg), 1)} {unit}
                {p.isActive && <span className="tag"> active</span>}
              </span>
              {!p.isActive && (
                <button className="ghost small" onClick={() => props.onApply(p.id)}>
                  Activate
                </button>
              )}
              <button className="ghost small danger" onClick={() => props.onDelete(p.id)} title="Delete plan">
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </div>
      )}

      <CalibrationBlock
        calibration={props.calibration}
        activePlan={props.activePlan}
        onRecalibrate={props.onRecalibrate}
      />
    </>
  );
}

function CalibrationBlock(props: {
  calibration: CalibrationInfo | null;
  activePlan: NutritionPlan | null;
  onRecalibrate: (observedMaintenanceKcal: number) => void;
}) {
  const cal = props.calibration;
  return (
    <div className="calib">
      <div className="plan-saved-label">Maintenance calibration</div>
      {!props.activePlan ? (
        <p className="muted small">Apply a plan first, then log food and weight for a few weeks to calibrate it.</p>
      ) : !cal ? (
        <p className="muted small">
          Log at least 14 days of food and two weight entries spanning 2+ weeks in the last month to calibrate against real data.
        </p>
      ) : (
        <>
          <div className="calib-row">
            <span className="muted small">Observed maintenance</span>
            <span className="mono">{cal.observedMaintenanceKcal.toLocaleString()} kcal</span>
          </div>
          <div className="calib-row">
            <span className="muted small">Formula estimate</span>
            <span className="mono">{props.activePlan.tdeeKcal.toLocaleString()} kcal</span>
          </div>
          <div className="calib-row">
            <span className="muted small">Avg intake</span>
            <span className="mono">{cal.avgIntakeKcal.toLocaleString()} kcal</span>
          </div>
          <div className="calib-row">
            <span className="muted small">Weight change</span>
            <span className="mono">
              {cal.weightChangeKg >= 0 ? '+' : ''}
              {cal.weightChangeKg.toFixed(1)} kg / {cal.spanDays}d
            </span>
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>
            Based on {cal.loggedDays} logged days and {cal.weightEntries} weigh-ins. Recalibrating rebuilds your target
            calories and macros from this observed maintenance.
          </p>
          <div className="nav" style={{ marginTop: 10 }}>
            <button className="ghost" onClick={() => props.onRecalibrate(cal.observedMaintenanceKcal)}>
              Recalibrate targets
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Settings(props: {
  units: 'kg' | 'lb';
  onChangeUnits: (u: 'kg' | 'lb') => void;
  secondaryFactor: number;
  onChangeSecondary: (n: number) => void;
  targets: Map<string, number>;
  defById: Map<string, NutrientDef>;
  onChangeTarget: (id: string, value: number) => void;
  plans: NutritionPlan[];
  activePlan: NutritionPlan | null;
  latestWeightKg: number | null;
  calibration: CalibrationInfo | null;
  onSaveAndApplyPlan: (input: EnergyInputs) => void;
  onApplyPlan: (id: string) => void;
  onRecalibrate: (observedMaintenanceKcal: number) => void;
  onDeletePlan: (id: string) => void;
  onExportBackup: () => void;
  onSaveBackupToFolder: () => void;
  isMobile: boolean;
  onImportBackup: (file: File, mode: ImportMode) => void;
  onImportBackupRequest: (mode: ImportMode, fallback: () => void) => void;
  onCopyAiPrompt: () => void;
  stats: RecordStats;
  onCountDelete: (scope: DeleteScope, mode: DeleteMode, date?: string) => number;
  onDeleteRecords: (scope: DeleteScope, mode: DeleteMode, date?: string) => void;
  isDesktop: boolean;
  appVersion: string | null;
  update: UpdateStatus | null;
  webUpdate: UpdateCheck | null;
  onCheckUpdates: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMode, setImportMode] = useState<ImportMode>('merge');
  const [backupInfo, setBackupInfo] = useState(false);
  const [delScope, setDelScope] = useState<DeleteScope>('nutrition');
  const [delMode, setDelMode] = useState<DeleteMode>('before');
  const [delDate, setDelDate] = useState<string>(toISODate(new Date()));
  const [delConfirm, setDelConfirm] = useState(false);
  const [delCount, setDelCount] = useState(0);
  const delStat = props.stats[delScope];

  useEffect(() => {
    const c = props.onCountDelete(delScope, delMode, delDate);
    setDelCount(c);
  }, [props, delScope, delMode, delDate]);

  const webAvailable = !props.isDesktop && !!props.webUpdate?.hasUpdate;
  const platform = Capacitor.getPlatform();
  const isAndroid = platform === 'android';
  const isNativeMobile = !props.isDesktop && (platform === 'android' || platform === 'ios');
  const downloadUrl =
    !props.isDesktop && props.webUpdate
      ? isAndroid
        ? props.webUpdate.apkUrl || props.webUpdate.htmlUrl
        : isNativeMobile
          ? props.webUpdate.htmlUrl
          : props.webUpdate.installerUrl || props.webUpdate.htmlUrl
      : '';
  const downloadLabel = isAndroid
    ? 'Download APK'
    : !isNativeMobile && props.webUpdate?.installerUrl
      ? 'Download desktop app'
      : 'Release notes';
  const showDownload = !props.isDesktop && !!props.webUpdate?.hasUpdate && !!downloadUrl;
  const changelog =
    props.update && (props.update.state === 'available' || props.update.state === 'downloaded')
      ? props.update.notes ?? ''
      : props.webUpdate?.hasUpdate
        ? props.webUpdate.notes
        : '';
  const changelogVersion =
    props.update && (props.update.state === 'available' || props.update.state === 'downloaded')
      ? props.update.version
      : props.webUpdate?.latest ?? '';

  return (
    <>
      <PageHead title="Settings" subtitle="Preferences, daily targets and local backups" />
      <div className="grid" style={{ marginTop: 16 }}>
        <div className="card col-span-2">
          <NutritionPlanner
            units={props.units}
            plans={props.plans}
            activePlan={props.activePlan}
            latestWeightKg={props.latestWeightKg}
            calibration={props.calibration}
            onSaveAndApply={props.onSaveAndApplyPlan}
            onApply={props.onApplyPlan}
            onRecalibrate={props.onRecalibrate}
            onDelete={props.onDeletePlan}
          />
        </div>

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
          <div className="card-head" style={{ marginBottom: 8 }}>
            <h3>Backup &amp; restore</h3>
            <button className="ghost small" onClick={() => setBackupInfo(true)} title="About backup &amp; restore" aria-label="About backup and restore">
              <Icon name="info" />
            </button>
          </div>
          <p className="small muted">
            Your records live only on this device. Export a portable backup file regularly and keep it somewhere safe — if the app
            is uninstalled or the device is lost without a backup, the data cannot be recovered.
          </p>
          <div className="nav" style={{ marginTop: 10 }}>
            <button className="primary" onClick={props.onExportBackup}>
              Export backup
            </button>
            {props.isMobile && (
              <button className="ghost" onClick={props.onSaveBackupToFolder}>
                Save to folder…
              </button>
            )}
          </div>
          <div className="segments" role="tablist" aria-label="Import mode" style={{ margin: '14px 0 8px' }}>
            <button
              type="button"
              className={`segment ${importMode === 'merge' ? 'active' : ''}`}
              role="tab"
              aria-selected={importMode === 'merge'}
              onClick={() => setImportMode('merge')}
            >
              Merge
            </button>
            <button
              type="button"
              className={`segment ${importMode === 'replace' ? 'active' : ''}`}
              role="tab"
              aria-selected={importMode === 'replace'}
              onClick={() => setImportMode('replace')}
            >
              Replace everything
            </button>
          </div>
          <p className="small muted">
            {importMode === 'merge'
              ? 'Adds records from the file and skips ones you already have. Nothing is deleted.'
              : 'Replaces all current data with the file. A safety copy of the current database is saved first.'}
          </p>
          <div className="nav" style={{ marginTop: 10 }}>
            <button onClick={() => props.onImportBackupRequest(importMode, () => fileRef.current?.click())}>
              Import backup…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".sqlite,.db,.sql,application/vnd.sqlite3,application/sql,text/plain,application/octet-stream"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) props.onImportBackup(f, importMode);
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

        <div className="card">
          <h3>Delete records</h3>
          <p className="small muted">
            Permanently remove logged entries on this device. Deletion cannot be undone.
          </p>

          <div className="segments" role="tablist" aria-label="Record type" style={{ margin: '12px 0' }}>
            {DELETE_SCOPES.map((s) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={delScope === s.id}
                className={`segment ${delScope === s.id ? 'active' : ''}`}
                onClick={() => {
                  setDelScope(s.id);
                  setDelConfirm(false);
                }}
              >
                {s.label}
              </button>
            ))}
          </div>

          <p className="small muted" style={{ margin: '0 0 12px' }}>
            {scopeRangeLabel(delStat)}
          </p>

          <div className="nav" style={{ flexWrap: 'wrap', marginBottom: delMode === 'before' || delMode === 'on' ? 10 : 14 }}>
            {DELETE_MODES.map((m) => (
              <button
                key={m.id}
                className={delMode === m.id ? 'primary' : ''}
                onClick={() => {
                  setDelMode(m.id);
                  setDelConfirm(false);
                }}
              >
                {m.label}
              </button>
            ))}
          </div>

          {(delMode === 'before' || delMode === 'on') && (
            <div className="row" style={{ marginBottom: 14 }}>
              <span className="muted small">
                {delMode === 'before' ? 'Delete all entries before this date' : 'Delete entries on this date'}
              </span>
              <input
                type="date"
                value={delDate}
                onChange={(e) => {
                  setDelDate(e.target.value);
                  setDelConfirm(false);
                }}
              />
            </div>
          )}

          {delCount > 0 ? (
            delConfirm ? (
              <div className="row">
                <span className="muted small" style={{ flex: 1 }}>
                  Deletes {deleteActionLabel(delScope, delMode, delDate, delCount)}. This cannot be undone.
                </span>
                <button className="ghost" onClick={() => setDelConfirm(false)}>
                  Cancel
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    props.onDeleteRecords(delScope, delMode, delDate);
                    setDelConfirm(false);
                  }}
                >
                  Delete
                </button>
              </div>
            ) : (
              <button className="danger" onClick={() => setDelConfirm(true)}>
                Delete {delCount} record{delCount === 1 ? '' : 's'}
              </button>
            )
          ) : (
            <p className="muted small">Nothing to delete for the selected options.</p>
          )}
        </div>

        <div className="card">
          <h3>App updates</h3>
          <div className="row">
            <span className="muted small">Installed version</span>
            <span className="mono">{props.appVersion ?? 'unknown'}</span>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>
            {props.isDesktop
              ? 'Updates download automatically and install the next time you quit. You can also check now.'
              : isNativeMobile
                ? 'Check for a newer build, then download and install it to update. Your data is kept.'
                : 'Check for a newer published version. When one is available, reload to apply it.'}
          </p>
          <div className="nav" style={{ marginTop: 10 }}>
            <button
              onClick={props.onCheckUpdates}
              disabled={props.update?.state === 'checking' || props.update?.state === 'downloading'}
            >
              {props.update?.state === 'checking' ? 'Checking…' : 'Check for updates'}
            </button>
            {webAvailable && !isNativeMobile && (
              <button className="primary" onClick={() => window.location.reload()}>
                Reload to update
              </button>
            )}
            {showDownload && (
              <button
                className={isNativeMobile ? 'primary' : ''}
                onClick={() => window.open(downloadUrl, '_blank', 'noopener')}
              >
                {downloadLabel}
              </button>
            )}
          </div>
          {props.update && (
            <p className="small muted" style={{ marginTop: 8 }}>
              {describeUpdate(props.update, props.isDesktop)}
            </p>
          )}
          {changelog && (
            <div className="changelog">
              <div className="changelog-title">What’s changed in {changelogVersion}</div>
              <div className="changelog-body">{changelog}</div>
            </div>
          )}
        </div>
      </div>

      {backupInfo && <BackupInfoDialog onClose={() => setBackupInfo(false)} onCopyPrompt={props.onCopyAiPrompt} />}
    </>
  );
}

function BackupInfoDialog(props: { onClose: () => void; onCopyPrompt: () => void }) {
  return (
    <div className="palette-overlay" onMouseDown={props.onClose}>
      <div className="palette backup-info" onMouseDown={(e) => e.stopPropagation()}>
        <div className="backup-info-head">
          <strong>Backup &amp; restore</strong>
          <button className="ghost small" onClick={props.onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="results backup-info-body">
          <section>
            <h4>What you can export</h4>
            <p className="small muted">
              One portable <span className="mono">.sqlite</span> file with everything you’ve entered: foods, daily logs, diet
              plans, protein sources, micronutrient targets and your profile/settings. It’s a lossless snapshot you can keep
              anywhere.
            </p>
          </section>
          <section>
            <h4>What you can import</h4>
            <p className="small muted">
              Any <span className="mono">.sqlite</span> file that matches the app schema — one of your own exports, or one made
              elsewhere (including by an AI). The file is checked first: its schema version and structure must match, older
              versions are upgraded automatically, and files from a newer app version are refused.
            </p>
          </section>
          <section>
            <h4>How to get one</h4>
            <p className="small muted">
              Export from the app, or ask any AI assistant to build one. The button below copies a ready-to-paste prompt that
              already contains this app’s exact schema, its schema version and the insert format — just describe the meal plan
              you want at the end.
            </p>
          </section>
          <section>
            <h4>No binary file? Use SQL</h4>
            <p className="small muted">
              If the AI can only return text, ask for a <span className="mono">.sql</span> script instead. You can import{' '}
              <span className="mono">.sql</span> too — it runs against a throwaway database and then goes through the exact same
              validation as a binary backup.
            </p>
          </section>
          <section>
            <h4>Keep it safe</h4>
            <p className="small muted">
              <strong>Replace everything</strong> overwrites all current data (a safety copy is saved automatically first).{' '}
              <strong>Merge</strong> only adds records you don’t already have. Either way, keep your own backups — this device is
              the only copy.
            </p>
          </section>
          <div className="nav" style={{ justifyContent: 'flex-end', padding: '4px 16px 14px' }}>
            <button className="primary" onClick={props.onCopyPrompt}>
              <Icon name="copy" /> Copy AI prompt
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function describeUpdate(u: UpdateStatus, isDesktop: boolean): string {
  switch (u.state) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return isDesktop
        ? `Update ${u.version} found — downloading…`
        : `Update ${u.version} is available.`;
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
