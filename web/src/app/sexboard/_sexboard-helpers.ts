/**
 * Pure helpers extracted from sexboard/page.tsx (H-2 split).
 *
 * Each function here is total over its arguments — no React state, no
 * window/document access, no IO. Co-located with page.tsx because they
 * are sexboard-specific (request status labels, kink-response filtering,
 * timing-string formatting, etc.). Component code that pulls in the
 * sexboard's `LoadState` / `HandoffItem` shapes stays in page.tsx.
 */

import type {
  BlindReveal,
  FantasyBacklogResponse,
  KinkIdea,
  RequestRecord,
  Workspace,
} from "@/lib/types";
import { currentTimingLabel as currentRequestTimingLabel } from "@/lib/request-state";
import { normalizeEmail } from "@/lib/workspace";

export {
  currentTimingLabel,
  hasPendingRequestCounter,
  isApprovedSexActRequest,
  isApprovedSexActStale,
  isStalePendingAsk,
  requestCounterItems,
  timingCopyForRequest,
} from "@/lib/request-state";

export function preferredGreetingName(...values: Array<string | undefined | null>) {
  for (const value of values) {
    const name = String(value || "").trim();
    if (!name || name.toLowerCase() === "you") continue;
    return name;
  }
  return "there";
}

export function emailGreetingName(email: string) {
  return String(email || "").split("@")[0]?.trim() || "";
}

export function hasJoinedPartner(workspace: Workspace, myEmail: string): boolean {
  const me = (myEmail || "").toLowerCase();
  return (workspace.members || []).some((member) => {
    return member.status === "active" && (member.email || "").toLowerCase() !== me;
  });
}

export function approvedRequestBody(request: RequestRecord): string {
  return `Approved for ${currentRequestTimingLabel(request).toLowerCase()}.`;
}

export function blindRevealHasTwoAnswers(reveal: BlindReveal): boolean {
  if (reveal.status === "revealed") return true;
  if (reveal.mySubmitted && reveal.partnerSubmitted) return true;
  return reveal.submittedCount >= 2;
}

export function emptyFantasy(workspaceId: string): FantasyBacklogResponse {
  return { workspaceId, reactionCatalog: [], ideas: [], graveyard: [] };
}

export function unansweredKinksFor(
  ideas: KinkIdea[],
  email: string,
  direction: "from-partner" | "from-me",
): KinkIdea[] {
  const me = normalizeEmail(email);
  if (!me) return [];
  return [...(ideas || [])]
    .filter((idea) => {
      const author = normalizeEmail(idea.addedByEmail);
      if (direction === "from-partner" && author === me) return false;
      if (direction === "from-me" && author !== me) return false;
      return direction === "from-partner"
        ? !hasKinkResponseFrom(idea, me)
        : !hasPartnerKinkResponse(idea, me);
    })
    .sort((a, b) => safeDateMs(a.createdAt || a.updatedAt) - safeDateMs(b.createdAt || b.updatedAt));
}

export function safeDateMs(value: string): number {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : 0;
}

export function hasKinkResponseFrom(idea: KinkIdea, email: string): boolean {
  const actor = normalizeEmail(email);
  if (!actor) return false;
  if ((idea.statusHistory || []).some((entry) => normalizeEmail(entry.email) === actor)) return true;
  if ((idea.reactions || []).some((reaction) => normalizeEmail(reaction.by) === actor)) return true;
  if ((idea.comments || []).some((comment) => normalizeEmail(comment.email) === actor)) return true;
  return normalizeEmail(idea.statusByEmail) === actor;
}

export function hasPartnerKinkResponse(idea: KinkIdea, authorEmail: string): boolean {
  const author = normalizeEmail(authorEmail);
  if (!author) return false;
  if ((idea.statusHistory || []).some((entry) => {
    const email = normalizeEmail(entry.email);
    return email && email !== author;
  })) return true;
  if ((idea.reactions || []).some((reaction) => {
    const email = normalizeEmail(reaction.by);
    return email && email !== author;
  })) return true;
  if ((idea.comments || []).some((comment) => {
    const email = normalizeEmail(comment.email);
    return email && email !== author;
  })) return true;
  const statusBy = normalizeEmail(idea.statusByEmail);
  return Boolean(statusBy && statusBy !== author);
}

export function kinkReviewHref(ideas: KinkIdea[]): string {
  const [first] = ideas;
  return first?.id ? `/inspiration/kink?id=${encodeURIComponent(first.id)}&activity=1` : "/inspiration";
}

export function sharedKinksHref(): string {
  return "/inspiration?section=shared-kinks#shared-kinks";
}

export function friendlyDateLabel(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "recently";
  const diff = Date.now() - time;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) {
    const minutes = Math.max(1, Math.round(diff / 60_000));
    return `${minutes}m ago`;
  }
  if (diff < 86_400_000) {
    const hours = Math.max(1, Math.round(diff / 3_600_000));
    return `${hours}h ago`;
  }
  if (diff < 604_800_000) {
    const days = Math.max(1, Math.round(diff / 86_400_000));
    return `${days}d ago`;
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(time));
}

export function scheduledLabel(value: string) {
  const time = new Date(value || "").getTime();
  if (!Number.isFinite(time)) return "soon";
  const diff = time - Date.now();
  if (diff <= 0) return "now";
  if (diff < 60_000) return "in under 1m";
  if (diff < 3_600_000) return `in ${Math.ceil(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.ceil(diff / 3_600_000)}h`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(time));
}

export function compactScheduledLabel(label: string) {
  return label.replace(/^in\s+/i, "");
}

export function statusLabel(status: RequestRecord["status"]): string {
  switch (status) {
    case "pending":   return "pending";
    case "sent":      return "sent";
    case "reviewed":  return "reviewed";
    case "on_deck":   return "on deck";
    case "completed": return "done";
    case "expired":   return "expired";
    case "archived":  return "archived";
    case "draft":     return "draft";
    default:          return status;
  }
}

export function requestTitle(request: RequestRecord): string {
  if (request.categories.length === 0) return "Ask";
  if (request.categories.length === 1) return request.categories[0];
  return `${request.categories[0]} +${request.categories.length - 1}`;
}
