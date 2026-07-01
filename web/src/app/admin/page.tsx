"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import ScreenHeader from "@/components/ScreenHeader";
import { EmptyState, ErrorState, SkeletonList } from "@/components/States";
import {
  ApiFailureError,
  ApiUnauthorizedError,
  deleteAdminFeedback,
  getAdminDashboard,
} from "@/lib/api";
import type {
  AdminDashboardResponse,
  AdminFeedbackItem,
  AdminSystemServiceStatus,
  FeedbackSentiment,
} from "@/lib/types";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "forbidden" }
  | { kind: "unauthorized" }
  | { kind: "ready"; dashboard: AdminDashboardResponse };

type AdminStatKey = "profilesTotal" | "activeMembers" | "activeWorkspaces" | "feedbackTotal";
type FeedbackFilter = "all" | FeedbackSentiment | "contactable";

const STAT_CARDS: Array<{ key: AdminStatKey; label: string }> = [
  { key: "profilesTotal", label: "Profiles" },
  { key: "activeMembers", label: "Active members" },
  { key: "activeWorkspaces", label: "Active spaces" },
  { key: "feedbackTotal", label: "Feedback" },
];
const FEEDBACK_FILTERS: Array<{ id: FeedbackFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "negative", label: "Issues" },
  { id: "neutral", label: "Ideas" },
  { id: "positive", label: "Good" },
  { id: "contactable", label: "Contact" },
];

async function loadDashboardState(): Promise<LoadState> {
  try {
    const dashboard = await getAdminDashboard();
    return { kind: "ready", dashboard };
  } catch (error) {
    if (error instanceof ApiUnauthorizedError) {
      return { kind: "unauthorized" };
    }
    if (error instanceof ApiFailureError && error.status === 403) {
      return { kind: "forbidden" };
    }
    return { kind: "error", message: error instanceof Error ? error.message : "Couldn't load admin." };
  }
}

export default function AdminPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [deletingFeedbackId, setDeletingFeedbackId] = useState("");
  const [actionMessage, setActionMessage] = useState("");

  async function refresh() {
    setActionMessage("");
    setState({ kind: "loading" });
    setState(await loadDashboardState());
  }

  async function deleteFeedback(item: AdminFeedbackItem) {
    if (!window.confirm("Delete this feedback item?")) return;
    setDeletingFeedbackId(item.id);
    setActionMessage("");
    try {
      await deleteAdminFeedback({ workspaceId: item.workspaceId, feedbackId: item.id });
      setState(await loadDashboardState());
      setActionMessage("Feedback deleted.");
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Couldn't delete feedback.");
    } finally {
      setDeletingFeedbackId("");
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const nextState = await loadDashboardState();
      if (!cancelled) setState(nextState);
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <AppShell hideTabBar>
      <ScreenHeader
        eyebrow={<Link href="/space" className="text-ink-3">‹ Space</Link>}
        showBrand={false}
        title="Admin"
        subtitle={state.kind === "ready" ? `Updated ${formatDateTime(state.dashboard.generatedAt)}` : "Feedback and product stats."}
        trailing={
          state.kind === "ready"
            ? <button type="button" className="btn-ghost pressable" onClick={refresh}>Refresh</button>
            : null
        }
      />
      <Body
        state={state}
        actionMessage={actionMessage}
        deletingFeedbackId={deletingFeedbackId}
        onDeleteFeedback={deleteFeedback}
      />
    </AppShell>
  );
}

function Body({
  state,
  actionMessage,
  deletingFeedbackId,
  onDeleteFeedback,
}: {
  state: LoadState;
  actionMessage: string;
  deletingFeedbackId: string;
  onDeleteFeedback: (item: AdminFeedbackItem) => void;
}) {
  const [feedbackFilter, setFeedbackFilter] = useState<FeedbackFilter>("all");

  if (state.kind === "loading") return <SkeletonList count={4} />;
  if (state.kind === "unauthorized") {
    return (
      <ErrorState
        title="Sign in first"
        body="Use the admin Google account to view this dashboard."
        action={<a className="btn-primary pressable" href="/api/auth/google?returnTo=%2Fadmin">Sign in</a>}
      />
    );
  }
  if (state.kind === "forbidden") {
    return <ErrorState title="Admin only" body="This dashboard is restricted to the site owner." />;
  }
  if (state.kind === "error") return <ErrorState title="Couldn't load Admin" body={state.message} />;

  const dashboard = state.dashboard;
  const filteredFeedback = filterFeedback(dashboard.feedback, feedbackFilter);
  return (
    <div className="admin-stage">
      <StatsGrid dashboard={dashboard} />
      <PrivacyPanel />
      <OperationsPanel dashboard={dashboard} />
      <AIPanel dashboard={dashboard} />
      <SystemStatusPanel dashboard={dashboard} />
      <FeedbackPanel
        dashboard={dashboard}
        feedback={filteredFeedback}
        filter={feedbackFilter}
        onFilter={setFeedbackFilter}
        actionMessage={actionMessage}
        deletingFeedbackId={deletingFeedbackId}
        onDeleteFeedback={onDeleteFeedback}
      />
      <UserPanel dashboard={dashboard} />
    </div>
  );
}

function StatsGrid({ dashboard }: { dashboard: AdminDashboardResponse }) {
  const stats = dashboard.stats;
  return (
    <section className="admin-section" aria-label="Admin stats">
      <div className="admin-section-head">
        <h2>Overview</h2>
        <span>last 7 days tracked</span>
      </div>
      <div className="admin-kpi-grid">
        {STAT_CARDS.map((card) => {
          const recent = recentLabel(card.key, stats);
          return (
            <article key={card.key} className="admin-kpi-card">
              <span>{formatNumber(stats[card.key])}</span>
              <p>{card.label}</p>
              <em>{recent}</em>
            </article>
          );
        })}
      </div>
      <div className="admin-pulse-grid">
        <Metric label="Activation" value={`${stats.workspaceActivationRate}%`} sub={`${stats.activeWorkspaces}/${stats.workspacesTotal} spaces active`} />
        <Metric label="Contactable" value={`${stats.contactableFeedbackRate}%`} sub={`${stats.mayContactFeedback} feedback items`} />
        <Metric label="Issue rate" value={`${stats.issueFeedbackRate}%`} sub={`${stats.feedbackBySentiment.negative} issues logged`} tone={stats.issueFeedbackRate > 30 ? "negative" : "neutral"} />
        <Metric label="Pending invites" value={stats.pendingInvites} sub={`${stats.invitedMembers} invited members`} />
      </div>
    </section>
  );
}

function PrivacyPanel() {
  return (
    <section className="admin-privacy-card" aria-label="Privacy mode">
      <span className="admin-privacy-copy">
        <strong>Identifiers masked</strong>
        <em>User emails and space names stay partially hidden.</em>
      </span>
    </section>
  );
}

function OperationsPanel({ dashboard }: { dashboard: AdminDashboardResponse }) {
  const stats = dashboard.stats;
  return (
    <section className="admin-section" aria-label="Operational state">
      <div className="admin-section-head">
        <h2>Ops</h2>
        <span>{formatDateTime(dashboard.generatedAt)}</span>
      </div>
      <div className="admin-ops-grid">
        <StatusPanel
          title="Access"
          value="Owner-only"
          detail={dashboard.adminAccess}
          tone="secure"
        />
        <StatusPanel
          title="Members"
          value={`${formatNumber(stats.activeMembers)} active`}
          detail={`${stats.invitedMembers} invited · ${stats.removedMembers} removed`}
        />
        <StatusPanel
          title="Spaces"
          value={`${formatNumber(stats.activeWorkspaces)} active`}
          detail={`${stats.deletionPendingWorkspaces} deletion pending`}
          tone={stats.deletionPendingWorkspaces ? "warning" : "secure"}
        />
      </div>
    </section>
  );
}

function AIPanel({ dashboard }: { dashboard: AdminDashboardResponse }) {
  const ai = dashboard.ai;
  const hour = ai.currentHour;
  const today = ai.today;
  const latest = ai.recent[0];
  const enabledRoutes = ai.routes.filter((route) => route.enabled).length;
  const mode = !ai.configured ? "Not configured" : ai.enabled ? "Live capped" : "Gated off";
  const modeDetail = ai.configured
    ? `${ai.model || "Default model"}${ai.baseHost ? ` via ${ai.baseHost}` : ""}`
    : "Set provider secrets before enabling.";

  return (
    <section className="admin-section" aria-label="AI usage">
      <div className="admin-section-head">
        <h2>AI</h2>
        <span>{ai.enabled ? "AI host guarded" : "AI host protected"}</span>
      </div>
      <div className="admin-ops-grid">
        <StatusPanel
          title="Mode"
          value={mode}
          detail={modeDetail}
          tone={ai.configured && ai.enabled ? "secure" : "warning"}
        />
        <StatusPanel
          title="Global cap"
          value={`${ai.limits.perMinute}/min`}
          detail={`${ai.limits.perHour}/hour across every user`}
          tone="secure"
        />
        <StatusPanel
          title="Routes"
          value={`${enabledRoutes}/${ai.routes.length} on`}
          detail="Dormant helpers stay off by default."
          tone={enabledRoutes > 2 ? "warning" : "secure"}
        />
      </div>
      <div className="admin-pulse-grid">
        <Metric label="This hour" value={formatNumber(hour.total)} sub={`${hour.ok} ok · ${hour.blocked} blocked`} tone={hour.error || hour.blocked ? "negative" : "neutral"} />
        <Metric label="Today" value={formatNumber(today.total)} sub={`${today.ok} ok · ${today.error} errors`} tone={today.error ? "negative" : "neutral"} />
        <Metric label="Avg latency" value={formatMs(hour.avgLatencyMs)} sub={`max ${formatMs(hour.maxLatencyMs)}`} />
        <Metric label="Latest" value={latest ? latest.outcome : "none"} sub={latest ? latestAiLabel(latest) : "no calls recorded"} tone={latest?.outcome === "error" ? "negative" : "neutral"} />
      </div>
      <div className="admin-analytics-grid">
        <article className="admin-analytics-card">
          <h3>Route gates</h3>
          {ai.routes.map((route) => (
            <div key={route.id} className="admin-route-row">
              <span>{route.label}</span>
              <strong>{route.enabled ? "On" : "Off"}</strong>
            </div>
          ))}
        </article>
        <article className="admin-analytics-card">
          <h3>Top routes</h3>
          {hour.features.length ? hour.features.slice(0, 6).map((feature) => (
            <div key={feature.id} className="admin-route-row">
              <span>{featureLabel(feature.id)}</span>
              <strong>{feature.total}</strong>
            </div>
          )) : (
            <p>No AI calls this hour.</p>
          )}
        </article>
      </div>
    </section>
  );
}

function SystemStatusPanel({ dashboard }: { dashboard: AdminDashboardResponse }) {
  const status = dashboard.systemStatus;
  const orderedServices = [...status.services].sort((a, b) => statusRank(a.status) - statusRank(b.status));
  return (
    <section className="admin-section" aria-label="System status">
      <div className="admin-section-head">
        <h2>Status</h2>
        <span>{status.ok ? "critical systems up" : "critical issue"}</span>
      </div>
      <div className="admin-status-strip" aria-label="Status summary">
        <Metric label="Down" value={status.summary.down || 0} sub="critical or service" tone={status.summary.down ? "negative" : "neutral"} />
        <Metric label="Warnings" value={status.summary.warning || 0} sub="needs attention" tone={status.summary.warning ? "negative" : "neutral"} />
        <Metric label="Healthy" value={status.summary.ok || 0} sub="checks passing" />
      </div>
      <div className="admin-service-list">
        {orderedServices.map((service) => (
          <article key={service.id} className={`admin-service-row is-${service.status}`}>
            <span className="admin-service-dot" aria-hidden="true" />
            <span className="admin-service-copy">
              <strong>{service.label}</strong>
              <em>{service.detail}</em>
            </span>
            <small>{statusLabel(service.status)}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  sub?: string;
  tone?: "neutral" | "negative";
}) {
  return (
    <span className={`admin-metric is-${tone}`}>
      <strong>{value}</strong>
      <em>{label}</em>
      {sub && <small>{sub}</small>}
    </span>
  );
}

function StatusPanel({
  title,
  value,
  detail,
  tone = "neutral",
}: {
  title: string;
  value: string;
  detail: string;
  tone?: "neutral" | "secure" | "warning";
}) {
  return (
    <article className={`admin-status-panel is-${tone}`}>
      <span>{title}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function FeedbackPanel({
  dashboard,
  feedback,
  filter,
  onFilter,
  actionMessage,
  deletingFeedbackId,
  onDeleteFeedback,
}: {
  dashboard: AdminDashboardResponse;
  feedback: AdminFeedbackItem[];
  filter: FeedbackFilter;
  onFilter: (filter: FeedbackFilter) => void;
  actionMessage: string;
  deletingFeedbackId: string;
  onDeleteFeedback: (item: AdminFeedbackItem) => void;
}) {
  return (
    <section className="admin-section" aria-label="Recent feedback">
      <div className="admin-section-head">
        <h2>Feedback</h2>
        <span>{dashboard.feedback.length} total</span>
      </div>
      <FeedbackAnalytics dashboard={dashboard} />
      <div className="admin-filter-tabs" role="tablist" aria-label="Feedback filter">
        {FEEDBACK_FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            className={`admin-filter-button pressable ${filter === item.id ? "is-active" : ""}`}
            onClick={() => onFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {actionMessage && <p className="admin-action-note">{actionMessage}</p>}
      {!feedback.length ? (
        <EmptyState title="No matching feedback." body="Try a different filter." />
      ) : (
        <div className="admin-feedback-list">
          {feedback.map((item) => (
            <article key={item.id} className="admin-feedback-card">
              <div className="admin-feedback-meta">
                <span className={`admin-feedback-sentiment is-${item.sentiment}`}>{labelForSentiment(item.sentiment)}</span>
                <span>{formatDateTime(item.at)}</span>
              </div>
              <p>{item.message}</p>
              <div className="admin-feedback-foot">
                <span>{feedbackPersonLabel(item)}</span>
                <span>{workspaceLabel(item.workspaceName, item.workspaceId)}</span>
                {item.route && <span>{item.route}</span>}
                {item.mayContact && <strong>May contact</strong>}
              </div>
              <div className="admin-feedback-actions">
                <button
                  type="button"
                  className="admin-delete-button pressable"
                  disabled={deletingFeedbackId === item.id}
                  onClick={() => onDeleteFeedback(item)}
                >
                  {deletingFeedbackId === item.id ? "Deleting" : "Delete"}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function FeedbackAnalytics({ dashboard }: { dashboard: AdminDashboardResponse }) {
  const stats = dashboard.stats;
  const sentimentTotal = Math.max(1, stats.feedbackTotal);
  const topRoutes = stats.topFeedbackRoutes;
  return (
    <div className="admin-analytics-grid">
      <article className="admin-analytics-card">
        <h3>Sentiment mix</h3>
        <PercentMeter label="Good" value={stats.feedbackBySentiment.positive} total={sentimentTotal} tone="positive" />
        <PercentMeter label="Ideas" value={stats.feedbackBySentiment.neutral} total={sentimentTotal} tone="neutral" />
        <PercentMeter label="Issues" value={stats.feedbackBySentiment.negative} total={sentimentTotal} tone="negative" />
      </article>
      <article className="admin-analytics-card">
        <h3>Top surfaces</h3>
        {topRoutes.length ? topRoutes.map((item) => (
          <div key={item.route} className="admin-route-row">
            <span>{item.route}</span>
            <strong>{item.count}</strong>
          </div>
        )) : (
          <p>No route data yet.</p>
        )}
      </article>
    </div>
  );
}

function PercentMeter({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: "positive" | "neutral" | "negative";
}) {
  const percent = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className={`admin-percent-row is-${tone}`}>
      <span>
        <em>{label}</em>
        <strong>{value}</strong>
      </span>
      <div className="admin-percent-track" aria-hidden="true">
        <i style={{ width: `${Math.max(value ? 8 : 0, percent)}%` }} />
      </div>
    </div>
  );
}

function UserPanel({ dashboard }: { dashboard: AdminDashboardResponse }) {
  const stats = dashboard.stats;
  return (
    <section className="admin-section" aria-label="User stats">
      <div className="admin-section-head">
        <h2>Users</h2>
        <span>{dashboard.recentProfiles.length} recent profiles</span>
      </div>
      <div className="admin-status-strip" aria-label="User status counts">
        <Metric label="Profiles 7d" value={stats.profilesLast7d} sub="new sign-ins" />
        <Metric label="Spaces 7d" value={stats.workspacesLast7d} sub="created rooms" />
        <Metric label="Active members" value={stats.memberStatusCounts.active || 0} sub="across active spaces" />
      </div>
      <div className="admin-split-grid">
        <div className="admin-table-card">
          <h3>Recent profiles</h3>
          {dashboard.recentProfiles.length ? dashboard.recentProfiles.map((profile) => (
            <div key={profile.id} className="admin-row">
              <span>
                <strong>Profile</strong>
                <em>{maskEmail(profile.email)}</em>
                {profile.workspaceNames.length > 0 && (
                  <small>{profile.workspaceNames.length} space{profile.workspaceNames.length === 1 ? "" : "s"}</small>
                )}
              </span>
              <small>{formatDate(profile.createdAt)}</small>
            </div>
          )) : <p className="admin-empty-copy">No profiles yet.</p>}
        </div>
        <div className="admin-table-card">
          <h3>Spaces</h3>
          {dashboard.workspaces.length ? dashboard.workspaces.map((workspace) => (
            <div key={workspace.id} className="admin-row">
              <span>
                <strong>{workspaceLabel(workspace.name, workspace.id)}</strong>
                <em>{workspace.status} · {formatDate(workspace.updatedAt || workspace.createdAt)}</em>
              </span>
              <small>{workspace.members.active} active</small>
            </div>
          )) : <p className="admin-empty-copy">No spaces yet.</p>}
        </div>
      </div>
    </section>
  );
}

function labelForSentiment(value: AdminFeedbackItem["sentiment"]) {
  if (value === "positive") return "Good";
  if (value === "negative") return "Issue";
  return "Idea";
}

function filterFeedback(feedback: AdminFeedbackItem[], filter: FeedbackFilter) {
  if (filter === "all") return feedback;
  if (filter === "contactable") return feedback.filter((item) => item.mayContact);
  return feedback.filter((item) => item.sentiment === filter);
}

function statusRank(status: AdminSystemServiceStatus) {
  if (status === "down") return 0;
  if (status === "warning") return 1;
  if (status === "ok") return 2;
  return 3;
}

function statusLabel(status: AdminSystemServiceStatus) {
  if (status === "ok") return "Up";
  if (status === "warning") return "Check";
  if (status === "down") return "Down";
  return "Off";
}

function recentLabel(key: AdminStatKey, stats: AdminDashboardResponse["stats"]) {
  if (key === "profilesTotal") return `+${stats.profilesLast7d} in 7d`;
  if (key === "activeWorkspaces") return `+${stats.workspacesLast7d} in 7d`;
  if (key === "feedbackTotal") return `+${stats.feedbackLast7d} in 7d`;
  return "unique active emails";
}

function feedbackPersonLabel(item: AdminFeedbackItem) {
  return item.email ? maskEmail(item.email) : "Private user";
}

function workspaceLabel(name: string, id: string) {
  return `Space ${shortId(id || name)}`;
}

function shortId(value: string) {
  return (value || "unknown").replace(/[^a-z0-9]/gi, "").slice(-6).padStart(6, "0");
}

function featureLabel(value: string) {
  return value
    .split(/[:-]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ") || "Unknown";
}

function latestAiLabel(item: AdminDashboardResponse["ai"]["recent"][number]) {
  const when = formatDateTime(item.at);
  const reason = item.reason && item.reason !== "ok" ? ` · ${item.reason}` : "";
  return `${featureLabel(item.feature)} · ${when}${reason}`;
}

function formatMs(value: number) {
  const ms = Math.max(0, Math.round(Number(value) || 0));
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
  return `${ms}ms`;
}

function maskEmail(email: string) {
  const [local = "", domain = ""] = email.split("@");
  if (!email || !domain) return "Private user";
  const localHead = local.slice(0, 1) || "*";
  const domainParts = domain.split(".");
  const domainName = domainParts[0] || "";
  const domainSuffix = domainParts.slice(1).join(".");
  const maskedDomain = domainName ? `${domainName.slice(0, 1)}***` : "***";
  return `${localHead}***@${maskedDomain}${domainSuffix ? `.${domainSuffix}` : ""}`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en").format(value);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(date);
}
