interface SparklineProps {
  values: readonly number[];
  /** CSS color of the line, for example `var(--accent)`. */
  color?: string;
  className?: string;
}

const WIDTH = 200;
const HEIGHT = 32;
const PAD = 3;

/** Tiny trend line with an area fill and an emphasized last point. */
export function Sparkline({ values, color = "var(--accent)", className = "" }: SparklineProps) {
  if (values.length < 2) {
    return (
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className={className} aria-hidden>
        <line x1="0" x2={WIDTH} y1={HEIGHT - PAD} y2={HEIGHT - PAD} stroke="var(--border)" strokeWidth="1.5" />
      </svg>
    );
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const points = values.map((v, i): [number, number] => [
    (i * WIDTH) / (values.length - 1),
    HEIGHT - PAD - ((v - min) / range) * (HEIGHT - PAD * 2),
  ]);
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lx, ly] = points[points.length - 1]!;
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className={className} aria-hidden>
      <polygon points={`0,${HEIGHT} ${line} ${WIDTH},${HEIGHT}`} fill={color} opacity="0.12" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      <circle cx={lx - 2} cy={ly} r="2.6" fill={color} />
    </svg>
  );
}
