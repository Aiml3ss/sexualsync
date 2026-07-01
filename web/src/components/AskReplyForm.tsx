"use client";

import { useMemo, useState } from "react";
import { splitActLabel } from "@/lib/act-label";
import { fireSendPulse } from "@/lib/send-pulse";
import type { Act, Decision, Timing } from "@/lib/types";

export type ReplyDecisionPayload = {
  label: string;
  decision: Decision;
  counter?: string;
  note?: string;
  targetType?: "act" | "timing" | "filming" | "general";
  actId?: string;
  counterActId?: string;
};

const COLLAPSED_ACT_COUNT = 10;
const TIMINGS: { value: Timing; label: string }[] = [
  { value: "Tonight", label: "Tonight" },
  { value: "Mid-day", label: "Mid-day" },
  { value: "Tomorrow", label: "Tomorrow" },
  { value: "Next week", label: "Next week" },
];

export default function AskReplyForm({
  requestedActs,
  requestedTiming,
  acts,
  submitting,
  error,
  onCreateAct,
  onSubmit,
}: {
  requestedActs: string[];
  requestedTiming: Timing;
  acts: Act[];
  submitting: boolean;
  error?: string;
  onCreateAct: (label: string) => Promise<Act>;
  onSubmit: (decisions: ReplyDecisionPayload[], note: string) => Promise<void>;
}) {
  const requested = requestedActs.length ? requestedActs : ["This Ask"];
  const [yesToAll, setYesToAll] = useState(false);
  const [passAll, setPassAll] = useState(false);
  const [selectedCounterActIds, setSelectedCounterActIds] = useState<string[]>([]);
  const [actsExpanded, setActsExpanded] = useState(false);
  const [actSearch, setActSearch] = useState("");
  const [actComposerOpen, setActComposerOpen] = useState(false);
  const [counterTiming, setCounterTiming] = useState<Timing | "">("");
  const [note, setNote] = useState("");
  // Local fallback error. Not every parent wires the `error` prop (ask-detail
  // doesn't), so we always surface a rejection from onSubmit here too.
  const [localError, setLocalError] = useState<string | null>(null);
  const visibleError = error || localError;

  const selectedCounterActs = useMemo(
    () => acts.filter((act) => selectedCounterActIds.includes(act.id)),
    [acts, selectedCounterActIds],
  );
  const filteredActs = useMemo(() => {
    const query = actSearch.trim().toLowerCase();
    if (!query) return acts;
    return acts.filter((act) => act.label.toLowerCase().includes(query) || act.tags?.some((tag) => tag.includes(query)));
  }, [actSearch, acts]);
  const visibleActs = useMemo(() => {
    if (actsExpanded) return filteredActs;
    const selected = new Set(selectedCounterActIds);
    const pinned = acts.filter((act) => selected.has(act.id));
    const starters = acts.filter((act) => !selected.has(act.id)).slice(0, COLLAPSED_ACT_COUNT);
    return [...pinned, ...starters];
  }, [acts, actsExpanded, filteredActs, selectedCounterActIds]);
  const counterTimingOptions = TIMINGS.filter((option) => option.value !== requestedTiming);
  const hiddenActCount = Math.max(0, acts.length - visibleActs.length);
  const canSubmit = !submitting && (yesToAll || passAll || selectedCounterActs.length > 0 || !!counterTiming);

  function toggleCounterAct(id: string) {
    setYesToAll(false);
    setPassAll(false);
    setSelectedCounterActIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function handleCreateAct(label: string) {
    const act = await onCreateAct(label);
    setYesToAll(false);
    setPassAll(false);
    setSelectedCounterActIds((prev) => (
      prev.includes(act.id) ? prev : [...prev, act.id]
    ));
    setActComposerOpen(false);
    setActsExpanded(false);
    setActSearch("");
    if (navigator.vibrate) navigator.vibrate(4);
  }

  async function submit(originEl?: HTMLElement) {
    if (!canSubmit) return;
    setLocalError(null);
    const requestedDecision = passAll ? "No" : "Yes";
    const shouldAnswerRequestedActs = passAll || yesToAll || (!!counterTiming && selectedCounterActs.length === 0);
    const decisions: ReplyDecisionPayload[] = shouldAnswerRequestedActs
      ? requested.map((label) => ({
          label,
          decision: requestedDecision,
          counter: "",
          note: "",
          targetType: "act" as const,
          actId: "",
          counterActId: "",
        }))
      : [];
    decisions.push(...selectedCounterActs.map((act, index) => ({
          label: `Counter option ${index + 1}`,
          decision: "Counter" as const,
          counter: act.label,
          note: "",
          targetType: "act" as const,
          actId: "",
          counterActId: act.id,
        })));
    if (counterTiming) {
      decisions.push({
        label: `Timing: ${requestedTiming}`,
        decision: "Counter",
        counter: counterTiming,
        note: "",
        targetType: "timing",
        actId: "",
        counterActId: "",
      });
    }
    try {
      // Await the write FIRST, then fire the celebratory send pulse only once
      // it resolves. A failed reply must not flash the success animation.
      await onSubmit(decisions, note.trim());
      fireSendPulse(originEl);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Couldn't send your reply.");
    }
  }

  return (
    <form
      className="review-form"
      onSubmit={(event) => {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
        submit(submitter ?? event.currentTarget);
      }}
    >
      <section className="review-decision-card">
        <p className="review-decision-label">Requested Acts</p>
        <div className="selected-act-strip" aria-label="Requested Acts">
          {requested.map((label) => (
            <span key={label} className="selected-act-pill">
              <ActLabel label={label} className="selected-act-label" />
            </span>
          ))}
        </div>
        <div className="review-choice-grid" role="group" aria-label="Reply decision">
          <button
            type="button"
            className={`cadence-chip pressable ${yesToAll ? "is-picked" : ""}`}
            aria-pressed={yesToAll}
            disabled={submitting}
            onClick={() => {
              setYesToAll(true);
              setPassAll(false);
              setSelectedCounterActIds([]);
            }}
          >
            Yes to all
          </button>
          <button
            type="button"
            className={`cadence-chip pressable ${passAll ? "is-picked" : ""}`}
            aria-pressed={passAll}
            disabled={submitting}
            onClick={() => {
              setPassAll(true);
              setYesToAll(false);
              setSelectedCounterActIds([]);
              setCounterTiming("");
            }}
          >
            Pass
          </button>
        </div>
      </section>

      <section className="review-decision-card">
        <p className="review-decision-label">Counter with your own Acts</p>

        {selectedCounterActs.length > 0 && (
          <div className="selected-act-strip" aria-label="Counter Acts">
            {selectedCounterActs.map((act) => (
              <button
                key={act.id}
                type="button"
                onClick={() => toggleCounterAct(act.id)}
                className="selected-act-pill pressable"
                disabled={submitting}
              >
                <ActLabel label={act.label} className="selected-act-label" />
                <span aria-hidden="true">x</span>
              </button>
            ))}
          </div>
        )}

        {actsExpanded && (
          <input
            value={actSearch}
            onChange={(event) => setActSearch(event.target.value)}
            placeholder="Search Acts"
            aria-label="Search Acts"
            className="input"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="search"
            disabled={submitting}
          />
        )}

        <div className="ask-act-grid">
          {visibleActs.map((act) => (
            <ActButton
              key={act.id}
              act={act}
              selected={selectedCounterActIds.includes(act.id)}
              disabled={submitting}
              onClick={() => toggleCounterAct(act.id)}
            />
          ))}
        </div>

        <div className="ask-act-actions">
          {acts.length > COLLAPSED_ACT_COUNT && (
            <button
              type="button"
              onClick={() => {
                setActsExpanded((value) => !value);
                setActSearch("");
              }}
              className="btn-ghost ask-act-action"
              disabled={submitting}
            >
              {actsExpanded ? "Collapse Acts" : `Show all ${acts.length} Acts`}
            </button>
          )}
          <button
            type="button"
            onClick={() => setActComposerOpen((value) => !value)}
            className="btn-ghost ask-act-action"
            disabled={submitting}
          >
            {actComposerOpen ? "Close" : "Add your own"}
          </button>
        </div>

        {!actsExpanded && hiddenActCount > 0 && (
          <p className="mt-2 text-xs text-ink-3">
            {hiddenActCount} more saved Acts are tucked away until you expand.
          </p>
        )}

        {actComposerOpen && (
          <ActComposer
            onCancel={() => setActComposerOpen(false)}
            onSubmit={handleCreateAct}
          />
        )}
      </section>

      <section className="review-decision-card">
        <p className="review-decision-label">Counter time</p>
        <div className="mb-3 flex flex-wrap gap-1.5">
          <span className="chip">{requestedTiming}</span>
        </div>
        <div className="cadence-grid review-cadence-grid" role="group" aria-label="Counter time">
          {counterTimingOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`cadence-chip pressable ${counterTiming === option.value ? "is-picked" : ""}`}
              aria-pressed={counterTiming === option.value}
              disabled={submitting}
              onClick={() => {
                setPassAll(false);
                setCounterTiming((value) => value === option.value ? "" : option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <label className="review-field">
        <span>Note</span>
        <textarea
          className="input review-textarea"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Add context if it helps."
          maxLength={1800}
          rows={4}
          disabled={submitting}
          autoCapitalize="none"
          autoCorrect="on"
          spellCheck
          inputMode="text"
        />
      </label>

      {visibleError && (
        <p className="review-error" role="alert" aria-live="assertive">{visibleError}</p>
      )}

      <button type="submit" className="btn-primary w-full" disabled={!canSubmit} data-testid="ask-reply-submit">
        {submitting ? "Sending..." : "Send reply"}
      </button>
    </form>
  );
}

function ActButton({
  act,
  selected,
  disabled,
  onClick,
}: {
  act: Act;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      disabled={disabled}
      className={[
        "act-chip pressable",
        selected ? "is-picked" : "",
      ].join(" ")}
    >
      <ActLabel label={act.label} className="act-chip-inner" />
    </button>
  );
}

function ActLabel({ label, className }: { label: string; className: string }) {
  const { emoji, text } = splitActLabel(label);
  return (
    <span className={className}>
      {emoji && <span className="act-label-emoji" aria-hidden="true">{emoji}</span>}
      <span className="act-chip-name">{text}</span>
    </span>
  );
}

function ActComposer({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (label: string) => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = label.trim();

  async function submit() {
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(clean);
      setLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save this Act.");
      setBusy(false);
    }
  }

  return (
    <div className="act-composer card p-4">
      <p className="font-display text-base text-ink">Add an Act</p>
      <input
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder="e.g. Slow undressing"
        aria-label="New Act"
        className="input mt-3"
        maxLength={80}
        autoCapitalize="none"
        autoCorrect="on"
        spellCheck
        inputMode="text"
        disabled={busy}
      />
      {error && <p className="mt-2 text-sm" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>{error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-ghost text-sm" disabled={busy}>
          Cancel
        </button>
        <button type="button" onClick={submit} className="btn-primary text-sm" disabled={busy || !clean}>
          {busy ? "Saving..." : "Add and select"}
        </button>
      </div>
    </div>
  );
}
