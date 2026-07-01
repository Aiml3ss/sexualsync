"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import ScreenHeader from "@/components/ScreenHeader";
import RollingNumber from "@/components/RollingNumber";
import { EmptyState, ErrorState, SkeletonList } from "@/components/States";
import {
  ApiUnauthorizedError,
  getHealthDashboard,
} from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import type {
  AuthInfo,
  HealthEvent,
  HealthRangeId,
  HealthResponse,
  Workspace,
} from "@/lib/types";

const RANGES: Array<{ id: HealthRangeId; label: string }> = [
  { id: "30d", label: "30d" },
  { id: "90d", label: "90d" },
  { id: "all", label: "All" },
];

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "no-workspace"; auth: AuthInfo }
  | { kind: "ready"; auth: AuthInfo; workspace: Workspace; health: HealthResponse };

export default function HealthPage() {
  const [range, setRange] = useState<HealthRangeId>("all");
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setState((current) => current.kind === "ready" ? current : { kind: "loading" });
        const profile = await getProfileCached();
        if (cancelled) return;
        if (!profile.activeWorkspace) {
          setState({ kind: "no-workspace", auth: profile.auth });
          return;
        }
        const health = await getHealthDashboard({
          workspaceId: profile.activeWorkspace.id,
          range,
        });
        if (cancelled) return;
        setState({
          kind: "ready",
          auth: profile.auth,
          workspace: profile.activeWorkspace,
          health,
        });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't load Health." });
      }
    })();
    return () => { cancelled = true; };
  }, [range]);

  return (
    <AppShell>
      <ScreenHeader
        eyebrow={<Link href="/space" className="text-ink-3">‹ Space</Link>}
        showBrand={false}
        title="Health"
        subtitle="Approved Asks and Pile overlaps count as sex."
      />
      <Body
        state={state}
        range={range}
        onRange={setRange}
      />
    </AppShell>
  );
}

function Body({
  state,
  range,
  onRange,
}: {
  state: LoadState;
  range: HealthRangeId;
  onRange: (range: HealthRangeId) => void;
}) {
  if (state.kind === "loading") return <SkeletonList count={4} />;
  if (state.kind === "unauthorized") {
    return (
      <ErrorState
        title="Session expired"
        body="Sign in again to see Health."
        action={<Link href="/" className="btn-ghost">Back to sign-in</Link>}
      />
    );
  }
  if (state.kind === "error") {
    return <ErrorState title="Couldn't load Health" body={state.message} />;
  }
  if (state.kind === "no-workspace") {
    return (
      <ErrorState
        title="No partner space yet"
        body="Health is scoped to a shared space."
        action={<Link href="/space" className="btn-ghost">Open Space</Link>}
      />
    );
  }

  return (
    <div className="health-stage">
      <RangePicker value={range} onChange={onRange} />
      <HealthSummary health={state.health} />
      <RhythmCard health={state.health} />
      <TopActs health={state.health} />
      <Balance health={state.health} />
      <SourceHistory events={state.health.events} />
    </div>
  );
}

function RangePicker({
  value,
  onChange,
}: {
  value: HealthRangeId;
  onChange: (range: HealthRangeId) => void;
}) {
  const activeIndex = Math.max(0, RANGES.findIndex((item) => item.id === value));
  return (
    <div
      className="health-range"
      role="group"
      aria-label="Health range"
      style={{ "--active-index": activeIndex } as CSSProperties}
    >
      <span className="health-range-thumb" aria-hidden="true" />
      {RANGES.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={value === item.id}
          className={`health-range-button pressable ${value === item.id ? "is-active" : ""}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function HealthSummary({ health }: { health: HealthResponse }) {
  const { totals } = health;
  return (
    <section className="health-summary" aria-label="Health summary">
      <div className="health-summary-head">
        <p className="eyebrow">{health.range.label}</p>
        <span className="health-rule-pill">approved = counted</span>
      </div>
      <div className="health-hero-stat">
        <RollingNumber value={totals.sexEvents} className="health-hero-num" />
        <div className="health-hero-meta">
          <strong>sex event{totals.sexEvents === 1 ? "" : "s"}</strong>
          <span>
            {totals.askEvents} Ask{totals.askEvents === 1 ? "" : "s"} · {totals.pileEvents} Pile overlap{totals.pileEvents === 1 ? "" : "s"}
          </span>
        </div>
      </div>
      <div className="health-substat-grid">
        <div className="health-substat">
          <RollingNumber value={totals.sexActs} className="health-substat-num" />
          <p>approved Acts</p>
        </div>
        <div className="health-substat">
          <RollingNumber value={totals.uniqueActs} className="health-substat-num" />
          <p>unique Acts</p>
        </div>
      </div>
    </section>
  );
}

function RhythmCard({ health }: { health: HealthResponse }) {
  const buckets = useMemo(() => compactRhythm(health), [health]);
  const max = Math.max(1, ...buckets.map((bucket) => bucket.sexEvents));
  return (
    <section className="health-section" aria-label="Rhythm">
      <div className="health-section-head">
        <h2>Rhythm</h2>
        <span>{lastEventLabel(health.insights.daysSinceLast)}</span>
      </div>
      <div className="health-card health-rhythm-card">
        <div className="health-bars" aria-hidden="true">
          {buckets.map((bucket, index) => {
            const height = Math.max(10, Math.round((bucket.sexEvents / max) * 78));
            return (
              <span
                key={bucket.date}
                className={`health-bar ${bucket.pileEvents ? "has-pile" : ""} ${bucket.askEvents ? "has-ask" : ""}`}
                style={{ height, animationDelay: `${260 + index * 46}ms` } as CSSProperties}
              />
            );
          })}
        </div>
        <p>
          Same-night approved Asks and Pile overlaps stay separate in the total, then group by day here.
        </p>
      </div>
    </section>
  );
}

function TopActs({ health }: { health: HealthResponse }) {
  if (!health.topActs.length) return null;
  const max = Math.max(1, ...health.topActs.map((act) => act.count));
  return (
    <section className="health-section" aria-label="Act counts">
      <div className="health-section-head">
        <h2>Acts showing up</h2>
        <span>top {Math.min(5, health.topActs.length)}</span>
      </div>
      <div className="health-card health-act-list">
        {health.topActs.slice(0, 5).map((act, index) => (
          <div key={act.label} className="health-act-row">
            <span>
              <strong>{act.label}</strong>
              <span className="health-meter">
                <span
                  style={{
                    width: `${Math.max(8, Math.round((act.count / max) * 100))}%`,
                    animationDelay: `${220 + index * 90}ms`,
                  } as CSSProperties}
                />
              </span>
            </span>
            <em>{act.count}x</em>
          </div>
        ))}
      </div>
    </section>
  );
}

function Balance({ health }: { health: HealthResponse }) {
  const split = health.insights.requesterSplit;
  const splitLabel = split.length >= 2
    ? `${split[0].count} / ${split[1].count}`
    : split.length === 1
    ? `${split[0].count} Ask${split[0].count === 1 ? "" : "s"}`
    : "No Asks";

  return (
    <section className="health-section" aria-label="Balance">
      <div className="health-section-head">
        <h2>Balance</h2>
        <span>not a grade</span>
      </div>
      <div className="health-balance-grid">
        <article className="health-card health-balance-card">
          <strong>{splitLabel}</strong>
          <span>Ask starts in this range.</span>
        </article>
        <article className="health-card health-balance-card">
          <strong>{health.insights.newActs.length}</strong>
          <span>new-to-you Acts landed here.</span>
        </article>
      </div>
      {health.insights.newActs.length > 0 && (
        <div className="health-chip-row" aria-label="New Acts">
          {health.insights.newActs.slice(0, 4).map((act) => (
            <span key={act.label} className="chip-primary">First time: {act.label}</span>
          ))}
        </div>
      )}
    </section>
  );
}

function SourceHistory({ events }: { events: HealthEvent[] }) {
  if (!events.length) {
    return (
      <EmptyState
        title="Nothing counted yet."
        body="Approved Asks and Pile overlaps will appear here automatically."
        action={<Link href="/ask" className="btn-ghost">Send an Ask</Link>}
      />
    );
  }

  return (
    <section className="health-section" aria-label="Source history">
      <div className="health-section-head">
        <h2>Source history</h2>
        <span>{events.length} counted</span>
      </div>
      <div className="health-card health-event-list">
        {events.slice(0, 8).map((event) => (
          <div key={event.id} className="health-event-row">
            <span className={`health-event-type ${event.type === "pile" ? "is-pile" : ""}`}>
              {event.type === "pile" ? "Pile" : "Ask"}
            </span>
            <span className="health-event-copy">
              <strong>{event.title}</strong>
              <span>{formatDate(event.at)} · {event.acts.length} Act{event.acts.length === 1 ? "" : "s"}</span>
            </span>
            <span className="health-event-acts" aria-label={event.acts.join(", ")}>
              {eventActSummaries(event).slice(0, 4).map((act, index) => (
                <span key={`${event.id}-${act.label}-${index}`} className="health-act-emoji" title={act.label}>
                  {act.emoji}
                </span>
              ))}
              {event.acts.length > 4 && <span className="health-act-more">+{event.acts.length - 4}</span>}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function eventActSummaries(event: HealthEvent) {
  if (event.actSummaries?.length) return event.actSummaries;
  return event.acts.map((label) => ({ label, emoji: emojiFromLabel(label) }));
}

const CLIENT_ACT_EMOJI_RULES: Array<{ terms: string[]; emoji: string }> = [
  { terms: ["kiss", "make out", "makeout"], emoji: "💋" },
  { terms: ["oral", "tongue", "lick", "mouth", "blow", "suck"], emoji: "👅" },
  { terms: ["massage", "rub"], emoji: "💆" },
  { terms: ["shower"], emoji: "🚿" },
  { terms: ["bath", "tub"], emoji: "🛁" },
  { terms: ["filming = yes", "filming yes", "recording", "camcorder"], emoji: "📹" },
  { terms: ["toy", "vibrator", "plug"], emoji: "🎁" },
  { terms: ["dirty talk", "talk"], emoji: "💬" },
  { terms: ["restraint", "tie", "bound", "pinned", "hands"], emoji: "⛓️" },
  { terms: ["cowgirl", "reverse"], emoji: "🤠" },
  { terms: ["behind", "doggy"], emoji: "🍑" },
  { terms: ["wall", "standing"], emoji: "🧍" },
  { terms: ["couch"], emoji: "🛋️" },
  { terms: ["roleplay", "role play"], emoji: "🎭" },
  { terms: ["cuddle", "aftercare", "hold"], emoji: "🤗" },
  { terms: ["penetration", "sex"], emoji: "🍆" },
  { terms: ["rough", "active"], emoji: "🔥" },
  { terms: ["slow"], emoji: "🐢" },
  { terms: ["kink"], emoji: "🔗" },
];

function emojiFromLabel(label: string) {
  const trimmed = label.trim();
  const match = trimmed.match(/^(\p{Extended_Pictographic}(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?)*)\s*/u);
  if (match?.[1]) return match[1];
  const normalized = trimmed.toLowerCase();
  const matched = CLIENT_ACT_EMOJI_RULES.find((rule) => rule.terms.some((term) => normalized.includes(term)));
  return matched?.emoji || "💞";
}

function compactRhythm(health: HealthResponse) {
  if (health.rhythm.length >= 12) return health.rhythm.slice(-12);
  if (health.rhythm.length > 0) {
    const existing = health.rhythm.slice();
    const start = new Date(existing[0].date);
    const pads = [];
    for (let index = 12 - existing.length; index > 0; index -= 1) {
      const date = new Date(start);
      date.setDate(start.getDate() - index);
      const key = date.toISOString().slice(0, 10);
      pads.push({ date: key, sexEvents: 0, sexActs: 0, askEvents: 0, pileEvents: 0 });
    }
    return [...pads, ...existing];
  }
  const end = new Date(health.range.to || Date.now());
  const buckets = [];
  for (let index = 11; index >= 0; index -= 1) {
    const date = new Date(end);
    date.setDate(end.getDate() - index);
    const key = date.toISOString().slice(0, 10);
    buckets.push({ date: key, sexEvents: 0, sexActs: 0, askEvents: 0, pileEvents: 0 });
  }
  return buckets;
}

function lastEventLabel(days: number | null) {
  if (days == null) return "no history";
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
