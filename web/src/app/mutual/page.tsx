"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getRequestBoard, updateRequestAction } from "@/lib/api";
import { confirmAction } from "@/lib/confirm-dialog";
import { getProfileCached } from "@/lib/profile-cache";
import { isApprovedSexActRequest, timingCopyForRequest } from "@/lib/request-state";
import { useDayRollover } from "@/lib/use-day-rollover";
import type { RequestRecord } from "@/lib/types";

type Celebration = {
  source: "pile" | "ask" | "shelf" | "kink";
  acts: string[];
  count: number;
  requestId: string;
  narration: string;
  // The partner's reply note (request.feedback) and any per-act decision notes,
  // already decrypted by getRequestBoard. Only populated once the matched
  // request loads; the optimistic URL/sessionStorage paint never carries them.
  partnerNote: string;
  partnerName: string;
  actNotes: { label: string; note: string }[];
};

// Caps for values seeded from raw URL params. React escapes the strings so
// there's no XSS here — these guard against an over-long URL blowing out the
// layout (a huge acts list, a giant count, or a paragraph-length narration).
const MAX_ACTS = 24;
const MAX_ACT_LENGTH = 80;
const MAX_COUNT = 99;
const MAX_NARRATION_LENGTH = 280;

function clampActs(acts: string[]): string[] {
  return acts.slice(0, MAX_ACTS).map((act) => act.slice(0, MAX_ACT_LENGTH));
}

function clampCount(count: number, fallback: number): number {
  if (!Number.isFinite(count)) return Math.min(MAX_COUNT, Math.max(1, fallback));
  return Math.min(MAX_COUNT, Math.max(1, Math.floor(count)));
}

export default function MutualPage() {
  const router = useRouter();
  useDayRollover();
  const [celebration, setCelebration] = useState<Celebration>({
    source: "ask",
    acts: [],
    count: 1,
    requestId: "",
    narration: "",
    partnerNote: "",
    partnerName: "",
    actNotes: [],
  });
  const [passContext, setPassContext] = useState<{ workspaceId: string; request: RequestRecord } | null>(null);
  const [passBusy, setPassBusy] = useState(false);
  const [passError, setPassError] = useState("");
  // True once we've loaded the request and confirmed it is NOT an approved
  // all-yes match (revoked / passed / expired). Until then we keep the
  // optimistic "Both of you said yes" paint — the URL alone never asserts it.
  const [staleMatch, setStaleMatch] = useState(false);

  useEffect(() => {
    // Hydration-safe URL read: server can't reach window.location, so seed the
    // celebration from query params after mount and trigger the vibration cue.
    const params = new URLSearchParams(window.location.search);
    let privateCelebration: Partial<Celebration> | null = null;
    if (params.get("private") === "1") {
      try {
        privateCelebration = JSON.parse(sessionStorage.getItem("ss:mutual-celebration") || "null");
        sessionStorage.removeItem("ss:mutual-celebration");
      } catch {
        privateCelebration = null;
      }
    }
    const source = String(privateCelebration?.source || params.get("source") || "ask") as Celebration["source"];
    const rawActs = Array.isArray(privateCelebration?.acts) ? privateCelebration.acts : (params.get("acts") || "")
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean);
    const acts = clampActs(rawActs);
    const count = clampCount(Number(privateCelebration?.count || params.get("count") || acts.length || 1), acts.length || 1);
    const requestId = params.get("requestId") || "";
    const narration = String(privateCelebration?.narration || params.get("narration") || "").trim().slice(0, MAX_NARRATION_LENGTH);
    const nextCelebration = {
      source: ["pile", "ask", "shelf", "kink"].includes(source) ? source : "ask",
      acts,
      count,
      requestId,
      narration,
      partnerNote: "",
      partnerName: "",
      actNotes: [] as Celebration["actNotes"],
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCelebration(nextCelebration);
    if (navigator.vibrate) navigator.vibrate([10, 30, 60, 30, 10]);

    if (!requestId) return;
    let cancelled = false;
    const timers: number[] = [];

    const loadPrewarmedMatch = async () => {
      try {
        const profile = await getProfileCached();
        const workspaceId = profile.activeWorkspace?.id || profile.activeWorkspaceId || "";
        if (!workspaceId) return Boolean(narration);

        let matchedNarration = narration;
        let foundMatch = false;

        const board = await getRequestBoard(workspaceId);
        const match = [
          ...(board.activeRequests || []),
          ...(board.requests || []),
          ...(board.history || []),
        ].find((item) => item.id === requestId);
        if (match) {
          foundMatch = true;
          const matchedActs = approvedActsForRequest(match);
          matchedNarration = (match.matchNarration || "").trim() || matchedNarration;
          const approved = isApprovedSexActRequest(match);
          if (!cancelled) setStaleMatch(!approved);
          if (!cancelled && approved) {
            setPassContext({ workspaceId, request: match });
          }
          if (!cancelled && matchedActs.length) {
            setCelebration((current) => ({
              ...current,
              acts: matchedActs,
              count: matchedActs.length,
            }));
          }
          // The partner's reply comment: an overall reply note (feedback) plus
          // any per-act notes attached to a Yes. getRequestBoard has already
          // decrypted these, so an E2EE room shows them too once unlocked.
          if (!cancelled) {
            const partnerNote = String(match.feedback || "").trim();
            const partnerName = firstName(match.reviewerName || match.reviewer || "");
            const actNotes = (match.decisions || [])
              .filter((decision) => decision.decision === "Yes" && String(decision.note || "").trim())
              .map((decision) => ({
                label: String(decision.label || "").trim(),
                note: String(decision.note || "").trim(),
              }));
            if (partnerNote || partnerName || actNotes.length) {
              setCelebration((current) => ({ ...current, partnerNote, partnerName, actNotes }));
            }
          }
        }

        if (!cancelled && matchedNarration) {
          setCelebration((current) => ({ ...current, narration: matchedNarration }));
        }
        return Boolean(matchedNarration || !foundMatch);
      } catch {
        return Boolean(narration);
      }
    };

    const scheduleRetries = (delays: number[]) => {
      const [delay, ...remainingDelays] = delays;
      if (!delay) return;
      const timer = window.setTimeout(async () => {
        if (cancelled) return;
        const ready = await loadPrewarmedMatch();
        if (!ready) {
          scheduleRetries(remainingDelays);
        }
      }, delay);
      timers.push(timer);
    };

    void (async () => {
      const ready = await loadPrewarmedMatch();
      if (!ready && !cancelled) {
        scheduleRetries([1200, 5000, 22000]);
      }
    })();

    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  async function passTonight() {
    if (!passContext || passBusy) return;
    const timingCopy = timingCopyForRequest(passContext.request);
    const confirmed = await confirmAction({
      title: `Pass on this Ask for ${timingCopy}?`,
      body: "It will leave the active Sexboard for both of you.",
      confirmLabel: "Pass",
      destructive: true,
    });
    if (!confirmed) return;
    setPassBusy(true);
    setPassError("");
    try {
      await updateRequestAction({
        workspaceId: passContext.workspaceId,
        id: passContext.request.id,
        action: "pass",
      });
      if (navigator.vibrate) navigator.vibrate(8);
      router.push("/sexboard");
    } catch (error) {
      setPassError(error instanceof Error ? error.message : "Couldn't pass on this Ask.");
      setPassBusy(false);
    }
  }

  const label = useMemo(() => {
    if (celebration.source === "pile") return "The Pile found overlap.";
    if (celebration.source === "shelf") return "You both wanted this.";
    if (celebration.source === "kink") return "You both leaned in.";
    return "The Ask landed.";
  }, [celebration.source]);

  const fallbackLabel = `${celebration.count} mutual yes${celebration.count === 1 ? "" : "es"}`;
  const narrationText = celebration.narration || fallbackNarrationForCelebration(celebration);
  const passTimingCopy = passContext ? timingCopyForRequest(passContext.request) : "tonight";

  // The request loaded but is no longer an approved match (revoked / passed /
  // expired). Don't assert a mutual yes from the stale URL — show a neutral
  // closed state with a way back instead.
  if (staleMatch) {
    return (
      <main className="surface mutual-surface">
        <div className="atmosphere" aria-hidden="true">
          <div className="atm-top" />
          <div className="atm-bottom" />
          <div className="grain" />
        </div>
        <section className="mutual-stage">
          <div className="mutual-mark" aria-hidden="true">
            <svg width="150" height="75" viewBox="0 0 100 50" fill="none">
              <path
                d="M12 25 C 12 10, 38 10, 50 25 C 62 40, 88 40, 88 25 C 88 10, 62 10, 50 25 C 38 40, 12 40, 12 25 Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                pathLength={100}
              />
            </svg>
          </div>
          <div className="mutual-copy">
            <p className="mutual-eyebrow">This Ask changed.</p>
            <h1 className="h-intimate mutual-title">This one&rsquo;s no longer active.</h1>
            <p className="mutual-narration mutual-narration--fallback" aria-live="polite">
              It may have been passed, taken back, or expired. Check the Sexboard for what&rsquo;s on now.
            </p>
            <div className="mutual-actions">
              <Link href="/sexboard" className="btn-primary mutual-cta pressable">
                Back to Sexboard
              </Link>
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="surface mutual-surface">
      <div className="atmosphere" aria-hidden="true">
        <div className="atm-top" />
        <div className="atm-bottom" />
        <div className="grain" />
      </div>
      <section className="mutual-stage">
        <div className="mutual-mark" aria-hidden="true">
          <svg width="150" height="75" viewBox="0 0 100 50" fill="none">
            <path
              d="M12 25 C 12 10, 38 10, 50 25 C 62 40, 88 40, 88 25 C 88 10, 62 10, 50 25 C 38 40, 12 40, 12 25 Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              pathLength={100}
            />
          </svg>
        </div>
        <div className="mutual-copy">
          <p className="mutual-eyebrow">{label}</p>
          <h1 className="h-intimate mutual-title">Both of you said yes.</h1>
          <div className={`mutual-pill ${celebration.acts.length > 1 ? "mutual-pill-list" : ""}`} aria-live="polite">
            {celebration.acts.length ? celebration.acts.map((act, index) => (
              <span key={`${act}-${index}`} className="mutual-act">{act}</span>
            )) : (
              <span className="mutual-act">{fallbackLabel}</span>
            )}
          </div>
          <p className={`mutual-narration ${celebration.narration ? "" : "mutual-narration--fallback"}`} aria-live="polite">
            {narrationText}
          </p>
          {(celebration.partnerNote || celebration.actNotes.length > 0) && (
            <div className="mutual-note" aria-live="polite">
              <p className="mutual-note-label">
                {celebration.partnerName ? `Note from ${celebration.partnerName}` : "Their note"}
              </p>
              {celebration.partnerNote && (
                <p className="mutual-note-text">{celebration.partnerNote}</p>
              )}
              {celebration.actNotes.length > 0 && (
                <ul className="mutual-note-list">
                  {celebration.actNotes.map((item, index) => (
                    <li key={`${item.label}-${index}`}>
                      {item.label && <span className="mutual-note-act">{item.label}</span>}
                      <span>{item.note}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="mutual-actions">
            <Link href="/sexboard" className="btn-primary mutual-cta pressable">
              Back
            </Link>
            {passContext && (
              <button
                type="button"
                className="btn-ghost mutual-pass pressable"
                disabled={passBusy}
                onClick={passTonight}
              >
                {passBusy ? "Passing..." : `Pass ${passTimingCopy}`}
              </button>
            )}
          </div>
          {passError && <p className="mutual-error" role="alert">{passError}</p>}
        </div>
      </section>
    </main>
  );
}

function fallbackNarrationForCelebration(celebration: Celebration) {
  if (celebration.source === "pile") return "The overlap is locked. The rest is getting close.";
  if (celebration.source === "shelf" || celebration.source === "kink") return "That shared yes is locked in. Now it gets real.";
  return "That yes is locked in. Now it gets real.";
}

function firstName(value: string) {
  return String(value || "").trim().split(/\s+/)[0] || "";
}

function approvedActsForRequest(request: RequestRecord) {
  const approved = (request.decisions || [])
    .filter((decision) => decision.decision === "Yes" && (!decision.targetType || decision.targetType === "act"))
    .map((decision) => decision.label);
  return uniqueLabels(approved.length ? approved : request.categories || []);
}

function uniqueLabels(labels: string[]) {
  const seen = new Set<string>();
  const clean: string[] = [];
  labels.forEach((label) => {
    const value = String(label || "").trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return;
    seen.add(key);
    clean.push(value);
  });
  return clean;
}
