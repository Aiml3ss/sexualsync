import { test, expect } from "@playwright/test";

const workspace = {
  id: "mobile-room",
  name: "Mobile Room",
  displayName: "Alex & Jordan",
  createdAt: "2026-05-23T00:00:00.000Z",
  updatedAt: "2026-05-23T00:00:00.000Z",
  status: "active",
  productMode: "couples",
  settings: {},
  deletion: null,
  members: [
    { email: "alex@example.test", displayName: "Alex", role: "owner", status: "active", joinedAt: "2026-05-23T00:00:00.000Z" },
    { email: "jordan@example.test", displayName: "Jordan", role: "partner", status: "active", joinedAt: "2026-05-23T00:00:00.000Z" },
  ],
};

const auth = {
  email: "alex@example.test",
  person: "Alex",
  isKnownCoupleMember: true,
  provider: "test",
};

const request = {
  id: "req-1",
  workspaceId: workspace.id,
  status: "sent",
  requester: "Jordan",
  reviewer: "Alex",
  requesterEmail: "jordan@example.test",
  reviewerEmail: "alex@example.test",
  requesterName: "Jordan",
  reviewerName: "Alex",
  categories: ["Kiss"],
  timing: "Tonight",
  filming: "No",
  decisions: [],
  counters: [],
  boundaryConflicts: [],
  note: "Slow and close.",
  feedback: "",
  createdAt: "2026-05-23T00:00:00.000Z",
  updatedAt: "2026-05-23T00:05:00.000Z",
  sentAt: "2026-05-23T00:05:00.000Z",
};

const counterDecisions = [
  {
    label: "Counter option 1",
    decision: "Counter",
    counter: "💆 Sensual massage",
    counterActId: "built-in-0-sensual-massage",
    note: "",
    targetType: "act",
    actId: "",
  },
  {
    label: "Timing: Tonight",
    decision: "Counter",
    counter: "Tomorrow",
    counterActId: "",
    note: "",
    targetType: "timing",
    actId: "",
  },
];

const counteredRequest = {
  ...request,
  status: "reviewed",
  requester: "Alex",
  reviewer: "Jordan",
  requesterEmail: "alex@example.test",
  reviewerEmail: "jordan@example.test",
  requesterName: "Alex",
  reviewerName: "Jordan",
  decisions: counterDecisions,
  counters: counterDecisions,
  updatedAt: "2026-05-23T00:20:00.000Z",
  reviewedAt: "2026-05-23T00:20:00.000Z",
};

function isoForLocalDaysAgo(days, hour = 20, minute = 0) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

const kink = {
  id: "kink-1",
  workspaceId: workspace.id,
  text: "Try the hotel window fantasy.",
  addedByEmail: "jordan@example.test",
  addedByName: "Jordan",
  note: "",
  notes: {},
  comments: [],
  reactions: [],
  statusHistory: [],
  createdAt: "2026-05-23T00:00:00.000Z",
  updatedAt: "2026-05-23T00:00:00.000Z",
};

const shelfItem = {
  id: "shelf-1",
  type: "story",
  source: "url",
  sourceLabel: "Source",
  sourceUrl: "https://example.test/hot",
  embedUrl: "",
  posterUrl: "",
  videoHdUrl: "",
  videoSdUrl: "",
  passageText: "",
  title: "Saved source",
  addedByEmail: "jordan@example.test",
  addedByName: "Jordan",
  addedAt: "2026-05-23T00:00:00.000Z",
  reactions: {},
};

const shelfReactionCatalog = [
  { id: "think", emoji: "👀", label: "Curious", tone: "maybe", caption: "{name} is curious." },
  { id: "fire", emoji: "🔥", label: "Hot", tone: "yes", caption: "{name} says hot." },
  { id: "pass", emoji: "✕", label: "Pass", tone: "pass", caption: "Not {name}'s vibe." },
];

const savedLibraryAct = {
  id: "act-slow-undressing",
  workspaceId: workspace.id,
  label: "Slow undressing",
  icon: "",
  tags: ["soft"],
  comfort: {},
  source: "custom",
  addedByEmail: "alex@example.test",
  addedByName: "Alex",
  approvedByEmail: "",
  approvedByName: "",
  createdAt: "2026-05-23T00:00:00.000Z",
  updatedAt: "2026-05-23T00:00:00.000Z",
};

const activityResponse = {
  workspaceId: workspace.id,
  unreadTotal: 1,
  unreadByResource: { "request-board": 1 },
  readState: { all: "", resources: {} },
  items: [
    {
      id: "ask-activity",
      workspaceId: workspace.id,
      resource: "request-board",
      resourceLabel: "Sexboard",
      action: "sent",
      label: "New Ask landed",
      entityId: "req-1",
      actorEmail: "jordan@example.test",
      actorName: "Jordan",
      at: "2026-05-23T00:10:00.000Z",
      passive: false,
      unread: true,
    },
    {
      id: "shelf:revealed:shelf-1:partner:2026-05-23",
      workspaceId: workspace.id,
      resource: "shelf",
      resourceLabel: "Shelf",
      action: "revealed",
      label: "Opened a Shelf save",
      entityId: "shelf-1",
      actorEmail: "jordan@example.test",
      actorName: "Jordan",
      at: "2026-05-23T00:09:00.000Z",
      passive: true,
      unread: false,
    },
    {
      id: "pile-drop-2",
      workspaceId: workspace.id,
      resource: "pile",
      resourceLabel: "Pile",
      action: "dropped",
      label: "Pile changed",
      entityId: "",
      actorEmail: "jordan@example.test",
      actorName: "Jordan",
      at: "2026-05-23T00:08:00.000Z",
      passive: false,
      unread: false,
    },
    {
      id: "pile-drop-1",
      workspaceId: workspace.id,
      resource: "pile",
      resourceLabel: "Pile",
      action: "undropped",
      label: "Pile changed",
      entityId: "",
      actorEmail: "jordan@example.test",
      actorName: "Jordan",
      at: "2026-05-23T00:07:00.000Z",
      passive: false,
      unread: false,
    },
  ],
};

const chatSeedMessages = [
  {
    id: "chat-1",
    seq: 1,
    email: "jordan@example.test",
    name: "Jordan",
    text: "Hold this message",
    at: "2026-05-23T00:12:00.000Z",
    reactions: [],
  },
];

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function recomputeActivityUnread(activity) {
  activity.unreadTotal = 0;
  activity.unreadByResource = {};
  for (const item of activity.items || []) {
    if (!item.unread) continue;
    activity.unreadTotal += 1;
    activity.unreadByResource[item.resource] = (activity.unreadByResource[item.resource] || 0) + 1;
  }
  return activity;
}

const activePile = {
  revealAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  startedAt: "2026-05-23T00:00:00.000Z",
  startedByEmail: "alex@example.test",
  isRevealed: false,
  mine: ["Kiss"],
  maxDropCount: 3,
  targetDropCount: 3,
  targetMaxDropCount: 6,
  actPoolCount: 19,
  counts: { Kiss: 1 },
  partnerHasDropped: true,
  partnerLabels: null,
  overlap: null,
  onlyMine: null,
  onlyTheirs: null,
  revealNarration: "",
};

const revealedPile = {
  ...activePile,
  isRevealed: true,
  mine: ["🍆 Penetration", "💋 Mutual oral", "⛓️ Light restraint", "Dirty talk", "Slow positions", "Couch", "Toys", "Standing"],
  partnerLabels: {
    "jordan@example.test": ["🍆 Penetration", "Sensual massage", "From behind", "On Top", "Roleplay", "Face sitting", "Cuddling", "Cowgirl"],
  },
  overlap: ["🍆 Penetration"],
  onlyMine: ["💋 Mutual oral", "⛓️ Light restraint", "Dirty talk", "Slow positions", "Couch", "Toys", "Standing"],
  onlyTheirs: ["Sensual massage", "From behind", "On Top", "Roleplay", "Face sitting", "Cuddling", "Cowgirl"],
  revealNarration: "Tonight Alex penetrates Jordan.",
};

const archivedBlindReveal = {
  id: "blind-closed-1",
  workspaceId: workspace.id,
  prompt: "What should we admit after midnight?",
  status: "archived",
  createdAt: "2026-05-23T00:00:00.000Z",
  updatedAt: "2026-05-23T00:12:00.000Z",
  revealedAt: "2026-05-23T00:08:00.000Z",
  archivedAt: "2026-05-23T00:12:00.000Z",
  requiredCount: 2,
  submittedCount: 2,
  mySubmitted: true,
  partnerSubmitted: true,
  myEntry: {
    email: "alex@example.test",
    name: "Alex",
    text: "I want the hotel fantasy again.",
    promotedIdeaId: "",
    createdAt: "2026-05-23T00:01:00.000Z",
    updatedAt: "2026-05-23T00:01:00.000Z",
  },
  entries: [
    {
      email: "alex@example.test",
      name: "Alex",
      text: "I want the hotel fantasy again.",
      promotedIdeaId: "",
      createdAt: "2026-05-23T00:01:00.000Z",
      updatedAt: "2026-05-23T00:01:00.000Z",
    },
    {
      email: "jordan@example.test",
      name: "Jordan",
      text: "I want the same thing, slower.",
      promotedIdeaId: "",
      createdAt: "2026-05-23T00:02:00.000Z",
      updatedAt: "2026-05-23T00:02:00.000Z",
    },
  ],
};

const healthResponse = {
  workspaceId: workspace.id,
  range: { id: "30d", label: "Last 30 days", from: "2026-04-24T00:00:00.000Z", to: "2026-05-23T23:59:59.000Z" },
  totals: { sexEvents: 9, sexActs: 26, uniqueActs: 12, askEvents: 5, pileEvents: 4 },
  rhythm: [
    { date: "2026-05-02", sexEvents: 1, sexActs: 2, askEvents: 1, pileEvents: 0 },
    { date: "2026-05-07", sexEvents: 2, sexActs: 6, askEvents: 1, pileEvents: 1 },
    { date: "2026-05-13", sexEvents: 1, sexActs: 3, askEvents: 0, pileEvents: 1 },
    { date: "2026-05-18", sexEvents: 3, sexActs: 9, askEvents: 2, pileEvents: 1 },
    { date: "2026-05-22", sexEvents: 2, sexActs: 6, askEvents: 1, pileEvents: 1 },
  ],
  topActs: [
    { label: "Slow kissing", count: 6, askCount: 3, pileCount: 3, firstSeenAt: "2026-05-02T22:10:00.000Z", lastSeenAt: "2026-05-22T22:10:00.000Z" },
    { label: "Shower sex", count: 5, askCount: 2, pileCount: 3, firstSeenAt: "2026-05-07T22:10:00.000Z", lastSeenAt: "2026-05-22T22:10:00.000Z" },
    { label: "Oral with eye contact", count: 4, askCount: 3, pileCount: 1, firstSeenAt: "2026-05-13T22:10:00.000Z", lastSeenAt: "2026-05-18T22:10:00.000Z" },
    { label: "Hands pinned over head", count: 3, askCount: 1, pileCount: 2, firstSeenAt: "2026-05-18T22:10:00.000Z", lastSeenAt: "2026-05-22T22:10:00.000Z" },
    { label: "Very long teasing name that should still truncate cleanly", count: 2, askCount: 2, pileCount: 0, firstSeenAt: "2026-05-18T22:10:00.000Z", lastSeenAt: "2026-05-18T22:10:00.000Z" },
  ],
  events: [
    { id: "ask:req-1", type: "ask", sourceId: "req-1", sourceHref: "/ask-detail?id=req-1", title: "Tonight after dinner", at: "2026-05-22T22:10:00.000Z", requester: "Jordan", acts: ["Slow kissing", "Shower sex", "Oral with eye contact", "Filming = yes"], actSummaries: [{ label: "Slow kissing", emoji: "💋" }, { label: "Shower sex", emoji: "🚿" }, { label: "Oral with eye contact", emoji: "👅" }, { label: "Filming = yes", emoji: "📹" }] },
    { id: "pile:pile-4", type: "pile", sourceId: "pile-4", sourceHref: "/games/pile", title: "Pile overlap", at: "2026-05-22T22:05:00.000Z", requester: "Both", acts: ["Slow kissing", "Shower sex", "Hands pinned over head"], actSummaries: [{ label: "Slow kissing", emoji: "💋" }, { label: "Shower sex", emoji: "🚿" }, { label: "Hands pinned over head", emoji: "⛓️" }] },
    { id: "ask:req-2", type: "ask", sourceId: "req-2", sourceHref: "/ask-detail?id=req-2", title: "Long source history title that needs graceful truncation on the narrow phone surface", at: "2026-05-18T23:30:00.000Z", requester: "Alex", acts: ["Slow kissing", "Hands pinned over head"], actSummaries: [{ label: "Slow kissing", emoji: "💋" }, { label: "Hands pinned over head", emoji: "⛓️" }] },
  ],
  insights: {
    daysSinceLast: 1,
    requesterSplit: [{ label: "Jordan", count: 3 }, { label: "Alex", count: 2 }],
    sourceSplit: [{ label: "Ask", count: 5 }, { label: "Pile", count: 4 }],
    newActs: [
      { label: "Shower sex", count: 1, askCount: 0, pileCount: 1, firstSeenAt: "2026-05-22T22:05:00.000Z", lastSeenAt: "2026-05-22T22:05:00.000Z" },
      { label: "Hands pinned over head", count: 1, askCount: 1, pileCount: 0, firstSeenAt: "2026-05-18T23:30:00.000Z", lastSeenAt: "2026-05-18T23:30:00.000Z" },
    ],
  },
};

async function mockApi(page, state = {}) {
  const activity = state.activity || cloneJson(activityResponse);
  state.activity = activity;

  // RoomEncryptionGate (web/src/components/RoomEncryptionGate.tsx) reauths on
  // launch: any protected route (/space, /sexboard, /games, …) redirects to
  // /api/auth/logout unless the browser session is already launch-authenticated.
  // Real sign-in sets the (non-HttpOnly) sxs-launch cookie in
  // functions/api/_app_session.js, which the gate consumes into this
  // sessionStorage flag (ss:auth:launch-ok — see web/src/lib/launch-auth.ts).
  // These specs navigate straight to protected routes without signing in, so
  // seed the flag to mirror a post-auth session; otherwise the gate bounces
  // every page to /signed-out and the content assertions never resolve.
  await page.addInitScript(() => {
    try {
      window.sessionStorage.setItem("ss:auth:launch-ok", "1");
    } catch {
      // sessionStorage can be blocked in some webviews; nothing else to do here.
    }
  });

  await page.route("**/api/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const pathname = requestUrl.pathname;
    const method = route.request().method();
    const json = (body, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

    if (requestUrl.hostname.endsWith("bellesa.co") && pathname.startsWith("/api/rest/v1/videos/")) {
      const id = pathname.split("/").filter(Boolean).pop();
      const video = state.bellesaVideos?.[id] || state.bellesaVideo;
      return video ? json(video) : json({ error: "Not found." }, 404);
    }

    if (pathname === "/api/auth/logout") {
      return route.fulfill({
        status: 303,
        headers: {
          location: "/signed-out",
          "set-cookie": "sxs-session=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax; HttpOnly",
        },
      });
    }
    if (pathname === "/api/auth/google") {
      state.googleAuthAttempts = (state.googleAuthAttempts || 0) + 1;
      return route.fulfill({
        status: 302,
        headers: { location: "/sexboard" },
      });
    }
    if (pathname === "/api/config") {
      return json({
        appVersion: "test",
        googleAuthEnabled: true,
        sentryDsn: "",
        vapidPublicKey: "BEl6Ww",
      });
    }
    if (pathname === "/api/profile") {
      if (method === "POST") {
        const body = route.request().postDataJSON();
        state.profilePatchBody = body;
        if (body.action === "update_workspace" && body.displayName) {
          state.workspace = {
            ...(state.workspace || workspace),
            displayName: body.displayName,
            updatedAt: "2026-05-23T00:30:00.000Z",
          };
        }
      }
      const currentWorkspace = state.workspace || workspace;
      return json({
        profile: { id: "profile-ans", email: auth.email, displayName: "Alex", avatarUrl: "", createdAt: "", updatedAt: "", settings: { defaultWorkspaceId: workspace.id } },
        workspaces: [currentWorkspace],
        activeWorkspaceId: currentWorkspace.id,
        activeWorkspace: currentWorkspace,
        pendingInvites: [],
        auth,
        app: { name: "Sexualsync", knownLegacyPeople: {} },
      });
    }
    if (pathname === "/api/bootstrap") {
      state.bootstrapCalls = (state.bootstrapCalls || 0) + 1;
      if (state.bootstrapUnauthorized) {
        return json({ error: "Sign in to continue." }, 401);
      }
      const boardRequest = state.request || request;
      const currentWorkspace = state.workspace || workspace;
      return json({
        profile: { id: "profile-ans", email: auth.email, displayName: "Avery", avatarUrl: "", createdAt: "", updatedAt: "", settings: { defaultWorkspaceId: workspace.id } },
        workspaces: [currentWorkspace],
        activeWorkspaceId: currentWorkspace.id,
        activeWorkspace: currentWorkspace,
        pendingInvites: [],
        auth,
        app: { name: "Sexualsync", knownLegacyPeople: {} },
        bootstrap: {
          workspaceId: workspace.id,
          requests: { workspaceId: workspace.id, requests: [boardRequest], activeRequests: [boardRequest], history: [] },
          fantasy: state.fantasy || { workspaceId: workspace.id, reactionCatalog: [], ideas: [kink], graveyard: [] },
          boundaries: { workspaceId: workspace.id, boundaries: [] },
          acts: { workspaceId: workspace.id, acts: cloneJson(state.acts || []) },
        },
      });
    }
    if (pathname === "/api/request-board") {
      const boardRequest = state.request || request;
      const activeRequests = ["completed", "archived", "expired"].includes(boardRequest.status) ? [] : [boardRequest];
      const history = ["completed", "archived", "expired"].includes(boardRequest.status) ? [boardRequest] : [];
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        state.requestCreateBody = body;
        if (state.delayRequestBoardPostMs) await new Promise((resolve) => setTimeout(resolve, state.delayRequestBoardPostMs));
        state.request = {
          ...boardRequest,
          status: "pending",
          requesterEmail: body.requesterEmail || auth.email,
          reviewerEmail: body.reviewerEmail || "jordan@example.test",
          categories: body.categories || boardRequest.categories,
          timing: body.timing || boardRequest.timing,
          filming: body.filming || boardRequest.filming,
          note: body.note || "",
          updatedAt: "2026-05-23T00:30:00.000Z",
          sentAt: "2026-05-23T00:30:00.000Z",
        };
        const updatedRequest = state.request;
        return json({ workspaceId: workspace.id, request: updatedRequest, requests: [updatedRequest], activeRequests: [updatedRequest], history: [] });
      }
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON();
        state.requestActionBody = body;
        if (body.action === "reply") {
          state.requestReplyBody = body;
          state.request = { ...boardRequest, status: "reviewed", decisions: body.decisions || [], counters: (body.decisions || []).filter((item) => item.counter) };
        } else if (body.action === "accept_counter") {
          state.request = {
            ...boardRequest,
            status: "on_deck",
            categories: ["💆 Sensual massage"],
            timing: "Tomorrow",
            counterAcceptedAt: "2026-05-23T00:25:00.000Z",
            acceptedCounters: boardRequest.counters || [],
          };
        } else if (body.action === "pass") {
          state.request = {
            ...boardRequest,
            status: "archived",
            passedAt: "2026-05-23T00:35:00.000Z",
            passedByEmail: auth.email,
            passedByName: auth.person,
            archivedAt: "2026-05-23T00:35:00.000Z",
            archivedByEmail: auth.email,
            archivedByName: auth.person,
          };
        }
        const updatedRequest = state.request || boardRequest;
        const nextActiveRequests = ["completed", "archived", "expired"].includes(updatedRequest.status) ? [] : [updatedRequest];
        const nextHistory = ["completed", "archived", "expired"].includes(updatedRequest.status) ? [updatedRequest] : [];
        return json({ workspaceId: workspace.id, request: updatedRequest, requests: [updatedRequest], activeRequests: nextActiveRequests, history: nextHistory });
      }
      return json({ workspaceId: workspace.id, requests: [boardRequest], activeRequests, history });
    }
    if (pathname === "/api/review-token") {
      const body = route.request().postDataJSON();
      const boardRequest = state.request || request;
      if (body.action === "resolve") {
        return json({
          token: { expiresAt: "2026-05-30T00:00:00.000Z", workspaceId: workspace.id, requestId: request.id },
          request: boardRequest,
          workspace: {
            id: workspace.id,
            displayName: workspace.displayName,
            members: workspace.members.map((member) => ({ email: member.email, displayName: member.displayName })),
          },
        });
      }
      state.reviewSubmitBody = body;
      return json({
        request: { ...boardRequest, status: "reviewed", decisions: body.decisions || [] },
        token: { expiresAt: "2026-05-30T00:00:00.000Z", consumedAt: "2026-05-23T00:20:00.000Z" },
      });
    }
    if (pathname === "/api/sexboard") {
      const boardRequest = state.request || request;
      const activeRequests = ["completed", "archived", "expired"].includes(boardRequest.status) ? [] : [boardRequest];
      const history = ["completed", "archived", "expired"].includes(boardRequest.status) ? [boardRequest] : [];
      return json({
        profile: { id: "profile-ans", email: auth.email, displayName: "Alex", avatarUrl: "", createdAt: "", updatedAt: "", settings: { defaultWorkspaceId: workspace.id } },
        workspaces: [workspace],
        activeWorkspaceId: workspace.id,
        activeWorkspace: workspace,
        pendingInvites: [],
        auth,
        app: { name: "Sexualsync", knownLegacyPeople: {} },
        sexboard: {
          workspaceId: workspace.id,
          board: { workspaceId: workspace.id, requests: [boardRequest], activeRequests, history },
          pile: state.pile || null,
          pileSessions: state.pileSessions || [],
          blindReveal: state.blindReveal || null,
          blindReveals: state.blindReveals || [],
          fantasy: state.fantasy || { workspaceId: workspace.id, reactionCatalog: [], ideas: [], graveyard: [] },
          presence: {
            me: { email: auth.email, lastSeen: "2026-05-23T00:11:00.000Z", displayName: "Alex" },
            partner: { email: "jordan@example.test", lastSeen: new Date().toISOString(), displayName: "Jordan" },
            daysInSync: 2,
          },
          activity,
          sexQuiz: state.sexQuiz || null,
          greenLights: state.greenLights || null,
        },
      });
    }
    if (pathname === "/api/pile") {
      return json({ pile: state.pile || null, sessions: state.pileSessions || [] });
    }
    if (pathname === "/api/approved-acts") {
      if (state.delayApprovedActsMs) await new Promise((resolve) => setTimeout(resolve, state.delayApprovedActsMs));
      return json({ workspaceId: workspace.id, acts: cloneJson(state.acts || []) });
    }
    if (pathname === "/api/blind-reveals") {
      return json({ workspaceId: workspace.id, activeReveal: state.blindReveal || null, reveals: state.blindReveals || [] });
    }
    if (pathname === "/api/dashboard/health") {
      return json(state.health || healthResponse);
    }
    if (pathname === "/api/space/presence") {
      return json({
        me: { email: auth.email, lastSeen: "2026-05-23T00:11:00.000Z", displayName: "Alex" },
        partner: { email: "jordan@example.test", lastSeen: new Date().toISOString(), displayName: "Jordan" },
        daysInSync: 2,
      });
    }
    if (pathname === "/api/push-subscribe") {
      state.pushSubscribeBody = route.request().postDataJSON();
      return json({ ok: true });
    }
    if (pathname === "/api/push-test") {
      state.pushTestBody = route.request().postDataJSON();
      return json({ ok: true });
    }
    if (pathname === "/api/activity") {
      if (method !== "GET") {
        const body = route.request().postDataJSON();
        if (body.action === "mark_read") {
          activity.readState.all = new Date().toISOString();
          for (const item of activity.items) {
            if (!body.resource || item.resource === body.resource) item.unread = false;
          }
          recomputeActivityUnread(activity);
        }
        if (body.action === "dismiss") {
          const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
          activity.items = activity.items.filter((item) => !ids.has(item.id));
          activity.readState.dismissed = Array.from(new Set([
            ...(activity.readState.dismissed || []),
            ...ids,
          ]));
          recomputeActivityUnread(activity);
        }
        if (body.action === "clear") {
          activity.readState.all = new Date().toISOString();
          activity.readState.dismissed = Array.from(new Set([
            ...(activity.readState.dismissed || []),
            ...activity.items.map((item) => item.id),
          ]));
          activity.items = [];
          recomputeActivityUnread(activity);
        }
      }
      return json(activity);
    }
    if (pathname === "/api/chat") {
      state.chatMessages = state.chatMessages || cloneJson(chatSeedMessages);
      state.chatReadCursors = state.chatReadCursors || {};
      state.chatReadAt = state.chatReadAt || {};

      if (method === "GET") {
        const after = Number(requestUrl.searchParams.get("after") || 0);
        const messages = after > 0
          ? state.chatMessages.filter((message) => Number(message.seq) > after)
          : state.chatMessages;
        return json({
          workspaceId: workspace.id,
          messages,
          readCursors: state.chatReadCursors,
          readAt: state.chatReadAt,
        });
      }

      const body = route.request().postDataJSON();
      if (method === "PATCH") {
        if (body.action === "read") {
          state.chatReadCursors[auth.email] = Math.max(Number(state.chatReadCursors[auth.email]) || 0, Number(body.seq) || 0);
          state.chatReadAt[auth.email] = "2026-05-23T00:20:00.000Z";
          return json({ readCursors: state.chatReadCursors, readAt: state.chatReadAt });
        }
        return json({ ok: true });
      }

      if (method === "POST") {
        state.chatPostBody = body;
        const nextSeq = state.chatMessages.reduce((max, message) => Math.max(max, Number(message.seq) || 0), 0) + 1;
        const message = {
          id: `chat-${nextSeq}`,
          seq: nextSeq,
          email: auth.email,
          name: auth.person,
          text: body.text || "",
          at: "2026-05-23T00:21:00.000Z",
          reactions: [],
          ...(body.replyToId ? { replyToId: body.replyToId } : {}),
        };
        state.chatMessages.push(message);
        return json({ workspaceId: workspace.id, message }, 201);
      }
    }
    if (pathname === "/api/fantasy-backlog") {
      const fantasy = state.fantasy || { workspaceId: workspace.id, reactionCatalog: [], ideas: [kink], graveyard: [] };
      state.fantasy = fantasy;
      if (method === "PATCH") {
        const body = route.request().postDataJSON();
        state.fantasyPatchBody = body;
        if (state.delayFantasyPatchMs) await new Promise((resolve) => setTimeout(resolve, state.delayFantasyPatchMs));
        if (body.action === "update_comment") {
          fantasy.ideas = (fantasy.ideas || []).map((idea) => {
            if (idea.id !== body.id) return idea;
            return {
              ...idea,
              comments: (idea.comments || []).map((comment) => (
                comment.id === body.commentId
                  ? {
                      ...comment,
                      text: body.comment,
                      editedAt: "2026-05-23T00:30:00.000Z",
                      editedByEmail: auth.email,
                      editedByName: auth.person,
                    }
                  : comment
              )),
            };
          });
        } else if (body.comment) {
          fantasy.ideas = (fantasy.ideas || []).map((idea) => {
            if (idea.id !== body.id) return idea;
            return {
              ...idea,
              comments: [
                ...(idea.comments || []),
                {
                  id: `comment-${(idea.comments || []).length + 1}`,
                  email: auth.email,
                  name: auth.person,
                  text: body.comment,
                  at: "2026-05-23T00:30:00.000Z",
                },
              ],
            };
          });
        }
      }
      return json(fantasy);
    }
    if (pathname === "/api/prompts") {
      return json({ text: "Name the fantasy that would feel easier if they admitted one too." });
    }
    if (pathname === "/api/shelf") {
      if (method === "PATCH") {
        state.shelfPatchBody = route.request().postDataJSON();
        if (state.shelfPatchBody.action === "revealed" && state.shelfRevealResponse) {
          state.shelf = state.shelfRevealResponse;
        }
      }
      return json(state.shelf || { workspaceId: workspace.id, reactionCatalog: shelfReactionCatalog, item: shelfItem, items: [shelfItem] });
    }
    if (pathname === "/api/vault") {
      if (method === "POST") {
        state.vaultUploadSeen = true;
      }
      return json({ workspaceId: workspace.id, reactionCatalog: [], items: [] });
    }
    return json({ ok: true });
  });
}

async function emulateStandalonePwa(page) {
  await page.addInitScript(() => {
    const standaloneQuery = "(display-mode: standalone)";
    Object.defineProperty(window.navigator, "standalone", {
      value: true,
      configurable: true,
    });
    window.matchMedia = (query) => ({
      matches: query === standaloneQuery,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false; },
    });
  });
}

test("sign-in requires legal acceptance before auth starts", async ({ page }) => {
  const state = { bootstrapUnauthorized: true };
  await mockApi(page, state);
  await page.goto("/signin");

  await expect(page.getByRole("heading", { name: /Some things are easier to type than say/i })).toBeVisible();

  await page.getByRole("link", { name: /Continue with Google/i }).click({ force: true });
  expect(state.googleAuthAttempts || 0).toBe(0);
  await expect(page.getByText("Confirm you are 18+ and agree to the Terms and Privacy Policy first.")).toBeVisible();

  await page.getByLabel(/I am 18\+ and agree/i).check();
  await expect(page.getByRole("link", { name: /Continue with Google/i })).toHaveAttribute("aria-disabled", "false");

  await page.getByRole("button", { name: "Use email instead" }).click();
  await page.getByLabel("Email address").fill("alex@example.test");
  await expect(page.getByRole("button", { name: "Send code" })).toBeEnabled();
});

test("intentional sign-out suppresses standalone PWA auto-reconnect from welcome", async ({ page }) => {
  await emulateStandalonePwa(page);

  const state = {};
  await mockApi(page, state);
  await page.goto("/space");

  await page.getByRole("link", { name: /Sign out of this device/i }).click();
  await expect(page.getByRole("heading", { name: "This device is clear." })).toBeVisible();

  state.bootstrapUnauthorized = true;
  state.bootstrapCalls = 0;
  await page.getByRole("link", { name: "Back to welcome" }).click();

  await expect(page.getByRole("heading", { name: /Get in Sync/i })).toBeVisible();
  expect(state.googleAuthAttempts || 0).toBe(0);
  expect(state.bootstrapCalls || 0).toBe(0);
});

test("standalone PWA launch prefers browser-session reconnect over saved email mode", async ({ page }) => {
  await emulateStandalonePwa(page);
  await page.addInitScript(() => {
    window.localStorage.setItem("ss:last-auth-provider", "email");
  });

  const state = { bootstrapUnauthorized: true };
  await mockApi(page, state);
  await page.goto("/signin?source=pwa");

  await expect.poll(() => state.googleAuthAttempts || 0, { timeout: 4000 }).toBe(1);
  await expect(page).toHaveURL(/\/sexboard/);
});

test("standalone PWA launch reconnects after an old sign-out marker expires", async ({ page }) => {
  await emulateStandalonePwa(page);
  await page.addInitScript(() => {
    window.localStorage.setItem("ss:intentional-sign-out", String(Date.now() - (3 * 60 * 1000)));
  });

  const state = { bootstrapUnauthorized: true };
  await mockApi(page, state);
  await page.goto("/signin?source=pwa");

  await expect.poll(() => state.googleAuthAttempts || 0, { timeout: 4000 }).toBe(1);
  await expect(page).toHaveURL(/\/sexboard/);
});

test("Space omits the redundant paired-space summary card", async ({ page }) => {
  const state = {};
  await mockApi(page, state);
  await page.goto("/space");

  await expect(page.getByRole("heading", { name: "You & your space" })).toBeVisible();
  await expect(page.locator(".settings-id")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Rename space" })).toHaveCount(0);
});

test("Space reconnects granted notification permission to push subscription storage", async ({ page }) => {
  const state = {};
  await page.addInitScript(() => {
    // A user who already enabled notifications has their per-event prefs saved in
    // localStorage (here: request-sent ON, game-ready opted OFF). The app-wide
    // PushReconnect re-sends exactly these on launch (readStoredPushPrefs), and
    // /space's auto-register merges them over the all-on defaults — so the silent
    // reconnect after a deploy must PRESERVE them, never reset to defaults. Seed
    // them so the assertion is deterministic no matter which path posts first.
    // (Without a seed, PushReconnect posts `{}` and the server applies its own
    // request-sent:true default, which this API-mock can't observe.)
    try {
      window.localStorage.setItem("sexualsync-push-preferences", JSON.stringify({
        "chat-message": true, "request-sent": true, "request-reviewed": true,
        "request-reminder": true, "kink-nudge": true, "blind-reveal": true,
        "pile-started": true, "pile-reminder": true, "game-ready": false, "push-test": true,
      }));
    } catch { /* sessionStorage/localStorage can be blocked; nothing else to do */ }
    const subscription = {
      endpoint: "https://push.example.test/alex-phone",
      expirationTime: null,
      keys: { p256dh: "p256", auth: "auth" },
      toJSON() {
        return {
          endpoint: this.endpoint,
          expirationTime: this.expirationTime,
          keys: this.keys,
        };
      },
    };
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: {
        permission: "granted",
        requestPermission: async () => "granted",
      },
    });
    Object.defineProperty(window, "PushManager", {
      configurable: true,
      value: function PushManager() {},
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        // PwaBridge (mounted app-wide) registers the SW + listens for
        // controllerchange on mount; a mock missing these throws and the whole
        // app tree never settles, so /space stays on its loading spinner.
        controller: null,
        addEventListener: () => {},
        register: async () => ({
          waiting: null,
          installing: null,
          update: async () => {},
          addEventListener: () => {},
        }),
        ready: Promise.resolve({
          pushManager: {
            // Reconnect scenario: this device already holds a live subscription,
            // so getSubscription returns it — the page shows "Notifications are
            // on" and the silent reconnect re-saves the existing endpoint.
            getSubscription: async () => subscription,
            subscribe: async () => subscription,
          },
        }),
      },
    });
  });
  await mockApi(page, state);
  await page.goto("/space");

  await expect(page.getByRole("heading", { name: "You & your space" })).toBeVisible();
  await expect.poll(() => state.pushSubscribeBody?.subscription?.endpoint).toBe("https://push.example.test/alex-phone");
  expect(state.pushSubscribeBody?.workspaceId).toBe(workspace.id);
  expect(state.pushSubscribeBody?.preferences?.["request-sent"]).toBe(true);
  // The reconnect carries the saved opt-out through instead of resetting to
  // all-on — i.e. a deploy never silently changes the user's notification prefs.
  expect(state.pushSubscribeBody?.preferences?.["game-ready"]).toBe(false);
  await expect(page.getByText("Notifications are on for this device.")).toBeVisible();
});

test("Sext long-press reply survives small finger movement", async ({ page }) => {
  const state = {};
  await mockApi(page, state);
  await page.goto("/chat");

  const bubble = page.getByRole("button", { name: "Hold this message" });
  await expect(bubble).toBeVisible();
  const box = await bubble.boundingBox();
  expect(box).toBeTruthy();
  const x = box.x + Math.min(32, box.width / 2);
  const y = box.y + Math.min(20, box.height / 2);

  await bubble.dispatchEvent("pointerdown", {
    pointerId: 23,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
  });
  await page.waitForTimeout(160);
  await bubble.dispatchEvent("pointermove", {
    pointerId: 23,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: x + 6,
    clientY: y + 4,
    bubbles: true,
    cancelable: true,
  });

  await expect(page.getByRole("menu", { name: "Message actions" })).toBeVisible();
  await bubble.dispatchEvent("pointerup", {
    pointerId: 23,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 0,
    clientX: x + 6,
    clientY: y + 4,
    bubbles: true,
    cancelable: true,
  });
  await page.getByRole("button", { name: "Reply" }).click();

  await expect(page.getByText("Replying to Jordan")).toBeVisible();
  await page.getByPlaceholder(/Message Jordan/).fill("replying now");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => state.chatPostBody?.replyToId).toBe("chat-1");
});

test("Ask surfaces saved library Acts before collapsed defaults", async ({ page }) => {
  const state = { acts: [savedLibraryAct] };
  await mockApi(page, state);
  await page.goto("/ask");

  await expect(page.getByRole("heading", { name: "Be specific." })).toBeVisible();
  await expect(page.locator(".ask-act-grid .act-chip").first()).toContainText("Slow undressing");
  await expect(page.getByRole("button", { name: "Slow undressing" })).toBeVisible();
});

test("Ask submit routes while the send pulse is still animating", async ({ page }) => {
  const state = { acts: [savedLibraryAct], delayRequestBoardPostMs: 500 };
  await mockApi(page, state);
  await page.goto("/ask");

  await page.getByRole("button", { name: "Slow undressing" }).click();
  await page.getByRole("button", { name: "Send to Jordan" }).click();

  await expect.poll(() => state.requestCreateBody?.categories?.[0]).toBe("Slow undressing");
  // The pulse layer is body-mounted (outside the React tree) the instant the
  // Ask write resolves and lives ~3.4s, so it survives the soft route to
  // /sexboard. Assert it here — freshly mounted — rather than after landing on
  // /sexboard, where its ~1.6s self-teardown is a fixed wall-clock timer that
  // raced the (CPU-bound, CI-variable) navigation and flaked. The URL assertion
  // below still resolves while the layer is alive, so this keeps the "routes
  // while the send pulse is still animating" coverage without the teardown race.
  await expect(page.locator(".ss-send-pulse-layer")).toBeVisible();
  await expect(page).toHaveURL(/\/sexboard$/);
});

test("Health dashboard stays compact and tappable on iPhone", async ({ page }) => {
  await mockApi(page);
  await page.goto("/space/health");
  await expect(page.getByRole("heading", { name: "Health" })).toBeVisible();
  await expect(page.getByText("Same-night approved Asks and Pile overlaps stay separate")).toBeVisible();
  await expect(page.getByText("Very long teasing name that should still truncate cleanly")).toBeVisible();

  const metrics = await page.evaluate(() => {
    const rangeButton = document.querySelector(".health-range-button");
    const summary = document.querySelector(".health-summary");
    const rhythm = document.querySelector(".health-section[aria-label='Rhythm']");
    const chip = document.querySelector(".health-section-head span");
    const letterSpacing = chip ? getComputedStyle(chip).letterSpacing : "0px";
    const letterSpacingPx = letterSpacing === "normal" ? 0 : Number.parseFloat(letterSpacing);
    const statRects = Array.from(document.querySelectorAll(".health-substat-grid .health-substat")).map((item) => {
      const rect = item.getBoundingClientRect();
      const value = item.querySelector("span");
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        valueFontSize: Number.parseFloat(value ? getComputedStyle(value).fontSize : "0")
      };
    });
    const sourceHistory = document.querySelector(".health-section[aria-label='Source history']");
    const eventLinks = sourceHistory ? sourceHistory.querySelectorAll("a.health-event-row").length : -1;
    const emojis = sourceHistory
      ? Array.from(sourceHistory.querySelectorAll(".health-act-emoji")).map((node) => node.textContent?.trim() || "")
      : [];
    return {
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rangeButtonHeight: rangeButton?.getBoundingClientRect().height || 0,
      summaryHeight: summary?.getBoundingClientRect().height || 0,
      rhythmTop: rhythm?.getBoundingClientRect().top || 0,
      letterSpacingPx,
      statRects,
      eventLinks,
      emojis,
    };
  });

  expect(metrics.horizontalOverflow).toBeLessThanOrEqual(0);
  expect(metrics.rangeButtonHeight).toBeGreaterThanOrEqual(40);
  expect(metrics.summaryHeight).toBeLessThanOrEqual(260);
  expect(metrics.rhythmTop).toBeLessThan(560);
  expect(metrics.letterSpacingPx).toBe(0);
  expect(metrics.statRects.length).toBe(2);
  expect(new Set(metrics.statRects.map((rect) => rect.width)).size).toBe(1);
  expect(new Set(metrics.statRects.map((rect) => rect.height)).size).toBe(1);
  expect(new Set(metrics.statRects.map((rect) => rect.valueFontSize)).size).toBe(1);
  expect(metrics.eventLinks).toBe(0);
  expect(metrics.emojis.length).toBeGreaterThanOrEqual(6);
  expect(metrics.emojis).not.toContain("✦");
  expect(metrics.emojis).toContain("💋");
  expect(metrics.emojis).toContain("🚿");
  expect(metrics.emojis).toContain("📹");
});

test("Reveals index art uses app theme colors on iPhone", async ({ page }) => {
  await mockApi(page);
  await page.goto("/games");
  await expect(page.getByRole("heading", { name: "Nobody has to go first." })).toBeVisible();
  // Sex Quiz and Green Lights lead the list; the Pile and Blind Reveal follow.
  const tiles = page.locator(".game-tile");
  await expect(tiles).toHaveCount(4);
  await expect(tiles.nth(0)).toHaveAttribute("href", "/games/sex-quiz");
  await expect(tiles.nth(1)).toHaveAttribute("href", "/games/green-lights");
  await expect(tiles.nth(2)).toHaveAttribute("href", "/games/pile");
  await expect(tiles.nth(3)).toHaveAttribute("href", "/games/blind-reveal");
  await expect(page.locator(".game-art-pile")).toBeVisible();
  await expect(page.locator(".game-art-reveal")).toBeVisible();
  await expect(page.locator(".pile-card")).toHaveCount(3);
  await expect(page.locator(".pile-glow")).toHaveCount(1);
  await expect(page.locator(".pile-card-pip")).toHaveCount(1);
  await expect(page.locator(".reveal-line")).toHaveCount(6);
  await expect(page.locator(".reveal-pip")).toHaveCount(1);
  await expect(page.locator(".reveal-pip-halo")).toHaveCount(1);

  const metrics = await page.evaluate(() => {
    const pileArt = document.querySelector(".game-art-pile");
    const revealArt = document.querySelector(".game-art-reveal");
    const pileCard = document.querySelector(".pile-card");
    const frontPileCard = document.querySelector(".pile-card-2");
    const revealLine = document.querySelector(".reveal-line");
    const revealHalf = document.querySelector(".reveal-half-a");
    const revealSeam = document.querySelector(".reveal-seam");
    return {
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      pileArtBackground: pileArt ? getComputedStyle(pileArt).backgroundImage : "",
      revealArtBackground: revealArt ? getComputedStyle(revealArt).backgroundImage : "",
      pileCardBackground: pileCard ? getComputedStyle(pileCard).backgroundImage : "",
      pileCardBorder: pileCard ? getComputedStyle(pileCard).borderTopColor : "",
      frontPileAnimation: frontPileCard ? getComputedStyle(frontPileCard).animationName : "",
      revealHalfBackground: revealHalf ? getComputedStyle(revealHalf).backgroundImage : "",
      revealLineAnimation: revealLine ? getComputedStyle(revealLine).animationName : "",
      revealSeamColor: revealSeam ? getComputedStyle(revealSeam).backgroundColor : "",
      revealSeamAnimation: revealSeam ? getComputedStyle(revealSeam).animationName : "",
    };
  });

  expect(metrics.horizontalOverflow).toBeLessThanOrEqual(0);
  expect(metrics.pileArtBackground).toContain("rgb(52, 26, 40)");
  expect(metrics.revealArtBackground).toContain("rgb(52, 26, 40)");
  expect(metrics.pileCardBackground).toContain("rgb(35, 17, 26)");
  expect(metrics.pileCardBorder).toContain("color(srgb 0.952941");
  expect(metrics.frontPileAnimation).toBe("pile-bob");
  expect(metrics.revealHalfBackground).toContain("color(srgb");
  expect(metrics.revealLineAnimation).toBe("reveal-type");
  expect(metrics.revealSeamColor).toBe("rgb(233, 168, 179)");
  expect(metrics.revealSeamAnimation).toBe("reveal-seam-breath");
});

test("Blind Reveal Recent Reveals opens a closed reveal on iPhone", async ({ page }) => {
  await mockApi(page, { blindReveal: null, blindReveals: [archivedBlindReveal] });
  await page.goto("/games/blind-reveal");

  await expect(page.getByText("Recent reveals")).toBeVisible();
  await page.getByRole("button", { name: /Open closed Blind Reveal: What should we admit after midnight\?/ }).click();

  await expect(page.getByText("closed reveal")).toBeVisible();
  await expect(page.getByText("I want the hotel fantasy again.")).toBeVisible();
  await expect(page.getByText("I want the same thing, slower.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close this reveal" })).toHaveCount(0);
});

test("Sexboard locked Blind Reveal opens closed answers on iPhone", async ({ page }) => {
  await mockApi(page, { blindReveal: null, blindReveals: [archivedBlindReveal] });
  await page.goto("/sexboard");

  const lockedReveal = page.locator(".sexboard-handoff-row").filter({ hasText: "What should we admit after midnight?" });
  await expect(lockedReveal).toBeVisible();
  await expect(lockedReveal).toHaveAttribute("href", "/games/blind-reveal?id=blind-closed-1&activity=1");

  await lockedReveal.click();
  await expect(page).toHaveURL(/\/games\/blind-reveal\?id=blind-closed-1&activity=1$/);
  await expect(page.getByText("closed reveal")).toBeVisible();
  await expect(page.getByText("I want the hotel fantasy again.")).toBeVisible();
  await expect(page.getByText("I want the same thing, slower.")).toBeVisible();
});

test("Pile page shows Recent piles history on iPhone", async ({ page }) => {
  await mockApi(page, {
    pile: null,
    pileSessions: [{
      id: "pile-history-1",
      workspaceId: workspace.id,
      acts: ["Slow kissing"],
      overlap: ["Slow kissing"],
      quietDropCount: 0,
      revealAt: "2026-05-23T00:08:00.000Z",
      startedAt: "2026-05-23T00:00:00.000Z",
      lockedAt: "2026-05-23T00:12:00.000Z",
      lockedByEmail: auth.email,
      lockedByName: auth.person,
      revealNarration: "",
    }],
  });
  await page.goto("/games/pile");

  await expect(page.getByText("Recent piles")).toBeVisible();
  await expect(page.getByText("Slow kissing")).toBeVisible();
});

test("Reveals badge clears after viewed Pile and Blind Reveal reveals", async ({ page }) => {
  const gameActivity = {
    workspaceId: workspace.id,
    unreadTotal: 2,
    unreadByResource: { pile: 1, "blind-reveals": 1 },
    readState: { all: "", resources: {} },
    items: [
      {
        id: "pile-locked-activity",
        workspaceId: workspace.id,
        resource: "pile",
        resourceLabel: "Pile",
        action: "locked",
        label: "Pile locked in",
        entityId: "pile-history-1",
        actorEmail: "jordan@example.test",
        actorName: "Jordan",
        at: "2026-05-23T00:13:00.000Z",
        passive: false,
        unread: true,
      },
      {
        id: "blind-revealed-activity",
        workspaceId: workspace.id,
        resource: "blind-reveals",
        resourceLabel: "Blind Reveal",
        action: "revealed",
        label: "Blind Reveal opened",
        entityId: "blind-closed-1",
        actorEmail: "jordan@example.test",
        actorName: "Jordan",
        at: "2026-05-23T00:12:00.000Z",
        passive: false,
        unread: true,
      },
    ],
  };
  await mockApi(page, {
    activity: gameActivity,
    pile: revealedPile,
    blindReveal: null,
    blindReveals: [archivedBlindReveal],
  });
  await page.goto("/sexboard");
  await expect(page.getByRole("link", { name: /Reveals 2 unread/ })).toBeVisible();

  await page.goto("/games/pile");
  await expect(page.getByRole("heading", { name: "In sync." })).toBeVisible();
  await expect(page.getByRole("link", { name: /Reveals 1 unread/ })).toBeVisible();

  await page.goto("/games/blind-reveal?id=blind-closed-1&activity=1");
  await expect(page.getByText("closed reveal")).toBeVisible();
  await expect(page.getByRole("link", { name: /^Reveals$/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Reveals [1-9] unread/ })).toHaveCount(0);
});

test("Pile waiting-on-partner pill is centered on iPhone", async ({ page }) => {
  await mockApi(page, {
    pile: {
      ...activePile,
      partnerHasDropped: false,
      mine: ["Kiss"],
    },
  });
  await page.goto("/games/pile");

  const pill = page.locator(".pile-waiting-pill");
  await expect(pill).toHaveText("Waiting on Jordan");
  const metrics = await pill.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      pillCenter: rect.left + rect.width / 2,
      viewportCenter: window.innerWidth / 2,
    };
  });
  expect(Math.abs(metrics.pillCenter - metrics.viewportCenter)).toBeLessThanOrEqual(1);
});

test("Sexboard Jordan activity actions are stable on iPhone", async ({ page }) => {
  await mockApi(page);
  await page.goto("/sexboard");
  await expect(page.getByRole("heading", { name: "Jordan's activity" })).toBeVisible();
  await expect(page.getByText("New Ask landed")).toBeVisible();
  await expect(page.getByText("Pile changed 2 times")).toBeVisible();

  const markRead = page.getByRole("button", { name: "Mark read" });
  await expect(page.getByText("1 unread update from Jordan.")).toBeVisible();

  const scrollMetrics = await page.evaluate(() => {
    const root = document.documentElement;
    const shell = document.querySelector(".app-shell.surface");
    const stage = document.querySelector(".sexboard-stage");
    window.scrollTo(80, window.scrollY);
    root.scrollLeft = 80;
    document.body.scrollLeft = 80;
    return {
      horizontalOverflow: Math.max(root.scrollWidth - root.clientWidth, document.body.scrollWidth - window.innerWidth),
      scrollLeft: Math.max(window.scrollX, root.scrollLeft, document.body.scrollLeft),
      shellOverflowX: shell ? getComputedStyle(shell).overflowX : "",
      stageTouchAction: stage ? getComputedStyle(stage).touchAction : "",
    };
  });

  expect(scrollMetrics.horizontalOverflow).toBeLessThanOrEqual(0);
  expect(scrollMetrics.scrollLeft).toBe(0);
  expect(["hidden", "clip"]).toContain(scrollMetrics.shellOverflowX);
  expect(scrollMetrics.stageTouchAction).toBe("pan-y");

  const swipeWrap = page.locator(".live-activity-swipe-wrap").filter({ hasText: "Pile changed 2 times" });
  const groupedRow = swipeWrap.locator(".live-activity-item");
  const box = await groupedRow.boundingBox();
  expect(box).not.toBeNull();
  await groupedRow.evaluate((node, swipe) => {
    const touch = (clientX) => ({ clientX, clientY: swipe.clientY });
    const fire = (type, touches, changedTouches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: touches });
      Object.defineProperty(event, "changedTouches", { value: changedTouches });
      node.dispatchEvent(event);
    };
    fire("touchstart", [touch(swipe.startX)], [touch(swipe.startX)]);
    fire("touchmove", [touch(swipe.endX)], [touch(swipe.endX)]);
  }, {
    startX: box.x + box.width - 10,
    endX: box.x + 14,
    clientY: box.y + box.height / 2,
  });
  await expect.poll(async () => swipeWrap.evaluate((node) => {
    const indicator = node.querySelector(".live-activity-swipe-indicator");
    return {
      ready: node.classList.contains("is-ready"),
      indicatorText: indicator?.textContent?.replace(/\s+/g, " ").trim() || "",
      indicatorOpacity: indicator ? getComputedStyle(indicator).opacity : "",
    };
  })).toEqual({
    ready: true,
    indicatorText: "✓Mark read",
    indicatorOpacity: "1",
  });
  await groupedRow.evaluate((node, swipe) => {
    const touch = (clientX) => ({ clientX, clientY: swipe.clientY });
    const event = new Event("touchend", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: [] });
    Object.defineProperty(event, "changedTouches", { value: [touch(swipe.endX)] });
    node.dispatchEvent(event);
  }, {
    endX: box.x + 14,
    clientY: box.y + box.height / 2,
  });
  await expect(groupedRow).toBeHidden();

  // "Mark read" clears the whole box (inbox-zero), not just the unread badge.
  await markRead.click();
  await expect(page.getByText("1 unread update from Jordan.")).toBeHidden();
  await expect(page.getByText("New Ask landed")).toBeHidden();
  await expect(markRead).toBeDisabled();
});

test("Sexboard online presence mark breathes green", async ({ page }) => {
  await mockApi(page);
  await page.goto("/sexboard");
  const liveStatus = page.locator(".presence-band-status.is-live");
  await expect(liveStatus).toContainText("live");

  const markStyle = await liveStatus.locator(".presence-live-mark").evaluate((node) => {
    const style = window.getComputedStyle(node);
    return {
      animationName: style.animationName,
      color: style.color,
      filter: style.filter,
    };
  });
  expect(markStyle.animationName).toBe("live-logo-breathe-green");
  expect(markStyle.color).toBe("rgb(168, 201, 160)");
  expect(markStyle.filter).toContain("drop-shadow");
});

test("Sexboard treats the Pile count as an optional cap", async ({ page }) => {
  await mockApi(page, { pile: activePile });
  await page.goto("/sexboard");
  const pileRow = page.locator(".sexboard-handoff-row").filter({ hasText: "Up to 3 each" });
  await expect(pileRow.getByText("Both Pile lists are in")).toBeVisible();
  await expect(pileRow.getByText("Reveal in")).toBeVisible();
  await expect(pileRow.getByText("Drop 2 more Acts")).toHaveCount(0);
  await expect(pileRow.getByText("Your side needs 3 before reveal can open.")).toHaveCount(0);
  await expect(page.locator(".game-progress-alert")).toHaveCount(0);
});

test("Sexboard hides expired unrevealed Piles", async ({ page }) => {
  await mockApi(page, {
    pile: {
      ...activePile,
      revealAt: new Date(Date.now() - 60_000).toISOString(),
      isRevealed: false,
      mine: [],
      partnerHasDropped: true,
      partnerLabels: null,
      overlap: null,
    },
  });
  await page.goto("/sexboard");
  await expect(page.locator('a.sexboard-handoff-row[href="/games/pile"]')).toHaveCount(0);
});

test("Sexboard shows a waiting Sex Quiz handoff once I've submitted", async ({ page }) => {
  await mockApi(page, { sexQuiz: { status: "open", mySubmitted: true, partnerSubmitted: false, revealed: false } });
  await page.goto("/sexboard");
  const row = page.locator('a.sexboard-handoff-row[href="/games/sex-quiz"]');
  await expect(row.getByText("Your Sex Quiz is in")).toBeVisible();
  await expect(row.getByText("Waiting on Jordan")).toBeVisible();
});

test("Sexboard shows a needs-you Green Lights handoff when the partner finished first", async ({ page }) => {
  await mockApi(page, { greenLights: { status: "open", mySubmitted: false, partnerSubmitted: true, revealed: false } });
  await page.goto("/sexboard");
  const row = page.locator('a.sexboard-handoff-row[href="/games/green-lights"]');
  await expect(row.getByText("Take Green Lights")).toBeVisible();
  await expect(row.getByText("Jordan took Green Lights")).toBeVisible();
});

test("Sexboard drops the game handoffs once both partners have submitted", async ({ page }) => {
  await mockApi(page, {
    sexQuiz: { status: "revealed", mySubmitted: true, partnerSubmitted: true, revealed: true },
    greenLights: { status: "revealed", mySubmitted: true, partnerSubmitted: true, revealed: true },
  });
  await page.goto("/sexboard");
  await expect(page.locator('a.sexboard-handoff-row[href="/games/sex-quiz"]')).toHaveCount(0);
  await expect(page.locator('a.sexboard-handoff-row[href="/games/green-lights"]')).toHaveCount(0);
});

test("Sexboard waiting kink opens the shared library", async ({ page }) => {
  const myKink = {
    ...kink,
    id: "kink-mine",
    text: "Try a silk blindfold scene.",
    addedByEmail: auth.email,
    addedByName: auth.person,
  };
  const fantasy = { workspaceId: workspace.id, reactionCatalog: [], ideas: [myKink], graveyard: [] };

  await mockApi(page, { fantasy });
  await page.goto("/sexboard");

  const waitingSection = page.locator(".sexboard-handoff-section").filter({ hasText: "Waiting on Jordan" });
  const kinkRow = waitingSection.locator(".sexboard-handoff-row").filter({ hasText: "Waiting on a kink response" });
  await expect(kinkRow).toBeVisible();
  await expect(kinkRow).toHaveAttribute("href", "/inspiration?section=shared-kinks#shared-kinks");

  await kinkRow.click();
  await expect(page).toHaveURL(/\/inspiration\?section=shared-kinks#shared-kinks$/);
  await expect(page.locator("#shared-kinks")).toHaveJSProperty("open", true);
  await expect(page.locator("#shared-kinks .kink-card")).toContainText("Try a silk blindfold scene.");
});

test("Kink detail lets comment authors edit their own comments", async ({ page }) => {
  const commentKink = {
    ...kink,
    id: "kink-comment-edit",
    text: "Try a silk blindfold scene.",
    addedByEmail: auth.email,
    addedByName: auth.person,
    comments: [{
      id: "comment-1",
      email: auth.email,
      name: auth.person,
      text: "Original comment",
      at: "2026-05-23T00:00:00.000Z",
    }],
  };
  const state = {
    fantasy: { workspaceId: workspace.id, reactionCatalog: [], ideas: [commentKink], graveyard: [] },
  };

  await mockApi(page, state);
  await page.goto("/inspiration/kink?id=kink-comment-edit");

  const originalMessage = page.locator(".kd-msg").filter({ hasText: "Original comment" });
  await expect(originalMessage.getByRole("button", { name: /^Edit$/ })).toHaveCount(0);
  await originalMessage.click();
  const editBox = page.locator(".kd-comment-edit-form textarea");
  await expect(editBox).toBeFocused();
  await editBox.fill("Edited comment");
  await page.locator(".kd-comment-edit-form").getByRole("button", { name: "Save" }).click();

  await expect.poll(() => state.fantasyPatchBody?.action).toBe("update_comment");
  expect(state.fantasyPatchBody.commentId).toBe("comment-1");
  await expect(page.locator(".kd-msg").filter({ hasText: "Edited comment" })).toBeVisible();
  await expect(page.locator(".kd-msg").filter({ hasText: "Original comment" })).toHaveCount(0);
});

test("Kink detail shows new comments optimistically while the save is in flight", async ({ page }) => {
  const commentKink = {
    ...kink,
    id: "kink-comment-optimistic",
    text: "Try a silk blindfold scene.",
    comments: [],
  };
  const state = {
    delayFantasyPatchMs: 2_000,
    fantasy: { workspaceId: workspace.id, reactionCatalog: [], ideas: [commentKink], graveyard: [] },
  };

  await mockApi(page, state);
  await page.goto("/inspiration/kink?id=kink-comment-optimistic");

  await page.locator("textarea[placeholder='Leave a note…']").fill("Instant comment");
  await page.getByRole("button", { name: "Add comment" }).click();

  await expect(page.locator(".kd-msg").filter({ hasText: "Instant comment" })).toBeVisible({ timeout: 1_000 });
  expect(state.fantasyPatchBody?.comment).toBe("Instant comment");
});

test("Sexboard approved Ask opens the shared approval splash", async ({ page }) => {
  const yesterdayNight = isoForLocalDaysAgo(1);
  const state = {
    request: {
      ...counteredRequest,
      status: "on_deck",
      categories: ["💆 Sensual massage"],
      timing: "Tomorrow",
      createdAt: yesterdayNight,
      updatedAt: yesterdayNight,
      sentAt: yesterdayNight,
      reviewedAt: yesterdayNight,
      counterAcceptedAt: yesterdayNight,
      acceptedCounters: counterDecisions,
    },
  };
  await mockApi(page, state);
  await page.goto("/sexboard");

  const approvedRow = page.locator(".sexboard-handoff-row").filter({ hasText: "Approved for tonight." });
  await expect(approvedRow).toHaveAttribute("href", /\/mutual\?source=ask&requestId=req-1/);
  await expect(approvedRow.locator(".sexboard-handoff-action")).toHaveText("It's on!");
  await page.evaluate(() => {
    window.__mutualMarkCenters = [];
    let recording = false;
    const startRecording = () => {
      const mark = document.querySelector(".mutual-mark");
      if (!mark || recording) return false;
      recording = true;
      const startedAt = performance.now();
      const tick = () => {
        const node = document.querySelector(".mutual-mark");
        if (node) {
          const rect = node.getBoundingClientRect();
          window.__mutualMarkCenters.push(rect.top + rect.height / 2);
        }
        if (performance.now() - startedAt < 900) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    };
    const observer = new MutationObserver(() => {
      if (startRecording()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    startRecording();
  });
  await approvedRow.click();

  await expect(page).toHaveURL(/\/mutual\?/);
  await expect(page.getByRole("heading", { name: "Both of you said yes." })).toBeVisible();
  await expect(page.getByText(/Sensual massage/)).toBeVisible();
  await expect(page.locator(".mutual-mark")).toHaveCount(1);
  await expect(page.locator(".brand-bar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pass tonight" })).toBeVisible();
  await page.waitForTimeout(700);
  const markCenters = await page.evaluate(() => window.__mutualMarkCenters || []);
  expect(markCenters.length).toBeGreaterThan(3);
  expect(Math.max(...markCenters) - Math.min(...markCenters)).toBeLessThanOrEqual(2);

  // The pass confirm is the in-page accessible confirmAction <dialog>
  // (was window.confirm) — click its primary button instead of arming a
  // native dialog handler.
  await page.getByRole("button", { name: "Pass tonight" }).click();
  await page.locator(".ss-confirm-dialog .ss-confirm-primary").click();
  await expect.poll(() => state.requestActionBody?.action).toBe("pass");
  await expect(page).toHaveURL(/\/sexboard$/);
});

test("Pile reveal final state fits the iPhone viewport", async ({ page }) => {
  await mockApi(page, { pile: revealedPile });
  await page.goto("/games/pile");
  await expect(page.getByRole("heading", { name: "In sync." })).toBeVisible();
  // The reveal animation slowed in 2026-05 (intro → final now takes ~5.2s, plus
  // a 900ms opacity/transform transition). Measure after the final state has
  // settled so we read the committed layout, not the pre-final scaled state.
  await page.waitForTimeout(6300);

  const metrics = await page.evaluate(() => {
    const final = document.querySelector(".pile-final");
    const heading = document.querySelector(".pile-final .pile-headline");
    const actions = document.querySelector(".pile-final-actions");
    const board = document.querySelector(".pile-reveal-board");
    const tabbar = document.querySelector(".tabbar");
    const visibleDoingThisCount = Array.from(document.querySelectorAll(".pile-reveal-eyebrow, .pile-final .pile-headline"))
      .filter((node) => {
        const style = getComputedStyle(node);
        return node.textContent?.includes("In sync") &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number.parseFloat(style.opacity || "1") > 0.05;
      }).length;

    return {
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      finalTop: final?.getBoundingClientRect().top || 0,
      finalBottom: final?.getBoundingClientRect().bottom || 0,
      headingTop: heading?.getBoundingClientRect().top || 0,
      actionsBottom: actions?.getBoundingClientRect().bottom || 0,
      boardBottom: board?.getBoundingClientRect().bottom || 0,
      tabTop: tabbar?.getBoundingClientRect().top || window.innerHeight,
      visibleDoingThisCount,
    };
  });

  expect(metrics.horizontalOverflow).toBeLessThanOrEqual(0);
  expect(metrics.finalTop).toBeLessThan(330);
  expect(metrics.headingTop).toBeLessThan(260);
  expect(metrics.finalBottom).toBeLessThan(metrics.tabTop - 12);
  expect(metrics.actionsBottom).toBeLessThan(metrics.tabTop - 12);
  expect(metrics.boardBottom).toBeLessThan(metrics.tabTop - 12);
  expect(metrics.visibleDoingThisCount).toBe(1);
});

test("Inspiration source dock is stacked and tappable on iPhone", async ({ page }) => {
  await mockApi(page);
  await page.goto("/inspiration");
  await expect(page.locator(".inspiration-source-dock")).toBeVisible();
  await expect(page.locator(".inspiration-source-card")).toHaveCount(5);
  await expect(page.getByRole("link", { name: /Bellesa/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /RedGIFs/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Literotica/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /AO3/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Private Vault/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Open The Shelf/ })).toBeVisible();
  await expect(page.locator(".button-secondary")).toHaveCount(0);
});

test("Private Vault uploads phone videos with generic MIME from extension", async ({ page }) => {
  const state = {};
  await mockApi(page, state);
  await page.goto("/space/vault");
  await expect(page.getByText("Add private video")).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "phone-clip.MOV",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]),
  });
  await page.getByPlaceholder("Shared Vault passphrase").fill("shared secret");
  await page.getByRole("button", { name: "Encrypt and save" }).click();

  await expect.poll(() => state.vaultUploadSeen).toBe(true);
  await expect(page.locator(".vault-status").last()).toHaveText("Encrypted clip saved.");
});

test("Private Vault sniffs iOS hidden videos without useful metadata", async ({ page }) => {
  const state = {};
  await mockApi(page, state);
  await page.goto("/space/vault");
  await expect(page.getByText("Add private video")).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "IMG_0001",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 113, 116, 32, 32, 0, 0, 0, 0]),
  });
  await page.getByPlaceholder("Shared Vault passphrase").fill("shared secret");
  await page.getByRole("button", { name: "Encrypt and save" }).click();

  await expect.poll(() => state.vaultUploadSeen).toBe(true);
  await expect(page.locator(".vault-status").last()).toHaveText("Encrypted clip saved.");
});

test("Shelf activity arrival records reveal and keeps media hideable", async ({ page }) => {
  const state = {};
  await mockApi(page, state);
  await page.goto("/inspiration/shelf?item=shelf-1&activity=1&action=revealed");
  await expect(page.getByText("Recently opened")).toBeVisible();
  await page.getByRole("button", { name: "Reveal" }).click();
  await expect(page.getByRole("button", { name: "Hide" })).toBeVisible();
  await expect.poll(() => state.shelfPatchBody?.action).toBe("revealed");
});

test("Shelf RedGifs reveal uses muted native video without RedGifs chrome", async ({ page }) => {
  const redgifsItem = {
    ...shelfItem,
    id: "shelf-redgifs",
    type: "gif",
    source: "redgifs",
    sourceLabel: "REDGIFS",
    sourceUrl: "https://www.redgifs.com/watch/sample",
    embedUrl: "https://www.redgifs.com/ifr/sample?hd=1&muted=1&autoplay=0",
    posterUrl: "https://media.redgifs.com/sample-poster.jpg",
    videoHdUrl: "https://media.redgifs.com/sample-hd.mp4",
    videoSdUrl: "https://media.redgifs.com/sample-sd.mp4",
    title: "Saved RedGifs",
  };
  await mockApi(page, {
    shelf: {
      workspaceId: workspace.id,
      reactionCatalog: shelfReactionCatalog,
      item: redgifsItem,
      items: [redgifsItem],
    },
  });
  await page.goto("/inspiration/shelf");

  await page.getByRole("button", { name: "Reveal" }).click();
  const video = page.locator(".media-art video");
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute("src", "https://media.redgifs.com/sample-hd.mp4");
  await expect(video).toHaveJSProperty("muted", true);
  await expect(video).toHaveJSProperty("autoplay", true);
  await expect(video).not.toHaveAttribute("controls", /.*/);
  await expect(page.locator(".media-art iframe")).toHaveCount(0);
  await expect(page.getByText("Open source")).toHaveCount(0);
});

test("Shelf RedGifs reveal resolves missing native video before opening", async ({ page }) => {
  const missingVideo = {
    ...shelfItem,
    id: "shelf-redgifs-missing",
    type: "gif",
    source: "redgifs",
    sourceLabel: "REDGIFS",
    sourceUrl: "https://www.redgifs.com/watch/sample",
    embedUrl: "https://www.redgifs.com/ifr/sample?hd=1&muted=1&autoplay=0",
    videoHdUrl: "",
    videoSdUrl: "",
    title: "Fresh RedGifs",
  };
  const resolvedVideo = {
    ...missingVideo,
    videoHdUrl: "https://media.redgifs.com/sample-hd.mp4",
    videoSdUrl: "https://media.redgifs.com/sample-sd.mp4",
  };
  await mockApi(page, {
    shelf: {
      workspaceId: workspace.id,
      reactionCatalog: shelfReactionCatalog,
      item: missingVideo,
      items: [missingVideo],
    },
    shelfRevealResponse: {
      workspaceId: workspace.id,
      reactionCatalog: shelfReactionCatalog,
      item: resolvedVideo,
      items: [resolvedVideo],
    },
  });
  await page.goto("/inspiration/shelf");

  await page.getByRole("button", { name: "Reveal" }).click();
  const video = page.locator(".media-art video");
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute("src", "https://media.redgifs.com/sample-hd.mp4");
  await expect(page.locator(".media-art iframe")).toHaveCount(0);
  await expect(page.getByText("Open source")).toHaveCount(0);
});

test("Shelf Bellesa reveal can try in-app video and keeps the external provider link", async ({ page }) => {
  const bellesaItem = {
    ...shelfItem,
    id: "shelf-bellesa",
    type: "story",
    source: "bellesa",
    sourceLabel: "BELLESA",
    sourceUrl: "https://www.bellesa.com/videos/4135/hot-property",
    title: "Hot Property",
  };
  await mockApi(page, {
    bellesaVideo: {
      id: 4135,
      title: "Hot Property",
      source: "5f5a5c40034d4a621406a5bf",
      resolutions: "360,480,720",
      image: "https://c.bellesa.co/dkvdbifey/image/upload/v1615830229/video_upload/dhl9os_threeofus.jpg",
      access: { public: 1 },
    },
    shelf: {
      workspaceId: workspace.id,
      reactionCatalog: shelfReactionCatalog,
      item: bellesaItem,
      items: [bellesaItem],
    },
  });
  await page.goto("/inspiration/shelf");

  await page.getByRole("button", { name: "Reveal" }).click();
  const video = page.locator(".media-art video");
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute("src", "https://s.bellesa.co/v/5f5a5c40034d4a621406a5bf/720.mp4");
  await expect(video).toHaveAttribute("controls", "");
  await expect(video).toHaveJSProperty("muted", true);
  await expect(video).toHaveJSProperty("autoplay", true);
  await expect(video).not.toHaveAttribute("loop", /.*/);
  const link = page.getByRole("link", { name: "Open Bellesa" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "https://www.bellesa.co/videos/4135/hot-property");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(page.getByText("Open source")).toHaveCount(0);
});

test("Shelf partner reactions use the partner name", async ({ page }) => {
  const reactedItem = {
    ...shelfItem,
    reactions: { "jordan@example.test": "fire" },
  };
  await mockApi(page, {
    shelf: {
      workspaceId: workspace.id,
      reactionCatalog: shelfReactionCatalog,
      item: reactedItem,
      items: [reactedItem],
    },
  });
  await page.goto("/inspiration/shelf");

  await expect(page.getByText("Jordan taps")).toBeVisible();
  await expect(page.locator(".partner-strip")).toContainText("Jordan");
  await expect(page.locator(".partner-strip")).not.toContainText("Partner");
  await expect(page.getByText("Jordan sees it the moment you do.")).toBeVisible();
});

test("Activity deep links glow Ask and Kink targets", async ({ page }) => {
  await mockApi(page);
  await page.goto("/ask-detail?id=req-1&activity=1");
  await expect(page.locator(".activity-detail-stage[data-activity-highlight='true']")).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);
  await expect(page.getByText("Reply link required")).toHaveCount(0);
  await page.goto("/inspiration/kink?id=kink-1&activity=1");
  await expect(page.locator(".kd-stage[data-activity-highlight='true']")).toBeVisible();
});

test("Ask detail lets the assigned reviewer counter with any act and time", async ({ page }) => {
  const state = {};
  await mockApi(page, state);
  await page.goto("/ask-detail?id=req-1&activity=1");

  await expect(page.getByText("Requested Acts")).toBeVisible();
  await expect(page.getByText("Counter with your own Acts")).toBeVisible();
  await expect(page.getByText("Counter time")).toBeVisible();
  await expect(page.getByText("Reply link required")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);
  const backToSexboard = page.getByRole("link", { name: "Back to Sexboard" });
  await expect(backToSexboard).toBeVisible();
  await expect(backToSexboard).toHaveAttribute("href", "/sexboard");
  const backMetrics = await backToSexboard.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      height: rect.height,
      width: rect.width,
      fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
    };
  });
  expect(backMetrics.height).toBeGreaterThanOrEqual(40);
  expect(backMetrics.width).toBeGreaterThanOrEqual(132);
  expect(backMetrics.fontSize).toBeGreaterThanOrEqual(13);

  await page.getByRole("button", { name: /Sensual massage/ }).click();
  await page.getByRole("button", { name: "Tomorrow" }).click();
  await page.getByLabel("Note").fill("Different vibe.");
  await page.getByRole("button", { name: "Send reply" }).click();

  await expect.poll(() => state.requestReplyBody?.action).toBe("reply");
  await expect.poll(() => state.requestReplyBody?.decisions?.find((item) => item.targetType === "act")?.decision).toBe("Counter");
  await expect.poll(() => state.requestReplyBody?.decisions?.find((item) => item.targetType === "act")?.counter).toContain("Sensual massage");
  await expect.poll(() => state.requestReplyBody?.decisions?.find((item) => item.targetType === "timing")?.counter).toBe("Tomorrow");
  await expect.poll(() => state.requestReplyBody?.note).toBe("Different vibe.");
  await expect(page.getByText("Partner response")).toBeVisible();
});

test("Rowan can pass Avery's Ask from the signed-in reply side", async ({ page }) => {
  const state = {
    request: {
      ...request,
      requesterEmail: "ans@example.test",
      requesterName: "Avery",
      requester: "Avery",
      reviewerEmail: auth.email,
      reviewerName: "Rowan",
      reviewer: "Rowan",
      categories: ["Slow kissing", "Shower sex"],
      note: "Want this tonight?",
      status: "sent",
    },
  };
  await mockApi(page, state);
  await page.goto("/ask-detail?id=req-1");

  await expect(page.getByText("Avery to you")).toBeVisible();
  await page.getByRole("button", { name: "Pass" }).click();
  await page.getByLabel("Note").fill("Not tonight, but ask me again later.");
  await page.getByRole("button", { name: "Send reply" }).click();

  await expect.poll(() => state.requestReplyBody?.action).toBe("reply");
  await expect.poll(() => state.requestReplyBody?.decisions?.map((item) => item.decision)).toEqual(["No", "No"]);
  await expect.poll(() => state.requestReplyBody?.note).toBe("Not tonight, but ask me again later.");
  await expect(page.getByText("Partner response")).toBeVisible();
  await expect(page.getByText("Counter offer")).toHaveCount(0);
});

test("Accepting an Ask counter shows the partner note before approval", async ({ page }) => {
  const state = { request: { ...counteredRequest, feedback: "Different vibe." } };
  await mockApi(page, state);
  await page.goto("/ask-detail?id=req-1");

  await expect(page.getByRole("button", { name: "Accept counter" })).toBeVisible();
  await expect(page.getByText("Different vibe.")).toBeVisible();
  await page.getByRole("button", { name: "Accept counter" }).click();

  await expect.poll(() => state.requestActionBody?.action).toBe("accept_counter");
  await expect(page).toHaveURL(/\/mutual\?/);
  await expect(page).toHaveURL(/requestId=req-1/);
  await expect(page.getByText("The Ask landed.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Both of you said yes." })).toBeVisible();
  await expect(page.getByText(/Sensual massage/)).toBeVisible();
});

test("Counter accepted activity opens the shared approval splash for the partner", async ({ page }) => {
  const state = {
    request: {
      ...counteredRequest,
      status: "on_deck",
      categories: ["💆 Sensual massage"],
      timing: "Tomorrow",
      counterAcceptedAt: "2026-05-23T00:25:00.000Z",
      acceptedCounters: counterDecisions,
    },
    activity: {
      ...cloneJson(activityResponse),
      unreadTotal: 1,
      unreadByResource: { "request-board": 1 },
      items: [
        {
          id: "counter-accepted-activity",
          workspaceId: workspace.id,
          resource: "request-board",
          resourceLabel: "Sexboard",
          action: "counter_accepted",
          label: "Counter accepted",
          entityId: "req-1",
          actorEmail: "jordan@example.test",
          actorName: "Jordan",
          at: "2026-05-23T00:25:00.000Z",
          passive: false,
          unread: true,
        },
      ],
    },
  };
  await mockApi(page, state);
  await page.goto("/sexboard");

  const activityRow = page.locator(".live-activity-item").filter({ hasText: "Counter accepted" });
  await expect(activityRow).toHaveAttribute("href", /\/mutual\?source=ask&requestId=req-1/);

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("sexualsync:room-event", {
      detail: {
        resource: "request-board",
        action: "counter_accepted",
        entityId: "req-1",
        actorEmail: "jordan@example.test",
        actorName: "Jordan",
      },
    }));
  });

  await expect(page).toHaveURL(/\/mutual\?/);
  await expect(page.getByRole("heading", { name: "Both of you said yes." })).toBeVisible();
  await expect(page.getByText(/Sensual massage/)).toBeVisible();
});

test("Request reply link exposes all-yes answer controls", async ({ page }) => {
  const state = {};
  await mockApi(page, state);
  await page.goto("/review?token=reply-token");

  await expect(page.getByRole("heading", { name: "Reply to Ask" })).toBeVisible();
  await expect(page.getByText(`${request.requesterName} to you`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);
  await expect(page.getByText("Requested Acts")).toBeVisible();
  await expect(page.getByText("Counter with your own Acts")).toBeVisible();
  await expect(page.getByText("Counter time")).toBeVisible();
  const cadenceMetrics = await page.locator(".review-decision-card", { hasText: "Counter time" }).locator(".cadence-grid").evaluate((grid) => {
    const gridRect = grid.getBoundingClientRect();
    const buttons = Array.from(grid.querySelectorAll("button")).map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        height: rect.height,
        text: button.textContent || "",
        scrollWidth: button.scrollWidth,
        clientWidth: button.clientWidth,
      };
    });
    return {
      columns: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
      gridLeft: gridRect.left,
      gridRight: gridRect.right,
      buttons,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  expect(cadenceMetrics.columns).toBe(3);
  expect(cadenceMetrics.horizontalOverflow).toBeLessThanOrEqual(0);
  expect(cadenceMetrics.buttons).toHaveLength(3);
  for (const button of cadenceMetrics.buttons) {
    expect(button.left).toBeGreaterThanOrEqual(cadenceMetrics.gridLeft - 1);
    expect(button.right).toBeLessThanOrEqual(cadenceMetrics.gridRight + 1);
    expect(button.height).toBeLessThanOrEqual(62);
    expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1);
  }

  await page.getByRole("button", { name: "Yes to all" }).click();
  await page.getByRole("button", { name: "Send reply" }).click();

  await expect.poll(() => state.reviewSubmitBody?.decisions?.[0]?.decision).toBe("Yes");
  await expect(page.getByRole("heading", { name: "Reply sent" })).toBeVisible();
});

test("Rowan can pass Avery's Ask from a private reply link", async ({ page }) => {
  const state = {
    request: {
      ...request,
      requesterEmail: "ans@example.test",
      requesterName: "Avery",
      requester: "Avery",
      reviewerEmail: auth.email,
      reviewerName: "Rowan",
      reviewer: "Rowan",
      categories: ["Slow kissing"],
      status: "sent",
    },
  };
  await mockApi(page, state);
  await page.goto("/review?token=reply-token");

  await expect(page.getByText("Avery to you")).toBeVisible();
  await page.getByRole("button", { name: "Pass" }).click();
  await page.getByRole("button", { name: "Send reply" }).click();

  await expect.poll(() => state.reviewSubmitBody?.decisions?.[0]?.decision).toBe("No");
  await expect(page.getByRole("heading", { name: "Reply sent" })).toBeVisible();
});

test("Root review links preserve the reply token", async ({ page }) => {
  await mockApi(page);
  await page.goto("/?review=reply-token");

  await expect(page).toHaveURL(/\/review\?token=reply-token$/);
  await expect(page.getByRole("heading", { name: "Reply to Ask" })).toBeVisible();
});
