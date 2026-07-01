import Link from "next/link";
import AppShell from "@/components/AppShell";
import PrivacyProofActions from "@/components/PrivacyProofActions";
import ScreenHeader from "@/components/ScreenHeader";

const DATA_POINTS = [
  {
    label: "Account",
    title: "We keep the basics needed to run your space.",
    copy: "Email, display name, active workspace, invite status, membership, notification preferences, and device push subscription details when you enable them.",
  },
  {
    label: "Shared room",
    title: "The room stores what you and your partner choose to sync.",
    copy: "Asks, limits, acts, Inspiration items, Shelf links, reactions, comments, activity state, occasional attention signals, timestamps, and deletion status are saved so both partners see the same private space.",
  },
  {
    label: "This device",
    title: "Private notes stay on your device.",
    copy: "Notes in Space are stored in this browser. They are not sent to our API unless you turn one into an Ask or share it to Inspiration.",
  },
  {
    label: "Vault",
    title: "Vault media is encrypted before upload.",
    copy: "Vault files, titles, comments, and moments are encrypted in the browser with your passphrase. We store encrypted bytes and delivery metadata, not your passphrase.",
  },
];

const BOUNDARIES = [
  "No public feed, discovery surface, or searchable profile.",
  "No ad profile built from your room content.",
  "No staff review queue for ordinary private rooms.",
  "No Vault media sent to AI-assisted features.",
];

const SYSTEM_DETAILS = [
  {
    title: "AI-assisted text",
    copy: "When you ask the app to refine wording, suggest reaction notes, narrate an overlap, or generate prompts, the text needed for that action may be sent to the configured LLM provider. Do not use AI tools for anything you do not want processed for that specific request.",
  },
  {
    title: "Operational metadata",
    copy: "We keep security and reliability records like timestamps, route metadata, rate-limit counters, audit events, error diagnostics, and deletion events. These are designed to protect the room, not expose explicit content.",
  },
  {
    title: "Product feedback",
    copy: "If you send feedback in the app, we store the message, sentiment, contact preference, and page context so we can triage it and follow up when requested.",
  },
  {
    title: "Support and safety",
    copy: "If you email support or file a safety report, only include private content when it is needed to solve the issue. We may preserve or review records when required for safety, abuse prevention, legal compliance, or a verified data request.",
  },
];

export default function SpacePrivacyPage() {
  return (
    <AppShell>
      <ScreenHeader
        eyebrow={<Link href="/space" className="text-ink-3">Back to Space</Link>}
        showBrand={false}
        title="Privacy"
        subtitle="What the app sees, what stays local, and what is encrypted."
        trailing={
          <Link href="/privacy.html" className="done-pill pressable" aria-label="Open the full privacy policy">
            Policy
          </Link>
        }
      />

      <div className="privacy-stage">
        <section className="privacy-hero" aria-labelledby="privacy-title">
          <p className="eyebrow">The short version</p>
          <h2 id="privacy-title">Sexualsync should be inspectable, not just trusted.</h2>
          <p>
            You can export your room data, check what stays on this device, and see the boundaries around encryption and deletion. We do not have your Vault passphrase, and private notes are device-only until you choose to share them.
          </p>
        </section>

        <section className="privacy-section" aria-label="See for yourself">
          <div className="privacy-section-head">
            <h2>See for yourself</h2>
            <span>receipts</span>
          </div>
          <PrivacyProofActions />
        </section>

        <section className="privacy-section" aria-label="Data visibility">
          <div className="privacy-section-head">
            <h2>What goes where</h2>
            <span>plain language</span>
          </div>
          <div className="privacy-data-grid">
            {DATA_POINTS.map((item) => (
              <article className="privacy-data-card" key={item.label}>
                <span>{item.label}</span>
                <h3>{item.title}</h3>
                <p>{item.copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="privacy-section" aria-label="Boundaries">
          <div className="privacy-section-head">
            <h2>Lines we draw</h2>
            <span>by design</span>
          </div>
          <div className="settings-card privacy-boundary-list">
            {BOUNDARIES.map((item) => (
              <div className="settings-row privacy-boundary-row" key={item}>
                <span className="privacy-check" aria-hidden="true">OK</span>
                <span className="settings-row-title">{item}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="privacy-section" aria-label="System details">
          <div className="privacy-section-head">
            <h2>Where care still matters</h2>
            <span>edge cases</span>
          </div>
          <div className="privacy-detail-list">
            {SYSTEM_DETAILS.map((item) => (
              <article className="health-card privacy-detail-card" key={item.title}>
                <h3>{item.title}</h3>
                <p>{item.copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="privacy-section" aria-label="Code transparency">
          <div className="privacy-section-head">
            <h2>Verify the code, don&rsquo;t just trust it</h2>
            <span>open by default</span>
          </div>
          <div className="privacy-detail-list">
            <article className="health-card privacy-detail-card">
              <h3>Signed build manifest</h3>
              <p>
                The app runs JavaScript served from our server, and that code is what performs the encryption — so its integrity matters. Every release publishes an Ed25519-signed manifest of the exact files it shipped. You, or anyone, can fetch it and confirm the code running here is the published, signed build and was not tampered with in transit.
              </p>
              <p>
                <a href="/.well-known/code-transparency.json" target="_blank" rel="noopener noreferrer">Signed manifest</a>
                {" · "}
                <a href="/.well-known/code-transparency-key.json" target="_blank" rel="noopener noreferrer">Signing key</a>
              </p>
            </article>
          </div>
        </section>

        <section className="privacy-policy-card" aria-label="Full policy">
          <div>
            <p className="eyebrow">Formal policy</p>
            <h2>Need the legal version?</h2>
            <p>
              The full Privacy Policy covers collection, providers, AI-assisted features, deletion, export, and safety reporting.
            </p>
          </div>
          <Link href="/privacy.html" className="btn-primary pressable">
            Read full policy
          </Link>
        </section>
      </div>
    </AppShell>
  );
}
