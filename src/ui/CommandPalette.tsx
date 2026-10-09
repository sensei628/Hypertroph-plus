import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  BODY_METRIC_TYPES,
  ENTRY_TYPE_VOCAB,
  EXERCISE_CATEGORY_VOCAB,
  FOOD_TYPE_VOCAB,
  PREP_STATE_VOCAB,
  EQUIPMENT_VOCAB,
  MUSCLE_COUNTS_VOCAB,
  type BodyMetricType,
  type ExerciseFacets,
  type ExerciseFilters,
  type ExerciseSummary,
  type FoodDetail,
  type FoodFacets,
  type FoodFilters,
  type FoodSummary,
} from '../data/repository';

type PickType = 'food' | 'exercise';
type Tab = PickType | 'metrics';
type SortMode = 'name' | 'recent' | 'favorite';

interface Props {
  initialMode: PickType;
  searchFoods: (q: string, limit: number, filters?: FoodFilters) => FoodSummary[];
  countFoods: (q: string, filters?: FoodFilters) => number;
  getFoodFacets: (q: string) => FoodFacets;
  getFood: (id: string) => FoodDetail | null;
  searchExercises: (q: string, limit: number, filters?: ExerciseFilters) => ExerciseSummary[];
  countExercises: (q: string, filters?: ExerciseFilters) => number;
  getExerciseFacets: (q: string) => ExerciseFacets;
  getExercise: (id: string) => ExerciseSummary | null;
  recentFoodIds: string[];
  recentExerciseIds: string[];
  favoriteFoodIds: string[];
  favoriteExerciseIds: string[];
  pinnedFoods: FoodSummary[];
  pinnedExercises: ExerciseSummary[];
  onToggleFavorite: (type: PickType, id: string) => void;
  onAddBodyMetric: (input: { metricType: BodyMetricType; value: number; localDate: string; note?: string }) => void;
  onPickFood: (food: FoodSummary) => void;
  onPickExercise: (ex: ExerciseSummary) => void;
  onClose: () => void;
}

const FOOD_TYPE_LABEL = Object.fromEntries(FOOD_TYPE_VOCAB);
const ENTRY_TYPE_LABEL = Object.fromEntries(ENTRY_TYPE_VOCAB);
const PREP_STATE_LABEL = Object.fromEntries(PREP_STATE_VOCAB);
const CATEGORY_LABEL = Object.fromEntries(EXERCISE_CATEGORY_VOCAB);
const EQUIPMENT_LABEL = Object.fromEntries(EQUIPMENT_VOCAB);
const MUSCLE_LABEL = Object.fromEntries(MUSCLE_COUNTS_VOCAB);

interface FacetChipValue {
  id: string;
  name: string;
  count: number;
}

interface RowItem {
  section: 'pinned' | 'favorites' | 'recents' | 'matches';
  type: PickType;
  food?: FoodSummary;
  exercise?: ExerciseSummary;
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function Chip({ value, active, onClick }: { value: FacetChipValue; active: boolean; onClick: () => void }) {
  return (
    <button
      key={value.id}
      className={`chip ${active ? 'active' : ''}`}
      onClick={onClick}
      title={active ? `Clear ${value.name} filter` : `Filter by ${value.name}`}
    >
      {value.name} <span className="chip-count">{value.count}</span>
    </button>
  );
}

function FacetBar(props: {
  groups: {
    label: string;
    values: FacetChipValue[];
    selected: string | null | undefined;
    onPick: (v: string) => void;
  }[];
  onClearAll: () => void;
}) {
  const anyActive = props.groups.some((g) => g.selected);
  return (
    <div className="facet-bar">
      {props.groups.map((g) => (
        <div className="facet-group" key={g.label}>
          <span className="facet-label">{g.label}</span>
          <div className="facet-chips">
            {g.values.map((v) => (
              <Chip key={v.id} value={v} active={g.selected === v.id} onClick={() => g.onPick(v.id)} />
            ))}
          </div>
        </div>
      ))}
      {anyActive && (
        <button className="clear-filters" onClick={props.onClearAll}>
          Clear filters
        </button>
      )}
    </div>
  );
}

export function CommandPalette({
  initialMode,
  searchFoods,
  countFoods,
  getFoodFacets,
  getFood,
  searchExercises,
  countExercises,
  getExerciseFacets,
  getExercise,
  recentFoodIds,
  recentExerciseIds,
  favoriteFoodIds,
  favoriteExerciseIds,
  pinnedFoods,
  pinnedExercises,
  onToggleFavorite,
  onAddBodyMetric,
  onPickFood,
  onPickExercise,
  onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>(initialMode);
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('name');
  const [foodFilter, setFoodFilter] = useState<FoodFilters>({});
  const [exFilter, setExFilter] = useState<ExerciseFilters>({});
  const [favFoods, setFavFoods] = useState<Set<string>>(new Set(favoriteFoodIds));
  const [favExes, setFavExes] = useState<Set<string>>(new Set(favoriteExerciseIds));
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const isSearchTab = tab === 'food' || tab === 'exercise';

  const foods = useMemo(
    () => (tab === 'food' ? searchFoods(query, 50, foodFilter) : []),
    [tab, query, foodFilter, searchFoods],
  );
  const exercises = useMemo(
    () => (tab === 'exercise' ? searchExercises(query, 50, exFilter) : []),
    [tab, query, exFilter, searchExercises],
  );
  const matched = tab === 'food' ? countFoods(query, foodFilter) : tab === 'exercise' ? countExercises(query, exFilter) : 0;
  const available = tab === 'food' ? countFoods('') : tab === 'exercise' ? countExercises('') : 0;

  const foodFacets = useMemo(() => (tab === 'food' ? getFoodFacets(query) : null), [tab, query, getFoodFacets]);
  const exerciseFacets = useMemo(
    () => (tab === 'exercise' ? getExerciseFacets(query) : null),
    [tab, query, getExerciseFacets],
  );

  const favRows = useMemo<RowItem[]>(() => {
    if (tab === 'food') {
      return [...favFoods]
        .map((id) => getFood(id))
        .filter((f): f is FoodDetail => Boolean(f))
        .map((f) => ({ section: 'favorites' as const, type: 'food' as const, food: f }));
    }
    if (tab === 'exercise') {
      return [...favExes]
        .map((id) => getExercise(id))
        .filter((e): e is ExerciseSummary => Boolean(e))
        .map((e) => ({ section: 'favorites' as const, type: 'exercise' as const, exercise: e }));
    }
    return [];
  }, [tab, favFoods, favExes, getFood, getExercise]);

  const recentRows = useMemo<RowItem[]>(() => {
    if (tab === 'food') {
      return recentFoodIds
        .slice(0, 6)
        .map((id) => getFood(id))
        .filter((f): f is FoodDetail => Boolean(f))
        .map((f) => ({ section: 'recents' as const, type: 'food' as const, food: f }));
    }
    if (tab === 'exercise') {
      return recentExerciseIds
        .slice(0, 6)
        .map((id) => getExercise(id))
        .filter((e): e is ExerciseSummary => Boolean(e))
        .map((e) => ({ section: 'recents' as const, type: 'exercise' as const, exercise: e }));
    }
    return [];
  }, [tab, recentFoodIds, recentExerciseIds, getFood, getExercise]);

  const list = useMemo<RowItem[]>(() => {
    const empty =
      !query &&
      (tab === 'food'
        ? !foodFilter.foodTypeId && !foodFilter.entryType && !foodFilter.prepState
        : !exFilter.categoryId && !exFilter.equipmentId && !exFilter.muscleId);
    const rows: RowItem[] = [];
    if (empty) {
      const pins: RowItem[] =
        tab === 'food'
          ? pinnedFoods.map((f) => ({ section: 'pinned' as const, type: 'food' as const, food: f }))
          : pinnedExercises.map((e) => ({ section: 'pinned' as const, type: 'exercise' as const, exercise: e }));
      rows.push(...pins, ...favRows, ...recentRows);
    }

    const matches: RowItem[] = [
      ...foods.map((f): RowItem => ({ section: 'matches', type: 'food', food: f })),
      ...exercises.map((e): RowItem => ({ section: 'matches', type: 'exercise', exercise: e })),
    ];

    if (sortMode === 'recent' && empty) {
      const idx = new Map((tab === 'food' ? recentFoodIds : recentExerciseIds).map((id, i) => [id, i]));
      matches.sort((a, b) => {
        const ia = idx.get(a.food?.id ?? a.exercise?.id ?? '');
        const ib = idx.get(b.food?.id ?? b.exercise?.id ?? '');
        if (ia == null && ib == null) return 0;
        if (ia == null) return 1;
        if (ib == null) return -1;
        return ia - ib;
      });
    } else if (sortMode === 'favorite' && empty) {
      const fav = tab === 'food' ? favFoods : favExes;
      matches.sort((a, b) => {
        const idA = a.food?.id ?? a.exercise?.id ?? '';
        const idB = b.food?.id ?? b.exercise?.id ?? '';
        if (fav.has(idA) && !fav.has(idB)) return -1;
        if (!fav.has(idA) && fav.has(idB)) return 1;
        return 0;
      });
    }
    rows.push(...matches);
    return rows;
  }, [
    query, tab, foodFilter, exFilter, pinnedFoods, pinnedExercises, favRows, recentRows, foods, exercises,
    sortMode, recentFoodIds, recentExerciseIds, favFoods, favExes,
  ]);

  const shown = list.length;

  useEffect(() => {
    if (isSearchTab) inputRef.current?.focus();
  }, [tab, isSearchTab]);

  useEffect(() => {
    setActive(0);
  }, [query, tab, sortMode, foodFilter, exFilter]);

  useEffect(() => {
    resultsRef.current?.querySelector<HTMLElement>('.result.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function choose() {
    const item = list[active];
    if (!item) return;
    if (item.type === 'food' && item.food) onPickFood(item.food);
    else if (item.type === 'exercise' && item.exercise) onPickExercise(item.exercise);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') return onClose();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, shown - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose();
    }
  }

  function toggleFilter<K extends keyof FoodFilters>(group: K, value: string) {
    setFoodFilter((prev) => ({ ...prev, [group]: prev[group] === value ? null : value }));
  }

  function toggleExFilter<K extends keyof ExerciseFilters>(group: K, value: string) {
    setExFilter((prev) => ({ ...prev, [group]: prev[group] === value ? null : value }));
  }

  function toggleFav(type: PickType, id: string) {
    if (type === 'food') {
      setFavFoods((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    } else {
      setFavExes((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }
    onToggleFavorite(type, id);
  }

  const sectionLabel = (s: RowItem['section']) =>
    s === 'pinned' ? 'Quick picks' : s === 'favorites' ? 'Favorites' : s === 'recents' ? 'Recents' : query ? 'Matches' : 'All';

  const catalogLabel = tab === 'food' ? 'foods' : 'exercises';
  const footer = isSearchTab
    ? query
      ? shown < matched
        ? `showing ${shown} of ${matched.toLocaleString()} ${catalogLabel}`
        : `${matched.toLocaleString()} ${matched === 1 ? 'match' : 'matches'}`
      : `showing ${shown} of ${available.toLocaleString()} ${catalogLabel} — type to narrow`
    : 'Log a body metric — saved to your local database';

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-tabs" role="tablist" aria-label="Palette sections">
          <button role="tab" aria-selected={tab === 'food'} className={`palette-tab ${tab === 'food' ? 'active' : ''}`} onClick={() => setTab('food')}>
            Food
          </button>
          <button role="tab" aria-selected={tab === 'exercise'} className={`palette-tab ${tab === 'exercise' ? 'active' : ''}`} onClick={() => setTab('exercise')}>
            Exercises
          </button>
          <button role="tab" aria-selected={tab === 'metrics'} className={`palette-tab ${tab === 'metrics' ? 'active' : ''}`} onClick={() => setTab('metrics')}>
            Body Metrics
          </button>
        </div>

        {tab === 'metrics' ? (
          <MetricsForm onAddBodyMetric={onAddBodyMetric} onClose={onClose} />
        ) : (
          <>
            <input
              ref={inputRef}
              value={query}
              placeholder={tab === 'food' ? `Search ${available.toLocaleString()} foods…` : `Search ${available.toLocaleString()} exercises…`}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
            />
            {tab === 'food' && foodFacets && (
              <FacetBar
                groups={[
                  { label: 'Type', values: foodFacets.foodTypes, selected: foodFilter.foodTypeId, onPick: (v) => toggleFilter('foodTypeId', v) },
                  { label: 'Entry', values: foodFacets.entryTypes, selected: foodFilter.entryType, onPick: (v) => toggleFilter('entryType', v) },
                  { label: 'Prep', values: foodFacets.prepStates, selected: foodFilter.prepState, onPick: (v) => toggleFilter('prepState', v) },
                ]}
                onClearAll={() => setFoodFilter({})}
              />
            )}
            {tab === 'exercise' && exerciseFacets && (
              <FacetBar
                groups={[
                  { label: 'Category', values: exerciseFacets.categories, selected: exFilter.categoryId, onPick: (v) => toggleExFilter('categoryId', v) },
                  { label: 'Equipment', values: exerciseFacets.equipment, selected: exFilter.equipmentId, onPick: (v) => toggleExFilter('equipmentId', v) },
                  { label: 'Muscle', values: exerciseFacets.muscles, selected: exFilter.muscleId, onPick: (v) => toggleExFilter('muscleId', v) },
                ]}
                onClearAll={() => setExFilter({})}
              />
            )}
            <div className="sort-row">
              <span className="small muted">Sort</span>
              <div className="segments small">
                {(['name', 'recent', 'favorite'] as SortMode[]).map((s) => (
                  <button key={s} className={`segment ${sortMode === s ? 'active' : ''}`} onClick={() => setSortMode(s)}>
                    {s === 'name' ? 'Name' : s === 'recent' ? 'Recent' : 'Favorites'}
                  </button>
                ))}
              </div>
            </div>
            <div className="results" ref={resultsRef}>
              {shown === 0 && (
                <div className="result muted">
                  No matches. {tab === 'food' ? 'Try “Create custom food” from Nutrition, then pick it here.' : 'Try another term or clear a filter.'}
                </div>
              )}
              {list.map((item, i) => {
                const showHeader = i === 0 || list[i - 1].section !== item.section;
                const f = item.food;
                const e = item.exercise;
                const id = f?.id ?? e?.id ?? '';
                const isFav = f ? favFoods.has(id) : favExes.has(id);
                return (
                  <Fragment key={`${item.section}-${id}`}>
                    {showHeader && <div className="section-label">{sectionLabel(item.section)}</div>}
                    <div
                      className={`result ${i === active ? 'active' : ''}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => {
                        if (item.type === 'food' && f) onPickFood(f);
                        else if (e) onPickExercise(e);
                      }}
                    >
                      <div className="result-main">
                        {f ? (
                          <>
                            <span>
                              {f.name} {f.brand ? <span className="muted small">· {f.brand}</span> : null}
                            </span>
                            <span className="chips">
                              {f.entryType ? <span className="tag">{ENTRY_TYPE_LABEL[f.entryType] ?? f.entryType}</span> : null}
                              {f.foodTypeId ? <span className="tag">{FOOD_TYPE_LABEL[f.foodTypeId] ?? f.foodTypeId}</span> : null}
                              <span className="tag">{PREP_STATE_LABEL[f.prepState] ?? f.prepState}</span>
                              <span className="tag">{f.quality}</span>
                            </span>
                          </>
                        ) : e ? (
                          <>
                            <span>
                              {e.name}
                              {e.matchedAlias ? <span className="muted small"> (alias: {e.matchedAlias})</span> : null}
                            </span>
                            <span className="chips">
                              {e.categoryId ? <span className="tag">{CATEGORY_LABEL[e.categoryId] ?? e.categoryId}</span> : null}
                              {e.equipment.map((x) => (
                                <span key={x} className="tag">
                                  {EQUIPMENT_LABEL[x] ?? x}
                                </span>
                              ))}
                              {e.primaryMuscles.map((m) => (
                                <span key={m} className="tag">
                                  {MUSCLE_LABEL[m] ?? m}
                                </span>
                              ))}
                            </span>
                          </>
                        ) : null}
                      </div>
                      <button
                        className={`star ${isFav ? 'on' : ''}`}
                        title={isFav ? 'Remove from favorites' : 'Add to favorites'}
                        aria-label={isFav ? 'Unfavorite' : 'Favorite'}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          toggleFav(item.type, id);
                        }}
                      >
                        {isFav ? '★' : '☆'}
                      </button>
                    </div>
                  </Fragment>
                );
              })}
            </div>
          </>
        )}

        <div className="tabs">
          <span className="small muted">{footer}</span>
          <span className="spacer" />
          <span className="kbd">↑↓</span>
          <span className="small muted">move ·</span>
          <span className="kbd">Enter</span>
          <span className="small muted">pick ·</span>
          <span className="kbd">Esc</span>
          <span className="small muted">close</span>
        </div>
      </div>
    </div>
  );
}

function MetricsForm(props: { onAddBodyMetric: (input: { metricType: BodyMetricType; value: number; localDate: string; note?: string }) => void; onClose: () => void }) {
  const [metricType, setMetricType] = useState<BodyMetricType>('weight_kg');
  const [value, setValue] = useState('');
  const [localDate, setLocalDate] = useState(toISODate(new Date()));
  const [note, setNote] = useState('');
  const valueOk = Number.isFinite(Number(value)) && Number(value) > 0;

  function submit() {
    if (!valueOk) return;
    props.onAddBodyMetric({ metricType, value: Number(value), localDate, note: note.trim() || undefined });
    props.onClose();
  }

  return (
    <div className="metrics-form">
      <div className="row">
        <span>Metric</span>
        <select value={metricType} onChange={(e) => setMetricType(e.target.value as BodyMetricType)}>
          {BODY_METRIC_TYPES.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <span>Value</span>
        <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder="e.g. 82.5" style={{ width: 140 }} />
      </div>
      <div className="row">
        <span>Date</span>
        <input type="date" value={localDate} onChange={(e) => setLocalDate(e.target.value)} />
      </div>
      <div className="row">
        <span>Note</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" style={{ flex: 1 }} />
      </div>
      <div className="row">
        <button className="ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button className="primary" disabled={!valueOk} onClick={submit}>
          Log metric
        </button>
      </div>
    </div>
  );
}

export default CommandPalette;