import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadDatabase } from '../data/db';
import { loadRefDatabase } from '../data/refdb';
import {
  SqliteRepository,
  type DayItemRow,
  type ExerciseSummary,
  type FoodDetail,
  type FoodSummary,
  type NutrientDef,
  type WorkoutExerciseRow,
  type WorkoutRow,
} from '../data/repository';
import { formatNutrient, toMilli } from '../domain/nutrients';
import { LogItem, sumNutrients, snapshotLogItem } from '../domain/nutrition';
import { gToKg, gToLb, kgToG, lbToG, e1rmG } from '../domain/training';
import { CommandPalette } from './CommandPalette';

type Section = 'nutrition' | 'training' | 'settings';
type PaletteMode = 'food' | 'exercise';

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
const SUMMARY_NUTRIENTS = ['energy_kcal', 'protein_g', 'carb_g', 'fat_g'];

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

export function App() {
  const [repo, setRepo] = useState<SqliteRepository | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('nutrition');
  const [date, setDate] = useState<string>(toISODate(new Date()));

  const [nutrientDefs, setNutrientDefs] = useState<NutrientDef[]>([]);
  const [targets, setTargets] = useState<Map<string, number>>(new Map());
  const [units, setUnits] = useState<'kg' | 'lb'>('kg');
  const [secondaryFactor, setSecondaryFactor] = useState(0.5);
  const [muscleNames, setMuscleNames] = useState<Map<string, string>>(new Map());

  const [dayItems, setDayItems] = useState<DayItemRow[]>([]);
  const [recentFoods, setRecentFoods] = useState<FoodSummary[]>([]);
  const [activeWorkout, setActiveWorkout] = useState<WorkoutRow | null>(null);
  const [weeklyVolume, setWeeklyVolume] = useState<Map<string, number>>(new Map());

  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [logTarget, setLogTarget] = useState<FoodDetail | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = await loadDatabase();
        const ref = await loadRefDatabase();
        const r = new SqliteRepository(db, ref);
        if (cancelled) return;
        setRepo(r);
        setNutrientDefs(r.getNutrientDefs());
        setTargets(r.getTargets());
        setUnits(r.getPreference('units.mass', 'kg') === 'lb' ? 'lb' : 'kg');
        setSecondaryFactor(Number(r.getPreference('secondaryVolumeFactor', '0.5')));
        setMuscleNames(r.getMuscleNames());
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
    setActiveWorkout(repo.getActiveWorkout(date));
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

  // Context-aware Ctrl/Cmd-K: foods in Nutrition, exercises in Training.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        if (section !== 'nutrition' && section !== 'training') return;
        e.preventDefault();
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

  const searchFoods = useCallback((q: string) => repo?.searchFoods(q, 20) ?? [], [repo]);
  const searchExercises = useCallback((q: string) => repo?.searchExercises(q, 20) ?? [], [repo]);

  function go(next: Section) {
    setSection(next);
    setPalette(null);
  }

  function openLog(food: FoodSummary) {
    if (!repo) return;
    const detail = repo.getFood(food.id);
    if (detail) setLogTarget(detail);
    setPalette(null);
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
      <div className="topbar">
        <div className="brand">
          hypertroph<span>+</span>
        </div>
        <div className="nav">
          <button className={section === 'nutrition' ? 'active' : ''} onClick={() => go('nutrition')}>
            Nutrition
          </button>
          <button className={section === 'training' ? 'active' : ''} onClick={() => go('training')}>
            Training
          </button>
        </div>
        <div className="spacer" />
        {section === 'nutrition' && (
          <button className="primary" onClick={() => setPalette('food')}>
            Log food <span className="kbd">Ctrl K</span>
          </button>
        )}
        {section === 'training' && (
          <button className="primary" onClick={() => setPalette('exercise')}>
            Add exercise <span className="kbd">Ctrl K</span>
          </button>
        )}
        <button className={section === 'settings' ? 'active' : ''} onClick={() => go('settings')}>
          Settings
        </button>
      </div>

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
            onAddFood={() => setPalette('food')}
            onPickRecent={openLog}
            onDelete={(id) => {
              repo.deleteLogItem(id);
              refresh();
            }}
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
            onStart={startWorkout}
            onAddExercise={() => setPalette('exercise')}
            onAddSet={addSet}
            onFinish={finishWorkout}
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
          />
        )}
      </div>

      {palette && (
        <CommandPalette
          mode={palette}
          searchFoods={searchFoods}
          searchExercises={searchExercises}
          onPickFood={openLog}
          onPickExercise={openExerciseInWorkout}
          onClose={() => setPalette(null)}
        />
      )}

      {logTarget && (
        <LogDialog
          food={logTarget}
          defById={defById}
          units={units}
          onCancel={() => setLogTarget(null)}
          onLog={logFood}
        />
      )}

      {customOpen && <CustomFoodDialog onCancel={() => setCustomOpen(false)} onCreate={createCustomFood} />}

      {toast && <div className="toast">{toast}</div>}
    </div>
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
  onAddFood: () => void;
  onPickRecent: (f: FoodSummary) => void;
  onDelete: (id: string) => void;
  onCreateCustom: () => void;
}) {
  const kcal = props.totals.get('energy_kcal');
  const kcalTarget = props.targets.get('energy_kcal');
  const pct = kcal && kcalTarget ? Math.min(100, (kcal.sumMilli / kcalTarget) * 100) : 0;

  return (
    <>
      <div className="row">
        <h2>Nutrition · {props.date}</h2>
        <div className="nav">
          <button className="ghost" onClick={() => props.setDate(addDays(props.date, -1))}>
            ‹ prev
          </button>
          <button className="ghost" onClick={() => props.setDate(addDays(props.date, 1))}>
            next ›
          </button>
          <button className="primary" onClick={props.onAddFood}>
            + Log food
          </button>
        </div>
      </div>

      <div className="grid" style={{ marginTop: 12 }}>
        <div className="card" style={{ gridColumn: 'span 2' }}>
          {MEALS.map((meal) => {
            const items = props.items.filter((i) => i.mealSection === meal);
            const mealKcal = items.reduce((acc, it) => {
              const e = it.nutrients.find((n) => n.nutrientId === 'energy_kcal');
              return acc + (e?.amountMilli ?? 0);
            }, 0);
            return (
              <div className="meal" key={meal}>
                <div className="row">
                  <strong style={{ textTransform: 'capitalize' }}>{meal}</strong>
                  <span className="muted small">{formatNutrient(mealKcal, 'kcal')} kcal</span>
                </div>
                {items.map((it) => {
                  const e = it.nutrients.find((n) => n.nutrientId === 'energy_kcal');
                  const p = it.nutrients.find((n) => n.nutrientId === 'protein_g');
                  return (
                    <div className="item" key={it.id}>
                      <span>
                        {it.label} <span className="muted small">{it.quantityG ? `· ${it.portionLabel ?? `${Math.round(it.quantityG)} g`}` : ''}</span>
                      </span>
                      <span className="mono small">
                        {formatNutrient(e?.amountMilli ?? null, 'kcal')} kcal · P{formatNutrient(p?.amountMilli ?? null, 'g')}
                      </span>
                      <button className="ghost small" onClick={() => props.onDelete(it.id)} title="Delete">
                        ✕
                      </button>
                    </div>
                  );
                })}
                {items.length === 0 && <div className="muted small">No entries.</div>}
              </div>
            );
          })}
        </div>

        <div className="card">
          <h3>Daily targets</h3>
          <div className="row">
            <strong className="mono">
              {kcal ? formatNutrient(kcal.sumMilli, 'kcal') : '0'} / {kcalTarget ? formatNutrient(kcalTarget, 'kcal') : '—'} kcal
            </strong>
            {kcal?.hasUnknown && <span className="tag partial">partial data</span>}
          </div>
          <div className="bar">
            <div style={{ width: `${pct}%` }} />
          </div>
          {SUMMARY_NUTRIENTS.filter((n) => n !== 'energy_kcal').map((n) => {
            const t = props.totals.get(n);
            const target = props.targets.get(n);
            const def = props.defById.get(n);
            const p = t && target ? Math.min(100, (t.sumMilli / target) * 100) : 0;
            return (
              <div key={n}>
                <div className="row small">
                  <span className="muted">{def?.name ?? n}</span>
                  <span className="mono">
                    {t ? formatNutrient(t.sumMilli, def?.unit ?? 'g') : '0'} / {target ? formatNutrient(target, def?.unit ?? 'g') : '—'}
                  </span>
                </div>
                <div className={`bar ${n === 'protein_g' ? 'protein' : n === 'fat_g' ? 'fat' : ''}`}>
                  <div style={{ width: `${p}%` }} />
                </div>
              </div>
            );
          })}
        </div>

        <div className="card">
          <h3>Recent</h3>
          {props.recentFoods.map((f) => (
            <div key={f.id} className="row small">
              <button className="link" onClick={() => props.onPickRecent(f)}>
                {f.name}
              </button>
            </div>
          ))}
          {props.recentFoods.length === 0 && <p className="muted small">Nothing logged yet.</p>}
          <button className="ghost" style={{ marginTop: 12 }} onClick={props.onCreateCustom}>
            + Create custom food
          </button>
        </div>
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
  onStart: () => void;
  onAddExercise: () => void;
  onAddSet: (we: WorkoutExerciseRow, load: string, reps: string, rir: string, setType: 'working' | 'warmup') => void;
  onFinish: () => void;
}) {
  return (
    <>
      <div className="row">
        <h2>{props.activeWorkout ? props.activeWorkout.name : 'Training'}</h2>
        {props.activeWorkout && (
          <div className="nav">
            <button className="ghost" onClick={props.onAddExercise}>
              + Exercise
            </button>
            <button className="primary" onClick={props.onFinish}>
              Finish
            </button>
          </div>
        )}
      </div>

      {!props.activeWorkout ? (
        <div className="card" style={{ marginTop: 12 }}>
          <p className="muted">No active workout. Start one to log sets.</p>
          <div className="nav" style={{ marginTop: 8 }}>
            <button className="primary" onClick={props.onStart}>
              Start workout
            </button>
            <button className="ghost" onClick={props.onAddExercise}>
              + Exercise
            </button>
          </div>
        </div>
      ) : (
        <div className="grid" style={{ marginTop: 12 }}>
          {props.activeWorkout.exercises.map((we) => (
            <ExerciseCard key={we.id} we={we} units={props.units} onAddSet={props.onAddSet} />
          ))}
          {props.activeWorkout.exercises.length === 0 && (
            <div className="card">
              <p className="muted">Add an exercise to begin.</p>
            </div>
          )}
        </div>
      )}

      <Progress weeklyVolume={props.weeklyVolume} muscleNames={props.muscleNames} secondaryFactor={props.secondaryFactor} />
    </>
  );
}

function ExerciseCard({
  we,
  units,
  onAddSet,
}: {
  we: WorkoutExerciseRow;
  units: 'kg' | 'lb';
  onAddSet: (we: WorkoutExerciseRow, load: string, reps: string, rir: string, setType: 'working' | 'warmup') => void;
}) {
  const [load, setLoad] = useState('');
  const [reps, setReps] = useState('8');
  const [rir, setRir] = useState('2');

  return (
    <div className="card">
      <h3>{we.name}</h3>
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
        <button
          className="primary"
          onClick={() => {
            onAddSet(we, load, reps, rir, 'working');
            setLoad('');
          }}
        >
          +
        </button>
      </div>
      <button
        className="ghost small"
        onClick={() => {
          onAddSet(we, load, reps, rir, 'warmup');
          setLoad('');
        }}
      >
        + warm-up set
      </button>
    </div>
  );
}

// ── Progress ────────────────────────────────────────────────
function Progress(props: { weeklyVolume: Map<string, number>; muscleNames: Map<string, string>; secondaryFactor: number }) {
  const max = Math.max(1, ...props.weeklyVolume.values());
  const rows = [...props.weeklyVolume.entries()].sort((a, b) => b[1] - a[1]);
  return (
    <>
      <h2 style={{ marginTop: 20 }}>Weekly working-set volume</h2>
      <p className="muted small">Primary sets counted 1×; secondary counted {props.secondaryFactor}×. Warm-up sets excluded.</p>
      <div className="card" style={{ marginTop: 12 }}>
        {rows.length === 0 && <p className="muted">No working sets logged this week.</p>}
        {rows.map(([m, v]) => (
          <div key={m} style={{ marginBottom: 10 }}>
            <div className="row small">
              <span>{props.muscleNames.get(m) ?? m}</span>
              <span className="mono">{v.toFixed(1)} sets</span>
            </div>
            <div className="bar">
              <div style={{ width: `${(v / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
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
}) {
  return (
    <>
      <h2>Settings</h2>
      <div className="grid" style={{ marginTop: 12 }}>
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
          <h3>Data & privacy</h3>
          <p className="small muted">
            Local-only. No account, no telemetry. This base model persists to your browser's local storage; the desktop build uses an
            on-device SQLite file.
          </p>
        </div>
      </div>
    </>
  );
}

// ── Log dialog ──────────────────────────────────────────────
function LogDialog(props: {
  food: FoodDetail;
  defById: Map<string, NutrientDef>;
  units: 'kg' | 'lb';
  onCancel: () => void;
  onLog: (food: FoodDetail, quantityG: number, portionLabel: string, meal: string) => void;
}) {
  const defaultPortion = props.food.portions.find((p) => p.isDefault) ?? props.food.portions[0];
  const [meal, setMeal] = useState<string>('breakfast');
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
              {MEALS.map((m) => (
                <option key={m} value={m}>
                  {m}
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
