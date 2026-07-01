import Link from "next/link";
import AppShell from "@/components/AppShell";
import ScreenHeader from "@/components/ScreenHeader";

const STEPS = [
  {
    href: "/inspiration",
    label: "Inspiration",
    title: "Catch the spark",
    sub: "Drop kinks, fantasies, clips, or links — no pressure, nothing committed yet.",
    cta: "Open Inspiration",
  },
  {
    href: "/games",
    label: "Reveals",
    title: "Map what turns you on",
    sub: "Sex Quiz and Green Lights map your desires and limits double-blind. The Pile and Blind Reveal find the overlap with no one leading.",
    cta: "Open Reveals",
  },
  {
    href: "/ask",
    label: "Ask",
    title: "Make the want explicit",
    sub: "Send one clear request. Your partner can accept, counter, pass, or park it.",
    cta: "Create an Ask",
  },
  {
    href: "/chat",
    label: "Sext",
    title: "Keep the heat going",
    sub: "A private thread just for the two of you — tease, plan, send a little heat.",
    cta: "Open Sext",
  },
  {
    href: "/sexboard",
    label: "Sexboard",
    title: "See what is live",
    sub: "Active Asks, locked answers, and the overlap that is ready to act on.",
    cta: "Open Sexboard",
  },
  {
    href: "/space",
    label: "Space",
    title: "Keep the room safe",
    sub: "Limits, Acts, private notes, notifications, privacy, and account controls.",
    cta: "Back to Space",
  },
];

export default function TutorialPage() {
  return (
    <AppShell>
      <ScreenHeader
        eyebrow="Space tutorial"
        showBrand={false}
        title="Quick tour"
        subtitle="A short map for getting from spark to yes."
        trailing={
          <Link href="/space" className="done-pill pressable" aria-label="Done with tutorial, return to Space">
            Done
          </Link>
        }
      />

      <div className="settings-stage">
        <section className="settings-section tutorial-intro">
          <p className="eyebrow">The loop</p>
          <h2>Catch a spark, map what you want, make it explicit — and keep the boundaries in plain sight.</h2>
          <p>
            Sexualsync is your private, judgment-free room for the hot maybes, the explicit asks, and the shared rules that keep it safe enough to be greedy in.
          </p>
          <Link href="/inspiration" className="btn-primary pressable">Start with Inspiration</Link>
        </section>

        <section className="settings-section">
          <p className="eyebrow">Quick path</p>
          <div className="settings-card" aria-label="Tutorial steps">
            {STEPS.map((step, index) => (
              <TutorialStep key={step.href} index={index + 1} {...step} />
            ))}
          </div>
        </section>

        <Link href="/space" className="btn-primary tutorial-done-bottom pressable">
          Done
        </Link>
      </div>
    </AppShell>
  );
}

function TutorialStep({
  index,
  href,
  label,
  title,
  sub,
  cta,
}: {
  index: number;
  href: string;
  label: string;
  title: string;
  sub: string;
  cta: string;
}) {
  return (
    <Link href={href} className="settings-link tutorial-step pressable">
      <span className="tutorial-step-index">{index}</span>
      <span className="tutorial-step-copy">
        <span className="tutorial-step-label">{label}</span>
        <span className="settings-row-title">{title}</span>
        <span className="settings-row-sub">{sub}</span>
      </span>
      <span className="settings-link-chev tutorial-step-cta">{cta}</span>
    </Link>
  );
}
