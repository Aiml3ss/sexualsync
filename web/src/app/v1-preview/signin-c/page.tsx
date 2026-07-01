import BrandWordmark from "@/components/BrandWordmark";
import "../signin-preview.css";

const GOOGLE_SIGN_IN_URL = "/api/auth/google?returnTo=%2Fsexboard";

type Room = {
  name: string;
  body: string;
  glyph: React.ReactNode;
};

const ROOMS: Room[] = [
  {
    name: "Ideas",
    body: "Drop fantasies into a shared shelf. Discuss them out loud.",
    glyph: (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 2 L9.4 6.6 L14 8 L9.4 9.4 L8 14 L6.6 9.4 L2 8 L6.6 6.6 Z"
          fill="currentColor"
          opacity="0.92"
        />
      </svg>
    ),
  },
  {
    name: "Ask",
    body: "Decide on a thing together. Privately. Without the small-talk.",
    glyph: (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 2 a6 6 0 1 1 -3.7 10.7 L2 14 l1.3 -2.3 A6 6 0 0 1 8 2 Z"
          stroke="currentColor"
          strokeWidth="1.4"
          fill="none"
        />
      </svg>
    ),
  },
  {
    name: "Sexboard",
    body: "The shared rituals between you. Tonight, this week, the long arc.",
    glyph: (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 2 a6 6 0 0 1 0 12 V2 Z"
          fill="currentColor"
          opacity="0.92"
        />
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      </svg>
    ),
  },
  {
    name: "Mutual",
    body: "What you both want, revealed only when you both say yes.",
    glyph: (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M3 8 C 3 4, 6.5 4, 8 8 C 9.5 12, 13 12, 13 8 C 13 4, 9.5 4, 8 8 C 6.5 12, 3 12, 3 8 Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    ),
  },
];

export default function SignInMockupC() {
  return (
    <main className="surface signin min-h-screen">
      <div className="atmosphere" aria-hidden="true">
        <div className="atm-top" />
        <div className="atm-bottom" />
        <div className="grain" />
      </div>

      <span className="preview-tag" aria-hidden="true">
        Preview · Mockup <b>C</b> · Teaser
      </span>

      <header className="signin-header">
        <BrandWordmark />
      </header>

      <section className="pc-stage">
        <div className="pc-lede">
          <svg className="signin-ribbon pc-ribbon" viewBox="0 0 100 50" fill="none" aria-hidden="true">
            <defs>
              <radialGradient id="pcGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#e9a8b3" stopOpacity="0.45" />
                <stop offset="60%" stopColor="#b87989" stopOpacity="0.12" />
                <stop offset="100%" stopColor="#b87989" stopOpacity="0" />
              </radialGradient>
            </defs>
            <ellipse className="signin-ribbon-glow" cx="50" cy="25" rx="46" ry="18" fill="url(#pcGlow)" />
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
          <h1 className="h-intimate pc-headline">Four rooms. One couple.</h1>
          <p className="pc-sub">
            A private space to share kinks, drop fantasies, and finally ask for the thing.
          </p>
        </div>

        <ul className="pc-tiles">
          {ROOMS.map((room) => (
            <li key={room.name} className="pc-tile">
              <span className="pc-tile-glyph" aria-hidden="true">{room.glyph}</span>
              <h3 className="pc-tile-title">{room.name}</h3>
              <p className="pc-tile-body">{room.body}</p>
            </li>
          ))}
        </ul>

        <div className="pc-actions">
          <a className="pc-cta pressable" href={GOOGLE_SIGN_IN_URL}>
            <span className="pc-cta-glyph" aria-hidden="true">g</span>
            Continue with Google
          </a>
          <p className="pc-foot">
            18+ ·{" "}
            <a href="/privacy.html">Trust</a> ·{" "}
            <a href="/terms.html">Terms</a>
          </p>
        </div>

        <nav className="preview-switcher" aria-label="Mockup switcher">
          <a href="/v1-preview/signin-a">A · Hushed</a>
          <a href="/v1-preview/signin-b">B · Sealed</a>
          <a href="/v1-preview/signin-c" aria-current="page">C · Teaser</a>
        </nav>
      </section>
    </main>
  );
}
