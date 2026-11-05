export default function Sparkline({ points, height = 48, color = "#a78bfa" }: { points: number[][]; height?: number; color?: string }) {
  if (!points.length) return <div className="muted small">No data</div>;
  const w = 260;
  const vals = points.map((p) => p[1] ?? 0);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const xy = vals.map((v, i) => [(i / Math.max(1, vals.length - 1)) * w, height - 4 - ((v - min) / span) * (height - 8)]);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = vals[vals.length - 1];
  return (
    <div className="spark">
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" width="100%" height={height} role="img" aria-label={`latest ${last.toFixed(1)}`}>
        <path d={`${d} L${w},${height} L0,${height} Z`} fill={color} opacity="0.12" />
        <path d={d} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="spark-meta small">
        <span>now <strong>{last.toFixed(1)}</strong></span>
        <span className="muted">min {min.toFixed(1)} · max {max.toFixed(1)}</span>
      </div>
    </div>
  );
}
