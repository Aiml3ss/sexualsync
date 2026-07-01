import Link from "next/link";
import BrandWordmark from "@/components/BrandWordmark";
import "../signin-preview.css";

type Mockup = {
  slug: "signin-a" | "signin-b" | "signin-c";
  letter: "A" | "B" | "C";
  title: string;
  pitch: string;
};

const MOCKUPS: Mockup[] = [
  {
    slug: "signin-a",
    letter: "A",
    title: "Hushed & intimate",
    pitch:
      "Breathing ribbon as the emotional center. Cream Google button instead of the loud stock one. Two-line italic headline. Same one-CTA shape, dialed up.",
  },
  {
    slug: "signin-b",
    letter: "B",
    title: "Sealed-room / premium",
    pitch:
      "Threshold framing. CTA lives inside a hairline chrome card with a warm inner glow and a gold ornament divider. “Step inside” copy.",
  },
  {
    slug: "signin-c",
    letter: "C",
    title: "Functional teaser",
    pitch:
      "Shows the four rooms (Ideas / Ask / Sexboard / Mutual) as quiet tiles before asking for sign-in. CTA at the bottom.",
  },
];

export default function SignInPreviewIndex() {
  return (
    <main className="surface signin min-h-screen">
      <div className="atmosphere" aria-hidden="true">
        <div className="atm-top" />
        <div className="atm-bottom" />
        <div className="grain" />
      </div>

      <header className="signin-header">
        <BrandWordmark />
      </header>

      <section className="preview-index-stage">
        <div className="preview-index-lede">
          <h1>Sign-in mockups</h1>
          <p>Three directions for redoing the sign-in. Open any one to see it full-screen.</p>
        </div>

        <ul className="preview-index-list">
          {MOCKUPS.map((m) => (
            <li key={m.slug}>
              <a className="preview-index-card pressable" href={`/v1-preview/${m.slug}`}>
                <kbd>Mockup {m.letter}</kbd>
                <h2>{m.title}</h2>
                <p>{m.pitch}</p>
              </a>
            </li>
          ))}
        </ul>

        <Link className="preview-index-back" href="/">
          ← Back to live sign-in
        </Link>
      </section>
    </main>
  );
}
