/**
 * A tap-to-open primer on the Green Lights intro that normalizes the things
 * people answer dishonestly about out of shame: different sex drives, a lower
 * libido, and solo pleasure (masturbation / porn). The app saying "this is OK"
 * — not just asking — so the lower-desire partner isn't quietly answering from
 * guilt. Shares the .primer-note styles with <DesireStyles>.
 */
export default function LibidoNote() {
  return (
    <details className="primer-note">
      <summary className="primer-note-summary">
        <span>Different drives? Solo time? All normal — the honest truth</span>
        <span className="primer-note-chev" aria-hidden="true">›</span>
      </summary>
      <div className="primer-note-body">
        <p>
          Two people almost never want sex equally often — that&apos;s the norm,
          not a sign anything&apos;s <strong>broken</strong>. A lower drive isn&apos;t
          a problem to fix, and wanting it less doesn&apos;t mean wanting{" "}
          <em>you</em> less.
        </p>
        <p>
          Getting yourself off — with or without porn, or side by side while the
          other reads — is healthy, and takes nothing away from the two of you.
          Being glad your partner finds pleasure, even when it isn&apos;t from you,
          is its own kind of closeness.
        </p>
      </div>
    </details>
  );
}
