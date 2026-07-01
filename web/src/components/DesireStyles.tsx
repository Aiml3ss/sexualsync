/**
 * A tap-to-open primer that normalizes the two desire styles (spontaneous vs
 * responsive). Shown on the Sex Quiz and Green Lights intros to take the
 * pressure off — you don't have to feel turned on right now to answer honestly,
 * which is the brake that most often blocks an honest answer. Native <details>
 * so it's accessible and needs no client state. Shares the .primer-note styles
 * with <LibidoNote>.
 */
export default function DesireStyles() {
  return (
    <details className="primer-note">
      <summary className="primer-note-summary">
        <span>Not in the mood right now? That&apos;s normal — here&apos;s why</span>
        <span className="primer-note-chev" aria-hidden="true">›</span>
      </summary>
      <div className="primer-note-body">
        <p>
          Desire works two ways. Some people feel it out of nowhere
          (<strong>spontaneous</strong>). For others it only shows up once things
          are already going — a touch, a kiss, the right moment
          (<strong>responsive</strong>). Neither is more normal, and most couples
          are a mix of the two.
        </p>
        <p>
          So you don&apos;t have to feel turned on to answer honestly. Answer for
          what you&apos;re drawn to <em>when the moment is right</em> — not for how
          you happen to feel this second.
        </p>
      </div>
    </details>
  );
}
