"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import AppShell from "@/components/AppShell";
import AskReplyForm, { type ReplyDecisionPayload } from "@/components/AskReplyForm";
import ScreenHeader from "@/components/ScreenHeader";
import { ErrorState, SkeletonList } from "@/components/States";
import { combineBuiltInAndSavedActs } from "@/lib/built-in-acts";
import {
  ApiUnauthorizedError,
  createAct,
  getActs,
  resolveReviewToken,
  submitReviewToken,
} from "@/lib/api";
import type {
  Act,
  ReviewTokenRequest,
  ReviewTokenResolveResponse,
} from "@/lib/types";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized"; token: string }
  | { kind: "ready"; token: string; data: ReviewTokenResolveResponse; acts: Act[] }
  | { kind: "submitted"; request: ReviewTokenRequest };

export default function ReviewPage() {
  return (
    <Suspense fallback={<ReviewShell><SkeletonList count={3} /></ReviewShell>}>
      <ReviewFlow />
    </Suspense>
  );
}

function ReviewFlow() {
  const params = useSearchParams();
  const token = (params.get("token") || params.get("review") || "").trim();
  return <ReviewFlowForToken key={token || "missing"} token={token} />;
}

function ReviewFlowForToken({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>(() => (
    token
      ? { kind: "loading" }
      : { kind: "error", message: "This reply link is missing its private token." }
  ));

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      return () => { cancelled = true; };
    }
    resolveReviewToken(token)
      .then(async (data) => {
        const actsRes = await getActs(data.workspace.id);
        if (!cancelled) {
          setState({
            kind: "ready",
            token,
            data,
            acts: combineBuiltInAndSavedActs(actsRes.acts, data.workspace.id),
          });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized", token });
          return;
        }
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "This reply link could not be opened.",
        });
      });
    return () => { cancelled = true; };
  }, [token]);

  if (state.kind === "loading") return <ReviewShell><SkeletonList count={3} /></ReviewShell>;

  if (state.kind === "unauthorized") {
    const returnTo = `/review?token=${encodeURIComponent(state.token)}`;
    const signInUrl = `/api/auth/google?${new URLSearchParams({ returnTo }).toString()}`;
    return (
      <ReviewShell title="Reply to Ask" subtitle="Sign in to answer this request.">
        <ErrorState
          title="Sign in to reply"
          body="Use the same account this Ask was sent to."
          action={<a href={signInUrl} className="btn-primary">Continue with Google</a>}
        />
      </ReviewShell>
    );
  }

  if (state.kind === "error") {
    return (
      <ReviewShell title="Reply link">
        <ErrorState
          title="Reply link unavailable"
          body={state.message}
          action={<Link href="/sexboard" className="btn-ghost">Open Sexboard</Link>}
        />
      </ReviewShell>
    );
  }

  if (state.kind === "submitted") {
    return (
      <ReviewShell title="Reply sent" subtitle="Your answer is back in the room.">
        <div className="review-stage">
          <section className="card p-5 text-center">
            <p className="font-display text-2xl italic text-ink">Reply sent.</p>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              Your partner can open this Ask from Sexboard.
            </p>
            <Link href="/sexboard" className="btn-primary mt-5 w-full">Open Sexboard</Link>
          </section>
        </div>
      </ReviewShell>
    );
  }

  return (
    <ReviewShell
      title="Reply to Ask"
      subtitle={`${state.data.request.requesterName || "Your partner"} sent this to you.`}
    >
      <ReviewForm
        token={state.token}
        data={state.data}
        initialActs={state.acts}
        onSubmitted={(request) => setState({ kind: "submitted", request })}
      />
    </ReviewShell>
  );
}

function ReviewShell({
  children,
  title = "Reply to Ask",
  subtitle,
}: {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
}) {
  return (
    <AppShell hideTabBar>
      <ScreenHeader
        eyebrow={<Link href="/sexboard" className="text-ink-3">‹ Sexboard</Link>}
        showBrand={false}
        title={title}
        subtitle={subtitle}
      />
      {children}
    </AppShell>
  );
}

function ReviewForm({
  token,
  data,
  initialActs,
  onSubmitted,
}: {
  token: string;
  data: ReviewTokenResolveResponse;
  initialActs: Act[];
  onSubmitted: (request: ReviewTokenRequest) => void;
}) {
  const request = data.request;
  const [acts, setActs] = useState(initialActs);
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function createCounterAct(label: string) {
    const result = await createAct({
      workspaceId: data.workspace.id,
      label,
      myComfort: "curious",
    });
    setActs(combineBuiltInAndSavedActs(result.acts, data.workspace.id));
    return result.act;
  }

  async function submit(decisions: ReplyDecisionPayload[], note: string) {
    setSubmitting(true);
    setSubmitError("");
    try {
      const result = await submitReviewToken({
        token,
        workspaceId: data.workspace.id,
        decisions,
        note,
      });
      if (navigator.vibrate) navigator.vibrate(8);
      onSubmitted(result.request);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Couldn't send this reply.");
      setSubmitting(false);
    }
  }

  const closed = !["pending", "sent"].includes(request.status);

  return (
    <div className="review-stage">
      <section className="card p-5">
        <p className="text-xs uppercase tracking-[0.14em] text-ink-3">
          {request.requesterName || "Partner"} to you
        </p>
        <h1 className="mt-2 font-display text-display-lg italic leading-tight text-ink">
          {request.categories.length ? request.categories.join(", ") : "Ask"}
        </h1>
        <div className="mt-4 flex flex-wrap gap-1.5">
          <span className="chip">{request.timing}</span>
          <span className="chip">Filming: {request.filming}</span>
        </div>
        {request.note && (
          <p className="mt-4 text-sm leading-relaxed text-ink-2">{request.note}</p>
        )}
      </section>

      {closed ? (
        <ErrorState
          title="Already answered"
          body="This Ask is no longer waiting for a reply."
          action={<Link href="/sexboard" className="btn-ghost">Open Sexboard</Link>}
        />
      ) : (
        <AskReplyForm
          requestedActs={request.categories}
          requestedTiming={request.timing}
          acts={acts}
          submitting={submitting}
          error={submitError}
          onCreateAct={createCounterAct}
          onSubmit={submit}
        />
      )}
    </div>
  );
}
