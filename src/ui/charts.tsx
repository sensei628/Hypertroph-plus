// Reusable, dependency-free SVG charts. Shapes are drawn in a normalized viewBox
// and scaled by CSS (preserveAspectRatio="none"); strokes use
// `vector-effect="non-scaling-stroke"` so they stay crisp. Text lives in HTML
// outside the SVG so it never distorts.
import type { ReactNode } from 'react';

export interface ChartPoint {
  label: string;
  value: number;
}

const VB_H = 100; // normalized viewBox height

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function fmtShort(v: number): string {
  if (Math.abs(v) >= 1000) return `${Math.round(v / 1000)}k`;
  if (Math.abs(v) >= 10) return String(Math.round(v));
  return String(Math.round(v * 10) / 10);
}

/** Vertical bars with an optional target reference line. */
export function BarChart(props: {
  data: ChartPoint[];
  height?: number;
  target?: number;
  unit?: string;
  formatValue?: (v: number) => string;
  color?: string;
  labelEvery?: number;
}) {
  const { data, height = 130, target, unit = '', color = 'var(--green-600)' } = props;
  const fmt = props.formatValue ?? fmtShort;
  if (data.length === 0) return <p className="muted small">No data yet.</p>;
  const max = niceMax(Math.max(...data.map((d) => d.value), target ?? 0));
  const n = data.length;
  const slot = 100 / n;
  const barW = slot * 0.62;
  const every = props.labelEvery ?? Math.ceil(n / 8);
  const targetY = target != null ? VB_H - (target / max) * VB_H : null;

  return (
    <div className="chart">
      <div className="chart-cap">
        <span className="muted small">max {fmt(max)}{unit && ` ${unit}`}</span>
      </div>
      <svg className="chart-svg" viewBox={`0 0 100 ${VB_H}`} preserveAspectRatio="none" style={{ height }} role="img">
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1="0" x2="100" y1={VB_H * g} y2={VB_H * g} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        {data.map((d, i) => {
          const h = max > 0 ? (d.value / max) * VB_H : 0;
          const x = i * slot + (slot - barW) / 2;
          return <rect key={i} x={x} y={VB_H - h} width={barW} height={Math.max(0, h)} rx={0.6} fill={d.value > 0 ? color : 'var(--track)'} />;
        })}
        {targetY != null && (
          <line x1="0" x2="100" y1={targetY} y2={targetY} stroke="var(--amber)" strokeWidth={1.5} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <div className="chart-labels">
        {data.map((d, i) => (
          <span key={i} className="chart-label">{i % every === 0 ? d.label : ''}</span>
        ))}
      </div>
    </div>
  );
}

/** Area + line chart for a time series. */
export function LineChart(props: {
  data: ChartPoint[];
  height?: number;
  unit?: string;
  formatValue?: (v: number) => string;
  color?: string;
  labelEvery?: number;
}) {
  const { data, height = 150, unit = '', color = 'var(--green-600)' } = props;
  const fmt = props.formatValue ?? fmtShort;
  if (data.length === 0) return <p className="muted small">No data yet.</p>;
  const values = data.map((d) => d.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * 0.12 || Math.max(1, hi * 0.1);
  const min = lo - pad;
  const max = hi + pad;
  const span = max - min || 1;
  const n = data.length;
  const every = props.labelEvery ?? Math.ceil(n / 8);
  const x = (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v: number) => VB_H - ((v - min) / span) * VB_H;
  const line = data.map((d, i) => `${x(i)},${y(d.value)}`).join(' ');
  const area = `0,${VB_H} ${line} 100,${VB_H}`;

  return (
    <div className="chart">
      <div className="chart-cap">
        <span className="muted small">{fmt(lo)}{unit && ` ${unit}`}</span>
        <span className="muted small">{fmt(hi)}{unit && ` ${unit}`}</span>
      </div>
      <svg className="chart-svg" viewBox={`0 0 100 ${VB_H}`} preserveAspectRatio="none" style={{ height }} role="img">
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1="0" x2="100" y1={VB_H * g} y2={VB_H * g} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        <polygon points={area} fill={color} opacity={0.12} />
        <polyline points={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="chart-labels">
        {data.map((d, i) => (
          <span key={i} className="chart-label">{i % every === 0 ? d.label : ''}</span>
        ))}
      </div>
    </div>
  );
}

export interface Segment {
  label: string;
  value: number;
  color: string;
}

/** Horizontal stacked bar (e.g. macro energy share). */
export function StackedBar(props: { segments: Segment[]; total?: number }) {
  const total = props.total ?? props.segments.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return <div className="stacked-bar" />;
  let x = 0;
  return (
    <div className="stacked-bar-wrap">
      <svg className="stacked-bar" viewBox="0 0 100 12" preserveAspectRatio="none" style={{ height: 14 }} role="img">
        {props.segments.map((s, i) => {
          const w = (s.value / total) * 100;
          const rect = <rect key={i} x={x} y={0} width={w} height={12} fill={s.color} />;
          x += w;
          return rect;
        })}
      </svg>
      <div className="legend">
        {props.segments.map((s, i) => (
          <span className="legend-item" key={i}>
            <span className="legend-swatch" style={{ background: s.color }} />
            {s.label} · {Math.round((s.value / total) * 100)}%
          </span>
        ))}
      </div>
    </div>
  );
}

/** Circular progress ring for a value against a target. */
export function Ring(props: { value: number; max: number; size?: number; label?: ReactNode; sub?: ReactNode; color?: string }) {
  const size = props.size ?? 116;
  const r = 16;
  const c = 2 * Math.PI * r;
  const pct = props.max > 0 ? Math.max(0, Math.min(1, props.value / props.max)) : 0;
  return (
    <div className="ring" style={{ width: size }}>
      <svg viewBox="0 0 40 40" style={{ width: size, height: size }} role="img">
        <circle cx="20" cy="20" r={r} fill="none" stroke="var(--track)" strokeWidth="3.5" />
        <circle
          cx="20"
          cy="20"
          r={r}
          fill="none"
          stroke={props.color ?? 'var(--green-600)'}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${pct * c} ${c}`}
          transform="rotate(-90 20 20)"
          style={{ transition: 'stroke-dasharray 0.4s ease' }}
        />
      </svg>
      <div className="ring-center">
        <span className="ring-value">{props.label}</span>
        {props.sub && <span className="ring-sub">{props.sub}</span>}
      </div>
    </div>
  );
}
