// Chart/statistics helpers. Pure date bucketing + aggregation so the SVG chart
// components stay presentational and the math is unit-testable.

export interface DatedValue {
  date: string;
  value: number;
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/** Monday-start of the ISO week containing `iso`. */
export function mondayOf(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  return addDaysISO(iso, -dow);
}

/** `n` consecutive week-starts ending with the week containing `endISO` (oldest first). */
export function recentWeekStarts(n: number, endISO: string): string[] {
  const monday = mondayOf(endISO);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDaysISO(monday, -7 * i));
  return out;
}

/** Inclusive list of ISO dates between two dates (oldest first). */
export function dailyRange(fromISO: string, toISO_: string): string[] {
  const out: string[] = [];
  let cur = fromISO;
  let guard = 0;
  while (cur <= toISO_ && guard < 4000) {
    out.push(cur);
    cur = addDaysISO(cur, 1);
    guard++;
  }
  return out;
}

/** Sum `rows` values into buckets keyed by each week's Monday. */
export function sumByWeek(rows: DatedValue[], weeks: string[]): number[] {
  const idx = new Map(weeks.map((w, i) => [w, i]));
  const out = new Array(weeks.length).fill(0);
  for (const r of rows) {
    const i = idx.get(mondayOf(r.date));
    if (i != null) out[i] += r.value;
  }
  return out;
}

/** Align per-day values to a continuous date range (missing days = 0). */
export function dailySeries(fromISO: string, toISO_: string, rows: DatedValue[]): DatedValue[] {
  const map = new Map(rows.map((r) => [r.date, r.value]));
  return dailyRange(fromISO, toISO_).map((date) => ({ date, value: map.get(date) ?? 0 }));
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Atwater energy split (kcal) for the three macros. */
export function macroEnergySplit(proteinG: number, fatG: number, carbG: number): { protein: number; fat: number; carb: number } {
  return { protein: proteinG * 4, fat: fatG * 9, carb: carbG * 4 };
}

/** Year month label used for chart tooltips/labels. */
export function shortLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
