import BrandWordmark from "@/components/BrandWordmark";
import "../signin-preview.css";

const GOOGLE_SIGN_IN_URL = "/api/auth/google?returnTo=%2Fsexboard";

export default function SignInMockupB() {
  return (
    <main className="surface signin min-h-screen">
      <div className="atmosphere" aria-hidden="true">
        <div className="atm-top" />
        <div className="atm-bottom" />
        <div className="grain" />
      </div>

      <span className="preview-tag" aria-hidden="true">
        Preview · Mockup <b>B</b> · Sealed
      </span>

      <header className="signin-header">
        <BrandWordmark />
      </header>

      <section className="pb-stage">
        <p className="pb-eyebrow">For two</p>
        <h1 className="h-intimate pb-headline">
          <span>Cross the</span>
          <span>threshold.</span>
        </h1>

        <div className="pb-ornament" aria-hidden="true">
          <i />
          <svg viewBox="0 0 12 12" fill="none">
            <path
              d="M6 1 L7 5 L11 6 L7 7 L6 11 L5 7 L1 6 L5 5 Z"
              fill="currentColor"
              opacity="0.85"
            />
          </svg>
          <i />
        </div>

        <div className="pb-card">
          <h2 className="pb-card-title">Step inside</h2>
          <p className="pb-card-sub">
            For couples ready to discuss the things they&apos;ve never said out loud.
          </p>

          <a className="pb-cta pressable" href={GOOGLE_SIGN_IN_URL}>
            <span className="pb-cta-glyph" aria-hidden="true">g</span>
            Continue with Google
          </a>

          <hr className="pb-card-divider" />

          <a className="pb-ghost" href={GOOGLE_SIGN_IN_URL}>
            Have an invite? <u>Enter the code</u>
          </a>
        </div>

        <p className="pb-foot">
          18+ ·{" "}
          <a href="/privacy.html">Trust</a> ·{" "}
          <a href="/terms.html">Terms</a>
        </p>

        <nav className="preview-switcher" aria-label="Mockup switcher">
          <a href="/v1-preview/signin-a">A · Hushed</a>
          <a href="/v1-preview/signin-b" aria-current="page">B · Sealed</a>
          <a href="/v1-preview/signin-c">C · Teaser</a>
        </nav>
      </section>
    </main>
  );
}
