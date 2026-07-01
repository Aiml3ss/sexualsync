import BrandWordmark from "@/components/BrandWordmark";
import "../signin-preview.css";

const GOOGLE_SIGN_IN_URL = "/api/auth/google?returnTo=%2Fsexboard";

export default function SignInMockupA() {
  return (
    <main className="surface signin min-h-screen">
      <div className="atmosphere" aria-hidden="true">
        <div className="atm-top" />
        <div className="atm-bottom" />
        <div className="grain" />
      </div>

      <span className="preview-tag" aria-hidden="true">
        Preview · Mockup <b>A</b> · Hushed
      </span>

      <header className="signin-header">
        <BrandWordmark />
      </header>

      <section className="pa-stage">
        <div className="pa-hero">
          <svg className="signin-ribbon pa-ribbon" viewBox="0 0 100 50" fill="none" aria-hidden="true">
            <defs>
              <radialGradient id="paGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#e9a8b3" stopOpacity="0.55" />
                <stop offset="55%" stopColor="#b87989" stopOpacity="0.18" />
                <stop offset="100%" stopColor="#b87989" stopOpacity="0" />
              </radialGradient>
            </defs>
            <ellipse className="signin-ribbon-glow" cx="50" cy="25" rx="46" ry="18" fill="url(#paGlow)" />
            <path
              className="signin-ribbon-line"
              d="M12 25 C 12 10, 38 10, 50 25 C 62 40, 88 40, 88 25 C 88 10, 62 10, 50 25 C 38 40, 12 40, 12 25 Z"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
            <path
              className="signin-ribbon-trace"
              d="M12 25 C 12 10, 38 10, 50 25 C 62 40, 88 40, 88 25 C 88 10, 62 10, 50 25 C 38 40, 12 40, 12 25 Z"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <div className="pa-copy">
          <p className="pa-eyebrow">For two</p>
          <h1 className="h-intimate pa-headline">
            <span>Get curious.</span>
            <span>Get in sync.</span>
          </h1>
          <p className="pa-sub">
            A private room for couples to share kinks, drop fantasies, and finally ask for the thing.
          </p>
        </div>

        <div className="pa-actions">
          <a className="pa-cta pressable" href={GOOGLE_SIGN_IN_URL}>
            <span className="pa-cta-glyph" aria-hidden="true">g</span>
            Continue with Google
          </a>
        </div>

        <p className="pa-foot">
          18+ ·{" "}
          <a href="/privacy.html">Trust</a> ·{" "}
          <a href="/terms.html">Terms</a>
        </p>

        <nav className="preview-switcher" aria-label="Mockup switcher">
          <a href="/v1-preview/signin-a" aria-current="page">A · Hushed</a>
          <a href="/v1-preview/signin-b">B · Sealed</a>
          <a href="/v1-preview/signin-c">C · Teaser</a>
        </nav>
      </section>
    </main>
  );
}
