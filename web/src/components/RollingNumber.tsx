/**
 * A number that rises into place whenever it changes — a small "tick" that
 * makes live counts feel alive instead of snapping. Width stays stable
 * (tabular-nums + grid stacking, see `.roll-num` in globals.css), so the
 * surrounding layout never shifts. Under prefers-reduced-motion the CSS drops
 * the animation and it renders as a plain number.
 *
 * Pure presentational: keying the inner span on the displayed value is what
 * remounts it and replays the keyframe on change.
 */
export default function RollingNumber({
  value,
  max,
  className,
}: {
  value: number;
  /** Clamp display to `${max}+` once exceeded (e.g. a "9+" badge). */
  max?: number;
  className?: string;
}) {
  const display = typeof max === "number" && value > max ? `${max}+` : `${value}`;
  return (
    <span className={["roll-num", className].filter(Boolean).join(" ")}>
      <span key={display} className="roll-num-value">
        {display}
      </span>
    </span>
  );
}
