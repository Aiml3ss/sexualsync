/**
 * Types mirroring the shapes returned by /api/* (Cloudflare Pages Functions).
 *
 * These are derived from reading the JS source in `../../functions/api/*` —
 * the backend isn't typed, so a few fields are best-effort guesses (marked
 * with `// guess:` comments). If the API surface changes, this file is the
 * blast-radius.
 */

// ---------- Profile / workspace ----------

export type WorkspaceMemberStatus = "active" | "invited" | "removed";

export interface WorkspaceMember {
  email: string;
  displayName: string;
  role: string;        // guess: "owner" | "member" — backend stringly-typed
  status: WorkspaceMemberStatus;
  invitedAt: string;
  joinedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "deleted" | string;
  productMode: "couples" | string;
  members: WorkspaceMember[];
  settings: {
    reauthOnLaunch?: boolean;
    roomE2eeEnabled?: boolean;
    roomE2eeVerifier?: RoomEncryptedBox;
    [key: string]: unknown;
  };
  deletion: unknown | null;
}

export interface Profile {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string;
  createdAt: string;
  updatedAt: string;
  settings: {
    theme?: "light" | "dark" | "system";
    defaultWorkspaceId?: string;
    shareAttentionSignals?: boolean;
    [key: string]: unknown;
  };
}

export interface PendingInvite {
  id: string;
  workspaceId: string;
  workspaceName: string;
  inviterEmail: string;
  inviterName: string;
  inviteeEmail: string;
  createdAt: string;
  expiresAt: string;
  status: string;
  claimable?: boolean;
}

export interface AuthInfo {
  email: string;
  person: string;
  isKnownCoupleMember: boolean;
  provider: string;
}

export interface ProfileResponse {
  profile: Profile | null;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  activeWorkspace: Workspace | null;
  pendingInvites: PendingInvite[];
  auth: AuthInfo;
  app: {
    name: string;
    knownLegacyPeople: Record<string, string>;
  };
}

export interface PublicStatsResponse {
  couplesInSync: number;
}

export interface PresenceResponse {
  me: {
    email: string;
    lastSeen: string;
    displayName: string;
  };
  partner: {
    email: string;
    lastSeen: string | null;
    displayName: string;
  } | null;
  daysInSync: number;
}

export interface BootstrapResponse extends ProfileResponse {
  bootstrap: {
    workspaceId: string;
    requests: RequestBoardResponse;
    fantasy: FantasyBacklogResponse;
    boundaries: BoundariesResponse;
    acts: ActsResponse;
  };
}

// Per-round submission status for a double-blind game (Sex Quiz / Green Lights),
// surfaced on the Sexboard as a handoff. Booleans + reveal state only — no answers.
export interface GameRoundStatus {
  status: string;
  mySubmitted: boolean;
  partnerSubmitted: boolean;
  revealed: boolean;
}

export interface SexboardResponse extends ProfileResponse {
  sexboard: {
    workspaceId: string;
    board: RequestBoardResponse;
    pile: PileView | null;
    pileSessions: PileSession[];
    blindReveal: BlindReveal | null;
    blindReveals: BlindReveal[];
    fantasy: FantasyBacklogResponse;
    presence: PresenceResponse | null;
    activity: ActivityResponse;
    sexQuiz: GameRoundStatus | null;
    greenLights: GameRoundStatus | null;
  };
}

export type FeedbackSentiment = "positive" | "neutral" | "negative";

export interface FeedbackPayload {
  workspaceId: string;
  message: string;
  sentiment: FeedbackSentiment;
  mayContact: boolean;
  route?: string;
  surface?: string;
}

export interface FeedbackResponse {
  ok: true;
  item: {
    id: string;
    at: string;
  };
}

export interface AdminFeedbackItem {
  id: string;
  at: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  name: string;
  sentiment: FeedbackSentiment;
  message: string;
  route: string;
  surface: string;
  mayContact: boolean;
}

export type AdminSystemServiceStatus = "ok" | "warning" | "down" | "disabled";

export interface AdminSystemService {
  id: string;
  label: string;
  status: AdminSystemServiceStatus;
  detail: string;
  critical: boolean;
}

export interface AdminAiAggregate {
  id: string;
  total: number;
  ok: number;
  error: number;
  blocked: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  avgLatencyMs: number;
  lastAt: string;
  reasons: Record<string, number>;
  features: AdminAiAggregate[];
}

export interface AdminAiRecentEvent {
  at: string;
  feature: string;
  outcome: "ok" | "error" | "blocked";
  reason: string;
  status: number;
  latencyMs: number;
  model: string;
}

export interface AdminAiRoute {
  id: string;
  label: string;
  enabled: boolean;
  flag: string;
  defaultEnabled: boolean;
}

export interface AdminAiStatus {
  enabled: boolean;
  configured: boolean;
  model: string;
  baseHost: string;
  limits: {
    perMinute: number;
    perHour: number;
  };
  routes: AdminAiRoute[];
  today: AdminAiAggregate;
  currentHour: AdminAiAggregate;
  recent: AdminAiRecentEvent[];
}

export interface AdminDashboardResponse {
  generatedAt: string;
  adminAccess: string;
  systemStatus: {
    ok: boolean;
    summary: Record<AdminSystemServiceStatus, number>;
    services: AdminSystemService[];
  };
  ai: AdminAiStatus;
  stats: {
    profilesTotal: number;
    workspacesTotal: number;
    activeWorkspaces: number;
    deletionPendingWorkspaces: number;
    activeMembers: number;
    invitedMembers: number;
    removedMembers: number;
    pendingInvites: number;
    feedbackTotal: number;
    mayContactFeedback: number;
    latestFeedbackAt: string;
    feedbackBySentiment: Record<FeedbackSentiment, number>;
    profilesLast7d: number;
    workspacesLast7d: number;
    feedbackLast7d: number;
    workspaceActivationRate: number;
    contactableFeedbackRate: number;
    issueFeedbackRate: number;
    workspaceStatusCounts: Record<string, number>;
    memberStatusCounts: Record<string, number>;
    topFeedbackRoutes: Array<{
      route: string;
      count: number;
    }>;
  };
  feedback: AdminFeedbackItem[];
  recentProfiles: Array<{
    id: string;
    email: string;
    displayName: string;
    createdAt: string;
    updatedAt: string;
    workspaceNames: string[];
  }>;
  workspaces: Array<{
    id: string;
    name: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    members: {
      active: number;
      invited: number;
      removed: number;
    };
  }>;
}

export interface AdminDeleteFeedbackResponse {
  ok: true;
  workspaceId: string;
  deletedFeedbackId: string;
  remainingFeedback: number;
}

// ---------- Activity ----------

export type ActivityResource =
  | "request-board"
  | "fantasy-backlog"
  | "shelf"
  | "vault"
  | "pile"
  | "blind-reveals";

export interface ActivityItem {
  id: string;
  workspaceId: string;
  resource: ActivityResource;
  resourceLabel: string;
  action: string;
  label: string;
  entityId: string;
  actorEmail: string;
  actorName: string;
  at: string;
  passive?: boolean;
  groupedCount?: number;
  sourceIds?: string[];
  unread: boolean;
}

export interface ActivityResponse {
  workspaceId: string;
  items: ActivityItem[];
  unreadTotal: number;
  unreadByResource: Partial<Record<ActivityResource, number>>;
  readState: {
    all?: string;
    resources?: Partial<Record<ActivityResource, string>>;
    dismissed?: string[];
  };
}

// ---------- Health ----------

export type HealthRangeId = "30d" | "90d" | "all";

export interface HealthRange {
  id: HealthRangeId;
  label: string;
  days: number | null;
  from: string;
  to: string;
}

export interface HealthTotals {
  sexEvents: number;
  sexActs: number;
  uniqueActs: number;
  askEvents: number;
  pileEvents: number;
}

export interface HealthRhythmBucket {
  date: string;
  sexEvents: number;
  sexActs: number;
  askEvents: number;
  pileEvents: number;
}

export interface HealthActCount {
  label: string;
  count: number;
  askCount: number;
  pileCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  newInRange: boolean;
}

export interface HealthEventAct {
  label: string;
  emoji: string;
}

export interface HealthEvent {
  id: string;
  type: "ask" | "pile";
  title: string;
  at: string;
  acts: string[];
  actSummaries?: HealthEventAct[];
  actorName: string;
  partnerName: string;
  sourceId: string;
  sourceStatus: string;
  sourceHref: string;
}

export interface HealthResponse {
  workspaceId: string;
  range: HealthRange;
  totals: HealthTotals;
  rhythm: HealthRhythmBucket[];
  topActs: HealthActCount[];
  events: HealthEvent[];
  insights: {
    lastEventAt: string;
    daysSinceLast: number | null;
    newActs: HealthActCount[];
    requesterSplit: Array<{ name: string; count: number }>;
    sourceSplit: {
      ask: number;
      pile: number;
    };
  };
}

// ---------- Request board ----------

export type RequestStatus =
  | "draft"
  | "pending"
  | "sent"
  | "maybe"
  | "reviewed"
  | "on_deck"
  | "completed"
  | "archived"
  | "expired";

export type Timing = "Tonight" | "Mid-day" | "Tomorrow" | "Next week";
export type Filming = "Yes" | "No";
export type Decision = "Yes" | "Maybe" | "Let's chat" | "Counter" | "No";

export interface DecisionItem {
  label: string;
  decision: Decision | "";
  counter: string;
  counterActId: string;
  note: string;
  targetType: "act" | "timing" | "filming" | "general";
  actId: string;
}

export interface RequestRecord {
  id: string;
  workspaceId: string;
  status: RequestStatus;
  requester: string;
  reviewer: string;
  requesterEmail: string;
  reviewerEmail: string;
  requesterName?: string;
  reviewerName?: string;
  categories: string[];
  timing: Timing;
  filming: Filming;
  decisions: DecisionItem[];
  counters: DecisionItem[];
  boundaryConflicts: string[];
  note: string;
  feedback: string;
  matchNarration?: string;
  matchNarrationAt?: string;
  reviewSummary?: string;
  seededFromKinkId?: string;
  acceptedCounters?: DecisionItem[];
  acceptedTimingCounter?: DecisionItem | null;
  acceptedFilmingCounter?: DecisionItem | null;
  counterAcceptedAt?: string;
  restoredAt?: string;
  passedAt?: string;
  passedByEmail?: string;
  passedByName?: string;
  // Set when the reviewer defers ("Maybe") instead of giving a final answer.
  // The Ask stays repliable; these only record who deferred and when.
  maybeAt?: string;
  maybeByEmail?: string;
  maybeByName?: string;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
  reviewedAt?: string;
  completedAt?: string;
  // Reminder tracking — shared by the automatic 4h/24h nudge and the manual
  // "Remind" button. The UI uses lastReminderAt to show cooldown + "reminded Xm ago".
  lastReminderAt?: string;
  reminderCount?: number;
  reminderDelivery?: string;
  encryptedPayload?: RoomEncryptedBox;
  encryptedReply?: RoomEncryptedBox;
  e2eeLocked?: boolean;
}

export interface RequestBoardResponse {
  workspaceId: string;
  requests: RequestRecord[];
  activeRequests: RequestRecord[];
  history: RequestRecord[];
}

export interface ReviewTokenRequest {
  id: string;
  workspaceId: string;
  requesterEmail: string;
  requesterName: string;
  reviewerEmail: string;
  reviewerName: string;
  categories: string[];
  timing: Timing;
  filming: Filming;
  status: RequestStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
  encryptedPayload?: RoomEncryptedBox;
  encryptedReply?: RoomEncryptedBox;
  e2eeLocked?: boolean;
}

export interface ReviewTokenResolveResponse {
  token: {
    expiresAt: string;
    workspaceId: string;
    requestId: string;
  };
  request: ReviewTokenRequest;
  workspace: {
    id: string;
    displayName: string;
    members: Array<{
      email: string;
      displayName: string;
    }>;
  };
}

export interface ReviewTokenSubmitResponse {
  request: ReviewTokenRequest;
  token: {
    expiresAt: string;
    consumedAt: string;
  };
  emailResult?: unknown;
}

// ---------- Boundaries ----------

export type BoundaryType = "Hard No" | "Talk First" | "Soft Limit" | "Yes With Conditions";

export interface Boundary {
  id: string;
  workspaceId: string;
  text: string;
  type: BoundaryType;
  addedByEmail: string;
  addedByName: string;
  createdAt: string;
  updatedAt: string;
  updatedByEmail?: string;
  updatedByName?: string;
  encryptedText?: RoomEncryptedBox;
  e2eeLocked?: boolean;
}

export interface BoundariesResponse {
  workspaceId: string;
  boundaries: Boundary[];
}

// ---------- Approved acts ----------

export type Comfort = "favorite" | "curious" | "maybe" | "no" | "needs_prep";

export interface Act {
  id: string;
  workspaceId: string;
  label: string;
  encryptedPayload?: RoomEncryptedBox;
  e2eeLocked?: boolean;
  icon: string;
  tags: string[];
  comfort: Record<string, Comfort>;
  source: "built_in" | "custom" | "approved_counter" | "fantasy_promoted";
  addedByEmail: string;
  addedByName: string;
  approvedByEmail: string;
  approvedByName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActsResponse {
  workspaceId: string;
  acts: Act[];
}

// ---------- Inspiration / Kinks ----------

export type KinkReactionId =
  | "curious"
  | "hell_yeah"
  | "tell_me_more"
  | "me_too"
  | "give_me_a_minute"
  | "not_for_me";

export interface KinkReactionOption {
  id: KinkReactionId;
  glyph: string;
  label: string;
  caption: string;
  tone: "positive" | "pause" | "no";
}

export interface KinkReaction {
  by: string;
  id: KinkReactionId;
  glyph: string;
  label: string;
  caption: string;
  tone: "positive" | "pause" | "no";
  note: string;
  encryptedNote?: RoomEncryptedBox;
  createdAt: string;
  seenByAuthorAt?: string;
}

export interface KinkComment {
  id: string;
  email: string;
  name: string;
  text: string;
  encryptedText?: RoomEncryptedBox;
  e2eeLocked?: boolean;
  at: string;
  editedAt?: string;
  editedByEmail?: string;
  editedByName?: string;
}

export interface ChatReaction {
  by: string;
  emoji: string;
}

export interface ChatMessage {
  id: string;
  seq: number;
  email: string;
  name: string;
  text: string;
  at: string;
  reactions: ChatReaction[];
  encryptedText?: RoomEncryptedBox;
  e2eeLocked?: boolean;
  replyToId?: string;
  editedAt?: string;
  deletedAt?: string;
  // An encrypted image attachment. The bytes live in R2 (fetched via
  // /api/chat-media by mediaId); `key`/`iv` decrypt them and are present only
  // when Room Encryption is OFF — when it's on they ride inside encryptedText
  // and are merged onto `media` after the box is decrypted client-side.
  media?: ChatMedia;
  // Client-only: an optimistic message shown instantly while its POST is in
  // flight. Never sent by the server; cleared when the real message replaces it.
  pending?: boolean;
}

export interface ChatMedia {
  mediaId: string;
  mediaType: string;
  mediaSize: number;
  key?: string;
  iv?: string;
}

export interface ChatThreadResponse {
  workspaceId: string;
  seq: number;
  messages: ChatMessage[];
  readCursors: Record<string, number>;
  readAt?: Record<string, string>;
}

export interface KinkIdea {
  id: string;
  workspaceId: string;
  text: string;
  encryptedText?: RoomEncryptedBox;
  e2eeLocked?: boolean;
  tags: string[];
  addedByEmail: string;
  addedByName: string;
  notes: Record<string, string>;
  comments: KinkComment[];
  reactions: KinkReaction[];
  status?: string;
  statusByEmail?: string;
  statusByName?: string;
  statusAt?: string;
  statusHistory: Array<{
    email: string;
    name: string;
    status: string;
    tone?: string;
    glyph?: string;
    caption?: string;
    at: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface FantasyBacklogResponse {
  workspaceId: string;
  reactionCatalog: KinkReactionOption[];
  ideas: KinkIdea[];
  graveyard: KinkIdea[];
}

// ---------- Shelf ----------

export type ShelfReactionId = "think" | "fire" | "drool" | "wrecked" | "pass";

export interface ShelfReactionOption {
  id: ShelfReactionId;
  emoji: string;
  label: string;
  caption: string;
  tone: "positive" | "pass";
}

export interface ShelfItem {
  id: string;
  type: "gif" | "story" | "passage" | string;
  source: string | null;
  sourceLabel: string;
  sourceUrl: string;
  sourceId?: string;
  encryptedContent?: RoomEncryptedBox;
  embedUrl: string;
  posterUrl: string;
  videoHdUrl: string;
  videoSdUrl: string;
  passageText: string;
  title: string;
  encryptedTitle?: RoomEncryptedBox;
  e2eeLocked?: boolean;
  addedByEmail: string;
  addedByName: string;
  addedAt: string;
  reactions: Record<string, ShelfReactionId>;
}

export interface ShelfResponse {
  workspaceId?: string;
  reactionCatalog: ShelfReactionOption[];
  item?: ShelfItem;
  items: ShelfItem[];
  duplicate?: boolean;
}

// ---------- Vault ----------

export type VaultReactionId = ShelfReactionId;

export interface EncryptedBox {
  v?: string;
  ciphertext: string;
  iv: string;
}

export interface VaultComment {
  id: string;
  email: string;
  name: string;
  body: EncryptedBox;
  at: string;
}

export interface VaultMoment {
  id: string;
  timestampMs: number;
  frameVersion?: string;
  frameIv: string;
  frameSize: number;
  title: EncryptedBox;
  note: EncryptedBox;
  createdByEmail: string;
  createdByName: string;
  createdAt: string;
}

export interface VaultItem {
  id: string;
  workspaceId: string;
  mediaType: string;
  mediaSize: number;
  originalSize: number;
  durationMs: number;
  addedByEmail: string;
  addedByName: string;
  addedAt: string;
  updatedAt: string;
  displayTitle: string;
  encryption: {
    version: string;
    algorithm: string;
    kdf: string;
    iterations: number;
    salt: string;
    videoIv: string;
  };
  title: EncryptedBox;
  reactions: Record<string, VaultReactionId>;
  comments: VaultComment[];
  moments: VaultMoment[];
  hasVideo: boolean;
}

export interface VaultResponse {
  workspaceId?: string;
  reactionCatalog: ShelfReactionOption[];
  item?: VaultItem;
  items: VaultItem[];
}

// ---------- Games ----------

export interface PileEncryptedLabel {
  token: string;
  encryptedLabel: RoomEncryptedBox;
}

export interface PileView {
  revealAt: string;
  startedAt: string;
  startedByEmail: string;
  maxDropCount?: number;
  /** Compatibility alias for active Piles created before this became a cap. */
  targetDropCount?: number;
  targetMaxDropCount?: number;
  actPoolCount?: number;
  isRevealed: boolean;
  mine: string[];
  encryptedMine?: PileEncryptedLabel[];
  counts: Record<string, number>;
  partnerHasDropped?: boolean;
  partnerLabels: Record<string, string[]> | null;
  encryptedPartnerLabels?: Record<string, PileEncryptedLabel[]>;
  overlap: string[] | null;
  encryptedOverlap?: PileEncryptedLabel[];
  onlyMine: string[] | null;
  encryptedOnlyMine?: PileEncryptedLabel[];
  onlyTheirs: string[] | null;
  encryptedOnlyTheirs?: PileEncryptedLabel[];
  revealNarration: string;
}

export interface PileSession {
  id: string;
  workspaceId: string;
  acts: string[];
  encryptedActs?: PileEncryptedLabel[];
  overlap?: string[];
  encryptedOverlap?: PileEncryptedLabel[];
  quietDropCount: number;
  revealAt: string;
  startedAt: string;
  lockedAt: string;
  lockedByEmail: string;
  lockedByName: string;
  revealNarration: string;
}

export interface PileResponse {
  pile: PileView | null;
  session?: PileSession;
  sessions?: PileSession[];
}

export interface BlindRevealEntry {
  email: string;
  name: string;
  text: string;
  encryptedText?: RoomEncryptedBox;
  e2eeLocked?: boolean;
  promotedIdeaId: string;
  createdAt: string;
  updatedAt: string;
}

export interface BlindReveal {
  id: string;
  workspaceId: string;
  prompt: string;
  encryptedPrompt?: RoomEncryptedBox;
  e2eeLocked?: boolean;
  status: "open" | "revealed" | "archived";
  createdAt: string;
  updatedAt: string;
  revealedAt: string;
  archivedAt: string;
  requiredCount: number;
  submittedCount: number;
  mySubmitted: boolean;
  partnerSubmitted: boolean;
  // True only for the person who started this reveal — gates the "take back" action.
  startedByMe: boolean;
  myEntry: BlindRevealEntry | null;
  entries: BlindRevealEntry[];
}

export interface BlindRevealResponse {
  workspaceId: string;
  activeReveal: BlindReveal | null;
  reveal?: BlindReveal | null;
  reveals?: BlindReveal[];
  idea?: KinkIdea;
  promotedIdeaId?: string;
  cancelled?: boolean;
}

// ---------- Sex Quiz (double-blind desire profile) ----------

export interface SexQuizRating {
  interest: "pass" | "curious" | "into";
  role?: "give" | "receive" | "both";
}

export interface SexQuizMatch {
  cardId: string;
  myRole: string;
  partnerRole: string;
  complementary: boolean;
}

export interface SexQuizResponse {
  workspaceId: string;
  status: "open" | "revealed";
  requiredCount: number;
  mySubmitted: boolean;
  partnerSubmitted: boolean;
  updatedAt: string;
  revealedAt: string;
  myRatings: Record<string, SexQuizRating>;
  myTopPicks: string[];
  matches: SexQuizMatch[];
  curiousTogether: Array<{ cardId: string }>;
  syncScore: number | null;
  partnerTopPicks: string[];
  partnerName: string;
  fullRevealMine: boolean;
  fullRevealPartner: boolean;
  partnerRatings: Record<string, SexQuizRating> | null;
}

// ---------- Green Lights (comfort & agreements) ----------

export type GreenLightValue = "good" | "depends" | "no";

export interface GreenLightAnswer {
  // "good" | "depends" | "no" for comfort cards; a cadence option id for cadence cards.
  value: string;
  note?: string;
}

export interface GreenLightsResponse {
  workspaceId: string;
  status: "open" | "revealed";
  requiredCount: number;
  mySubmitted: boolean;
  partnerSubmitted: boolean;
  updatedAt: string;
  revealedAt: string;
  myAnswers: Record<string, GreenLightAnswer>;
  partnerName: string;
  // Reveal-gated: the partner's full answer set. All the buckets (green lights,
  // agreed limits, talk-about-these, cadence gaps, sync %) are computed
  // client-side from myAnswers + partnerAnswers via the deck — the single
  // source of truth for each card's answer scale.
  partnerAnswers: Record<string, GreenLightAnswer>;
}

// ---------- Prompts ----------

export interface PromptResponse {
  text: string;
  kind?: "confidence" | "curiosity";
  bucket?: string;
}

// ---------- Generic ----------

export interface ApiError {
  error: string;
}

export interface RoomEncryptedBox {
  __sxsRoomEncrypted: true;
  version: "sxs-room-e2ee-v1";
  // Present only on v2+ boxes (absent = v1). Selects the PBKDF2 iteration count
  // on read; the `version` string is unchanged across KDF versions. Mirrors the
  // canonical RoomEncryptedBox in web/src/lib/room-crypto.ts.
  kdf?: "v2";
  algorithm: "AES-GCM";
  iv: string;
  ciphertext: string;
}

export type E2eeMigrationSurface =
  | "request-board"
  | "boundaries"
  | "approved-acts"
  | "fantasy-backlog"
  | "blind-reveals"
  | "shelf"
  | "pile-active"
  | "pile-sessions";

export interface E2eeStatusResponse {
  workspaceId: string;
  roomE2eeEnabled: boolean;
  legacyPlaintext: {
    total: number;
    surfaces: Record<string, number>;
  };
  canReencryptInBrowser: boolean;
}

export interface E2eeReencryptResponse {
  ok: true;
  workspaceId: string;
  surface: E2eeMigrationSurface;
  changed: number;
}
