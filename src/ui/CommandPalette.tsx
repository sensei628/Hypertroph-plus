import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExerciseSummary, FoodSummary } from '../data/repository';

type Mode = 'food' | 'exercise';

interface Props {
  mode: Mode;
  searchFoods: (q: string) => FoodSummary[];
  countFoods: (q: string) => number;
  searchExercises: (q: string) => ExerciseSummary[];
  countExercises: (q: string) => number;
  onPickFood: (food: FoodSummary) => void;
  onPickExercise: (ex: ExerciseSummary) => void;
  onClose: () => void;
}

export function CommandPalette({ mode, searchFoods, countFoods, searchExercises, countExercises, onPickFood, onPickExercise, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const foods = useMemo(() => (mode === 'food' ? searchFoods(query) : []), [mode, query, searchFoods]);
  const exercises = useMemo(() => (mode === 'exercise' ? searchExercises(query) : []), [mode, query, searchExercises]);
  const matched = useMemo(() => (mode === 'food' ? countFoods(query) : countExercises(query)), [mode, query, countFoods, countExercises]);
  const available = useMemo(() => (mode === 'food' ? countFoods('') : countExercises('')), [mode, countFoods, countExercises]);
  const shown = mode === 'food' ? foods.length : exercises.length;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActive(0);
  }, [query]);

  function choose() {
    if (mode === 'food' && foods[active]) onPickFood(foods[active]);
    if (mode === 'exercise' && exercises[active]) onPickExercise(exercises[active]);
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

  const catalogLabel = mode === 'food' ? 'foods' : 'exercises';
  const catalogSize = available.toLocaleString();
  const footer = query
    ? shown < matched
      ? `showing ${shown} of ${matched.toLocaleString()} ${catalogLabel}`
      : `${matched.toLocaleString()} ${matched === 1 ? 'match' : 'matches'}`
    : `showing ${shown} of ${catalogSize} ${catalogLabel} — type to narrow`;

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder={mode === 'food' ? `Search ${catalogSize} foods…` : `Search ${catalogSize} exercises…`}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="results">
          {mode === 'food' &&
            foods.map((f, i) => (
              <div key={f.id} className={`result ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => onPickFood(f)}>
                <span>
                  {f.name} {f.brand ? <span className="muted small">· {f.brand}</span> : null}
                  {f.matchedAlias ? <span className="muted small"> (alias: {f.matchedAlias})</span> : null}
                </span>
                <span className="small muted">
                  per 100g · {f.prepState} <span className="tag">{f.quality}</span>
                </span>
              </div>
            ))}
          {mode === 'exercise' &&
            exercises.map((ex, i) => (
              <div key={ex.id} className={`result ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => onPickExercise(ex)}>
                <span>
                  {ex.name}
                  {ex.matchedAlias ? <span className="muted small"> (alias: {ex.matchedAlias})</span> : null}
                </span>
                <span className="small muted">
                  {ex.primaryMuscles.join(', ')}
                  {ex.equipment.length ? ` · ${ex.equipment.join(', ')}` : ''}
                </span>
              </div>
            ))}
          {shown === 0 && <div className="result muted">No matches. {mode === 'food' ? 'Try “Create custom food”.' : 'Custom exercise coming next.'}</div>}
        </div>
        <div className="tabs">
          <span className="small muted">{footer}</span>
          <span className="spacer" />
          <span className="kbd">↑↓</span>
          <span className="small muted">move ·</span>
          <span className="kbd">Enter</span>
          <span className="small muted">pick ·</span>
          <span className="kbd">Esc</span>
        </div>
      </div>
    </div>
  );
}
