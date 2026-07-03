/**
 * Tiny fetch wrapper for the Sexualsync API.
 *
 * The backend lives at `/api/*` (Cloudflare Pages Functions). Auth is handled
 * by Cloudflare Access at the edge — the browser sends a CF_Authorization
 * cookie and the function validates it. From the client's perspective, all
 * we do is forward the cookie (`credentials: "same-origin"`) and react to
 * 401 by bouncing to the CF Access login redirect.
 *
 * In dev, `next.config.mjs` rewrites `/api/*` to the deployed origin. See
 * that file for caveats.
 */

import { enqueueWrite, generateIdempotencyKey } from "./offline-queue";
import { encryptChatImage, decryptChatImage } from "./chat-media-crypto";
import { invalidateResource } from "./resource-cache";

const PROFILE_STALE_EVENT = "ss:profile-stale";
function dispatchProfileStale(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(PROFILE_STALE_EVENT));
  } catch {
    // CustomEvent constructor can be absent in legacy environments —
    // the cache will refresh on next TTL expiry anyway.
  }
}
import type {
  ActsResponse,
  Act,
  ActivityResource,
  ActivityResponse,
  AdminDeleteFeedbackResponse,
  AdminDashboardResponse,
  ApiError,
  BootstrapResponse,
  BoundariesResponse,
  Boundary,
  BoundaryType,
  BlindRevealResponse,
  SexQuizResponse,
  SexQuizRating,
  GreenLightsResponse,
  GreenLightAnswer,
  ChatMessage,
  ChatMedia,
  ChatThreadResponse,
  ProfileResponse,
  PromptResponse,
  PileResponse,
  PresenceResponse,
  PublicStatsResponse,
  RequestBoardResponse,
  RequestRecord,
  ReviewTokenResolveResponse,
  ReviewTokenSubmitResponse,
  RoomEncryptedBox,
  Timing,
  Filming,
  FantasyBacklogResponse,
  FeedbackPayload,
  FeedbackResponse,
  E2eeMigrationSurface,
  E2eeReencryptResponse,
  E2eeStatusResponse,
  HealthRangeId,
  HealthResponse,
  ShelfReactionId,
  ShelfResponse,
  SexboardResponse,
  VaultReactionId,
  VaultResponse,
} from "./types";
import { clearIntentionalSignOut, hasIntentionalSignOut } from "./auth-state";
import {
  decryptBootstrapResponse,
  decryptActsResponse,
  decryptBlindRevealResponse,
  decryptBoundariesResponse,
  decryptFantasyBacklogResponse,
  decryptPileResponse,
  decryptRequestBoardResponse,
  decryptReviewTokenResolveResponse,
  decryptReviewTokenSubmitResponse,
  decryptSexboardResponse,
  decryptShelfResponse,
  prepareBoundaryPayload,
  prepareActPayload,
  prepareCreateBlindRevealPayload,
  prepareCreateRequestPayload,
  prepareKinkCommentPayload,
  prepareKinkReactionPayload,
  prepareKinkTextPayload,
  prepareReplyPayload,
  prepareReviewTokenSubmitPayload,
  prepareShelfItemPayload,
  prepareShelfTitlePayload,
  preparePileDropPayload,
  preparePileUndropPayload,
  prepareSubmitBlindRevealPayload,
  collectRoomE2eeRecoveryCandidates,
} from "./room-record-crypto";
import {
  recoverRoomE2eeWithCandidates,
  encryptRoomJson,
  tryDecryptRoomJson,
  hasUnlockedRoomE2eeKey,
} from "./room-crypto";

export class ApiUnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "ApiUnauthorizedError";
  }
}

export class ApiFailureError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiFailureError";
    this.status = status;
  }
}

const PWA_AUTO_GOOGLE_KEY = "ss:pwa-auto-google";
const PWA_AUTO_GOOGLE_COOLDOWN_MS = 2 * 60 * 1000;
const AUTH_PROVIDER_KEY = "ss:last-auth-provider";

// Hard ceiling on first-party Google reconnect attempts. Safari ITP / Cookie
// Jar Partitioning can persistently reject the session cookie, in which case
// the 401 → reconnect → 401 loop never converges. After this many attempts
// in PWA_AUTO_GOOGLE_LOOP_WINDOW_MS we route the user to /auth-blocked.
const PWA_AUTO_GOOGLE_LOOP_KEY = "ss:pwa-auto-google-loop";
const PWA_AUTO_GOOGLE_LOOP_WINDOW_MS = 10 * 60 * 1000;
const PWA_AUTO_GOOGLE_LOOP_CAP = 3;

// Default fetch timeout. Vault media reads override this to 60s; everything
// else aborts after 15s so a hung TCP connection doesn't park a spinner.
const DEFAULT_FETCH_TIMEOUT_MS = 15 * 1000;
const MEDIA_FETCH_TIMEOUT_MS = 60 * 1000;

export class ApiTimeoutError extends Error {
  constructor() {
    super("Request timed out.");
    this.name = "ApiTimeoutError";
  }
}

export class ApiOfflineQueuedError extends Error {
  readonly queueId: number;
  constructor(queueId: number) {
    super("Offline. The change is saved and will sync when the network returns.");
    this.name = "ApiOfflineQueuedError";
    this.queueId = queueId;
  }
}

function isStandaloneDisplay() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)")?.matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function currentReturnTo() {
  if (typeof window === "undefined") return "/sexboard";
  const { pathname, search, hash } = window.location;
  if (!pathname || pathname === "/" || pathname.startsWith("/api/auth/")) return "/sexboard";
  return `${pathname}${search}${hash}`;
}

function readPwaReconnectAttempt() {
  if (typeof window === "undefined") return { returnTo: "", at: 0 };
  try {
    const raw = window.sessionStorage.getItem(PWA_AUTO_GOOGLE_KEY) || "";
    const parsed = JSON.parse(raw);
    return {
      returnTo: String(parsed?.returnTo || ""),
      at: Number(parsed?.at || 0),
    };
  } catch {
    return { returnTo: "", at: 0 };
  }
}

export function clearPwaReconnectAttempt() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PWA_AUTO_GOOGLE_KEY);
  } catch {
    // Some embedded browsers can deny storage access; reconnect still works without cleanup.
  }
}

export function rememberEmailAuthProvider(): void {
  clearIntentionalSignOut();
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTH_PROVIDER_KEY, "email");
  } catch {
    // Provider memory only chooses the next reconnect surface.
  }
}

export function rememberLocalAuthProvider(): void {
  clearIntentionalSignOut();
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTH_PROVIDER_KEY, "local");
  } catch {
    // Provider memory only chooses the next reconnect surface.
  }
}

export function rememberGoogleAuthProvider(): void {
  clearIntentionalSignOut();
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTH_PROVIDER_KEY, "google");
  } catch {
    // Provider memory only chooses the next reconnect surface.
  }
}

function lastAuthProvider(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(AUTH_PROVIDER_KEY) || "";
  } catch {
    return "";
  }
}

function recordReconnectAttempt(): number {
  if (typeof window === "undefined") return 0;
  try {
    const now = Date.now();
    const raw = window.localStorage.getItem(PWA_AUTO_GOOGLE_LOOP_KEY);
    const log: number[] = raw ? JSON.parse(raw) : [];
    const recent = log.filter((t) => typeof t === "number" && now - t < PWA_AUTO_GOOGLE_LOOP_WINDOW_MS);
    recent.push(now);
    window.localStorage.setItem(PWA_AUTO_GOOGLE_LOOP_KEY, JSON.stringify(recent));
    return recent.length;
  } catch {
    return 0;
  }
}

export function clearReconnectAttemptLog(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(PWA_AUTO_GOOGLE_LOOP_KEY); } catch { /* ignore */ }
}

export function maybeReconnectStandalonePwa(
  returnTo = currentReturnTo(),
  options: { preferBrowserSession?: boolean } = {},
): boolean {
  if (typeof window === "undefined" || !isStandaloneDisplay()) return false;
  if (hasIntentionalSignOut()) return false;
  if (new URLSearchParams(window.location.search).has("auth")) return false;

  const target = returnTo && returnTo.startsWith("/") && !returnTo.startsWith("/api/auth/")
    ? returnTo
    : "/sexboard";
  const attempt = readPwaReconnectAttempt();
  const recentlyTried = attempt.returnTo === target && Date.now() - attempt.at < PWA_AUTO_GOOGLE_COOLDOWN_MS;
  if (recentlyTried) return false;

  // Hard cap: if we've tried more than PWA_AUTO_GOOGLE_LOOP_CAP times in the
  // rolling window, Safari ITP / cookie partitioning is almost certainly
  // rejecting our session cookie. Stop the redirect loop and land the user
  // on a page that explains what to do.
  const attemptsInWindow = recordReconnectAttempt();
  if (attemptsInWindow > PWA_AUTO_GOOGLE_LOOP_CAP) {
    window.location.replace("/auth-blocked");
    return true;
  }

  try {
    window.sessionStorage.setItem(PWA_AUTO_GOOGLE_KEY, JSON.stringify({ returnTo: target, at: Date.now() }));
  } catch {
    // Storage is only loop protection. If unavailable, still attempt the reconnect.
  }

  if (!options.preferBrowserSession && lastAuthProvider() === "email") {
    const params = new URLSearchParams({ signin: "email", returnTo: target, source: "pwa-auto" });
    window.location.replace(`/signin?${params.toString()}`);
    return true;
  }

  if (!options.preferBrowserSession && lastAuthProvider() === "local") {
    const params = new URLSearchParams({ signin: "local", returnTo: target, source: "pwa-auto" });
    window.location.replace(`/signin?${params.toString()}`);
    return true;
  }

  const source = options.preferBrowserSession ? "pwa-launch" : "pwa-auto";
  const params = new URLSearchParams({ returnTo: target, source });
  window.location.replace(`/api/auth/google?${params.toString()}`);
  return true;
}

function withTimeout(init: RequestInit, timeoutMs: number): { init: RequestInit; cancel: () => void } {
  // If the caller already passed an AbortController signal, daisy-chain ours
  // so either the caller-side abort or the timeout aborts the fetch.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("Timeout", "AbortError")), timeoutMs);
  if (init.signal) {
    if (init.signal.aborted) controller.abort(init.signal.reason);
    else init.signal.addEventListener("abort", () => controller.abort(init.signal?.reason), { once: true });
  }
  return {
    init: { ...init, signal: controller.signal },
    cancel: () => clearTimeout(timeout),
  };
}

function classifyAbort(error: unknown, callerSignal?: AbortSignal | null): Error {
  if (error instanceof DOMException && error.name === "AbortError") {
    if (callerSignal?.aborted) return error;
    return new ApiTimeoutError();
  }
  return error instanceof Error ? error : new Error(String(error));
}

// ---------- Retry policy (idempotent GETs only) ----------
//
// A single fetch leaves every page on a dead-end error the moment a transient
// 502/503/504 or a 15s timeout fires — the classic flaky-cellular failure. We
// retry IDEMPOTENT GETs a bounded number of times with full-jitter exponential
// backoff. Non-idempotent writes (POST/PATCH/DELETE) are NEVER retried inline:
// replaying them could double-write. Queueable writes instead fall through to
// the offline queue (see maybeEnqueueOffline) where the idempotency-key dedupes
// the eventual replay; non-queueable writes just surface the error.
const GET_RETRY_MAX = 2; // up to 2 retries → 3 attempts total
const GET_RETRY_BASE_MS = 300; // full-jitter base
const GET_RETRY_CAP_MS = 2_000; // backoff ceiling
const RETRIABLE_STATUS = new Set([502, 503, 504]);

function isIdempotentGet(init: RequestInit): boolean {
  return (init.method || "GET").toUpperCase() === "GET";
}

// Errors thrown out of the fetch try/catch that represent a transient transport
// failure worth retrying for an idempotent GET: a request timeout (mapped from
// AbortError when the caller didn't abort) or a low-level network error
// (TypeError "Failed to fetch", etc.). A caller-initiated AbortError is NOT
// transient — it propagates as-is and is never retried.
function isRetriableTransportError(error: unknown): boolean {
  if (error instanceof ApiTimeoutError) return true;
  if (error instanceof ApiUnauthorizedError) return false;
  if (error instanceof ApiFailureError) return false;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  return error instanceof TypeError;
}

// Full-jitter exponential backoff: random in [0, min(cap, base * 2^attempt)).
function retryBackoffMs(attempt: number): number {
  const exp = Math.min(GET_RETRY_CAP_MS, GET_RETRY_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Marks an outbound write as queueable. When the fetch fails because we're
 * offline (or the network is too flaky to land within the timeout), the
 * request is persisted to IndexedDB and replayed on the next online event.
 *
 * Caller responsibilities:
 * - Server endpoint must honor `idempotency-key` so the eventual replay
 *   doesn't double-write. Today only invite accept does this end-to-end;
 *   other endpoints will treat duplicate keys the same as fresh writes,
 *   which is fine for idempotent operations (rename, reaction toggle).
 * - The body must be JSON-serializable. Binary uploads (vault media)
 *   should NOT pass `queueable: true` — they need the chunked / resumable
 *   channel from H-3.
 */
export interface QueueableOptions {
  queueable?: boolean;
  intent?: string;
  idempotencyKey?: string;
  suppressPwaReconnect?: boolean;
}

async function maybeEnqueueOffline<T>(
  url: string,
  init: RequestInit,
  queue: QueueableOptions,
  // When `force` is set, enqueue regardless of navigator.onLine. This is the
  // cellular-failure path: a timeout or retriable 5xx fired while the browser
  // still thinks it's online (onLine === true), but the write didn't land.
  // For idempotent GETs we retry inline; queueable writes are NOT retried
  // inline — they go to the queue here so we never double-send a non-idempotent
  // POST/PATCH/DELETE. The idempotency-key header (set in request()) lets the
  // eventual replay dedupe.
  force = false,
): Promise<T> {
  if (!queue.queueable) throw new Error("offline");
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (force || offline) {
    const body = await readQueueableBody(init);
    const idempotencyKey = queue.idempotencyKey || generateIdempotencyKey();
    const queueId = await enqueueWrite({
      intent: queue.intent || "unspecified",
      idempotencyKey,
      url,
      method: (init.method || "GET").toUpperCase(),
      body,
    });
    throw new ApiOfflineQueuedError(queueId);
  }
  throw new Error("offline-passthrough");
}

async function readQueueableBody(init: RequestInit): Promise<unknown> {
  if (init.body == null) return null;
  if (typeof init.body === "string") {
    try { return JSON.parse(init.body); } catch { return init.body; }
  }
  if (init.body instanceof FormData) {
    throw new Error("FormData bodies cannot be queued offline.");
  }
  return init.body;
}

async function request<T>(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, queue: QueueableOptions = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const bodyIsFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
  if (init.body && !headers.has("content-type") && !bodyIsFormData) {
    headers.set("content-type", "application/json");
  }
  // Tag the request with an idempotency key so a later replay from the
  // offline queue doesn't double-write. Server endpoints that honor the
  // header dedupe by it; endpoints that ignore it just see a fresh write.
  // Stamp the key onto `queue` (the same object maybeEnqueueOffline receives)
  // so the live attempt's header and any queued replay carry the SAME key —
  // two independent keys meant a timed-out-but-landed write replayed as a
  // brand-new one (duplicate Ask/idea/comment on flaky cellular).
  if (queue.queueable && !headers.has("idempotency-key")) {
    queue.idempotencyKey = queue.idempotencyKey || generateIdempotencyKey();
    headers.set("idempotency-key", queue.idempotencyKey);
  }

  const callerSignal = init.signal || null;
  const idempotent = isIdempotentGet(init);

  // Bounded retry loop. Only idempotent GETs are retried inline; for every
  // other method the loop runs exactly once (GET_RETRY_MAX is gated on
  // `idempotent`). Each attempt gets a fresh AbortController + timeout via
  // withTimeout. A caller-supplied AbortSignal aborts cleanly between attempts.
  for (let attempt = 0; ; attempt++) {
    // Honor a caller abort before spending another attempt or backoff sleep.
    if (callerSignal?.aborted) {
      throw callerSignal.reason instanceof Error
        ? callerSignal.reason
        : new DOMException("Aborted", "AbortError");
    }

    const guarded = withTimeout({
      ...init,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, guarded.init);
    } catch (error) {
      const classified = classifyAbort(error, callerSignal);
      // A caller-initiated abort propagates immediately — never retried, never
      // queued.
      if (callerSignal?.aborted) throw classified;

      // Queueable write that timed out: persist to IndexedDB and surface
      // ApiOfflineQueuedError, independent of navigator.onLine. This is the
      // cellular case — onLine is true but the write never landed. Writes are
      // not retried inline (could double-send); the queue replays with the
      // idempotency-key. A plain network failure still routes through the
      // onLine-gated path (force=false) to preserve prior behavior.
      if (queue.queueable && !idempotent) {
        try {
          return await maybeEnqueueOffline<T>(url, init, queue, classified instanceof ApiTimeoutError);
        } catch (enqueueError) {
          if (enqueueError instanceof ApiOfflineQueuedError) throw enqueueError;
          // Not enqueued (e.g. online + non-timeout, or FormData body) — fall
          // through and surface the classified transport error.
        }
        throw classified;
      }

      // Idempotent GET: retry transient transport failures with backoff.
      if (idempotent && attempt < GET_RETRY_MAX && isRetriableTransportError(classified)) {
        await sleep(retryBackoffMs(attempt), callerSignal);
        continue;
      }
      throw classified;
    } finally {
      guarded.cancel();
    }

    if (response.status === 401) {
      if (!queue.suppressPwaReconnect) maybeReconnectStandalonePwa();
      throw new ApiUnauthorizedError();
    }

    // Transient upstream 5xx (502/503/504). For idempotent GETs, retry with
    // backoff. For queueable writes, enqueue for replay (force, independent of
    // navigator.onLine) so a flaky-cell 5xx doesn't lose the write — without
    // retrying inline, which the idempotency-key on replay then dedupes.
    if (RETRIABLE_STATUS.has(response.status)) {
      if (idempotent && attempt < GET_RETRY_MAX) {
        await sleep(retryBackoffMs(attempt), callerSignal);
        continue;
      }
      if (queue.queueable && !idempotent) {
        try {
          return await maybeEnqueueOffline<T>(url, init, queue, true);
        } catch (enqueueError) {
          if (enqueueError instanceof ApiOfflineQueuedError) throw enqueueError;
          // Couldn't enqueue (e.g. non-JSON body) — fall through to the normal
          // ApiFailureError below.
        }
      }
    }

    const text = await response.text();
    // Empty body is fine for some endpoints; treat as null.
    const data = text ? safeJson(text) : null;

    if (!response.ok) {
      const message = (data as ApiError | null)?.error || response.statusText || "Request failed";
      throw new ApiFailureError(response.status, message);
    }
    return data as T;
  }
}

async function requestBlob(url: string, init: RequestInit = {}, timeoutMs = MEDIA_FETCH_TIMEOUT_MS): Promise<Blob> {
  const callerSignal = init.signal || null;
  const guarded = withTimeout({
    ...init,
    credentials: "same-origin",
    cache: "no-store",
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, guarded.init);
  } catch (error) {
    throw classifyAbort(error, callerSignal);
  } finally {
    guarded.cancel();
  }

  if (response.status === 401) {
    maybeReconnectStandalonePwa();
    throw new ApiUnauthorizedError();
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const data = text ? safeJson(text) : null;
    const message = (data as ApiError | null)?.error || response.statusText || "Request failed";
    throw new ApiFailureError(response.status, message);
  }
  return response.blob();
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

// ---------- Endpoints ----------

export function getProfile(signal?: AbortSignal): Promise<ProfileResponse> {
  return request<ProfileResponse>("/api/profile", signal ? { signal } : undefined);
}

export async function updateProfileSettings(payload: {
  shareAttentionSignals?: boolean;
}): Promise<ProfileResponse> {
  const next = await request<ProfileResponse>("/api/profile", {
    method: "POST",
    body: JSON.stringify({
      action: "update_profile",
      ...payload,
    }),
  });
  dispatchProfileStale();
  return next;
}

export async function renameWorkspace(payload: {
  workspaceId: string;
  displayName: string;
}): Promise<ProfileResponse> {
  const next = await request<ProfileResponse>("/api/profile", {
    method: "POST",
    body: JSON.stringify({
      action: "update_workspace",
      ...payload,
    }),
  });
  dispatchProfileStale();
  return next;
}

export async function updateWorkspaceSettings(payload: {
  workspaceId: string;
  roomE2eeEnabled?: boolean;
  roomE2eeVerifier?: RoomEncryptedBox | null;
  reauthOnLaunch?: boolean;
}): Promise<ProfileResponse> {
  const next = await request<ProfileResponse>("/api/profile", {
    method: "POST",
    body: JSON.stringify({
      action: "update_workspace",
      ...payload,
    }),
  });
  dispatchProfileStale();
  return next;
}

export function getConfig(): Promise<{
  appVersion: string;
  runtimeTarget?: string;
  selfHost?: boolean;
  vapidPublicKey: string;
  googleAuthEnabled: boolean;
  emailAuthEnabled: boolean;
  localPasswordAuthEnabled?: boolean;
  roomE2eeKdfVersion?: string;
  gifSearch?: boolean;
}> {
  return request("/api/config");
}

async function rawRecoveryRequest(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function recoverRoomE2eeFromServerData(
  workspaceId: string,
  passphrase: string,
): Promise<{ verified: number }> {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  const paths = [
    "/api/bootstrap",
    "/api/sexboard",
    `/api/request-board${qs}`,
    `/api/boundaries${qs}`,
    `/api/approved-acts${qs}`,
    `/api/fantasy-backlog${qs}`,
    `/api/shelf${qs}`,
    `/api/pile${qs}`,
    `/api/blind-reveals${qs}`,
  ];
  const responses = await Promise.all(paths.map((path) => rawRecoveryRequest(path).catch(() => null)));
  const candidates = responses.flatMap((response) => collectRoomE2eeRecoveryCandidates(response));
  const verified = await recoverRoomE2eeWithCandidates(workspaceId, passphrase, candidates);
  return { verified };
}

// Active room-encryption KDF version for NEW rooms on this deploy. Read at
// enable time and frozen into the room's verifier. Defaults to "v1" on any
// error or unrecognized value so a brand-new room is never minted at a version
// a partner's client can't reproduce — and production (flag unset) stays on v1.
export async function getActiveRoomKdfVersion(): Promise<"v1" | "v2"> {
  try {
    const config = await getConfig();
    return config.roomE2eeKdfVersion === "v2" ? "v2" : "v1";
  } catch {
    return "v1";
  }
}

export function getE2eeStatus(workspaceId: string): Promise<E2eeStatusResponse> {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<E2eeStatusResponse>(`/api/e2ee/status${qs}`);
}

export function reencryptE2eeSurface(payload: {
  workspaceId: string;
  surface: E2eeMigrationSurface;
  patches: unknown[];
}): Promise<E2eeReencryptResponse> {
  return request<E2eeReencryptResponse>("/api/e2ee/reencrypt", {
    method: "POST",
    body: JSON.stringify(payload),
  }, 60 * 1000);
}

export function getBootstrap(
  signal?: AbortSignal,
  options: { suppressPwaReconnect?: boolean } = {},
): Promise<BootstrapResponse> {
  return request<BootstrapResponse>(
    "/api/bootstrap",
    signal ? { signal } : undefined,
    DEFAULT_FETCH_TIMEOUT_MS,
    { suppressPwaReconnect: options.suppressPwaReconnect },
  ).then(decryptBootstrapResponse);
}

export function startEmailSignIn(payload: {
  email: string;
  returnTo?: string;
}): Promise<{ ok: boolean; message?: string; expiresInSeconds?: number }> {
  return request("/api/auth/email/start", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function verifyEmailSignIn(payload: {
  email: string;
  code: string;
}): Promise<{ ok: boolean; returnTo?: string }> {
  const result = await request<{ ok: boolean; returnTo?: string }>("/api/auth/email/verify", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  rememberEmailAuthProvider();
  clearPwaReconnectAttempt();
  return result;
}

export async function localPasswordSignIn(payload: {
  mode: "login" | "register";
  email: string;
  password: string;
  name?: string;
  returnTo?: string;
}): Promise<{ ok: boolean; email?: string; returnTo?: string }> {
  const result = await request<{ ok: boolean; email?: string; returnTo?: string }>("/api/auth/local", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  rememberLocalAuthProvider();
  clearPwaReconnectAttempt();
  return result;
}

export function getPublicStats(): Promise<PublicStatsResponse> {
  return request<PublicStatsResponse>("/api/public-stats");
}

export function getSexboard(): Promise<SexboardResponse> {
  // Tell the server when this is a backgrounded/hidden refetch so it reads
  // presence WITHOUT stamping us "active". A perpetually-active recipient has
  // every real push suppressed by _notification_policy.js (a manual test push is
  // exempt — which is why tests arrive but live notifications don't).
  const bg = typeof document !== "undefined" && document.visibilityState === "hidden" ? "?bg=1" : "";
  return request<SexboardResponse>(`/api/sexboard${bg}`)
    .then(decryptSexboardResponse);
}

export function getPresence(workspaceId?: string): Promise<PresenceResponse> {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<PresenceResponse>(`/api/space/presence${qs}`);
}

export function getActivity(workspaceId?: string): Promise<ActivityResponse> {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<ActivityResponse>(`/api/activity${qs}`);
}

export function getHealthDashboard(payload: {
  workspaceId?: string;
  range?: HealthRangeId;
} = {}): Promise<HealthResponse> {
  const params = new URLSearchParams();
  if (payload.workspaceId) params.set("workspaceId", payload.workspaceId);
  if (payload.range) params.set("range", payload.range);
  const qs = params.toString() ? `?${params.toString()}` : "";
  return request<HealthResponse>(`/api/dashboard/health${qs}`);
}

export function markActivityRead(payload: {
  workspaceId: string;
  resource?: ActivityResource | "";
}): Promise<ActivityResponse> {
  return request<ActivityResponse>("/api/activity", {
    method: "POST",
    body: JSON.stringify({
      workspaceId: payload.workspaceId,
      action: "mark_read",
      resource: payload.resource || "",
    }),
  });
}

export function dismissActivityItems(payload: {
  workspaceId: string;
  ids: string[];
}): Promise<ActivityResponse> {
  return request<ActivityResponse>("/api/activity", {
    method: "POST",
    body: JSON.stringify({
      workspaceId: payload.workspaceId,
      action: "dismiss",
      ids: payload.ids,
    }),
  });
}

export function clearActivity(payload: {
  workspaceId: string;
}): Promise<ActivityResponse> {
  return request<ActivityResponse>("/api/activity", {
    method: "POST",
    body: JSON.stringify({
      workspaceId: payload.workspaceId,
      action: "clear",
    }),
  });
}

export async function getRequestBoard(workspaceId?: string): Promise<RequestBoardResponse> {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return decryptRequestBoardResponse(await request<RequestBoardResponse>(`/api/request-board${qs}`));
}

export interface CreateRequestPayload {
  workspaceId: string;
  requesterEmail: string;
  reviewerEmail: string;
  categories: string[];
  timing: Timing;
  filming: Filming;
  note?: string;
  boundaryConflicts?: string[];
  seededFromKinkId?: string;
}

export async function createRequest(payload: CreateRequestPayload): Promise<{
  request: RequestRecord;
} & RequestBoardResponse> {
  const body = await prepareCreateRequestPayload(payload);
  return decryptRequestBoardResponse(await request("/api/request-board", {
    method: "POST",
    body: JSON.stringify(body),
  // The emotional cost of losing a freshly-composed Ask to a network blip is
  // high — couples app, intimate content, often typed on flaky cell signal.
  // Mark queueable so the offline queue catches a failed send and replays
  // it when the network comes back.
  }, undefined, { queueable: true, intent: "ask:create" }));
}

export async function updateRequestAction(payload: {
  workspaceId: string;
  id: string;
  action: "revoke" | "accept_counter" | "archive" | "pass" | "restore" | "on_deck" | "completed" | "expire";
}): Promise<{ request?: RequestRecord; revoked?: boolean } & RequestBoardResponse> {
  return decryptRequestBoardResponse(await request<{ request?: RequestRecord; revoked?: boolean } & RequestBoardResponse>("/api/request-board", {
    method: "PATCH",
    body: JSON.stringify(payload),
  }));
}

// Manual "Remind" — nudge your partner to come look at a pending Ask you sent.
// Sends a push (email fallback) and stamps lastReminderAt. A too-soon tap throws
// (server enforces a short cooldown); the UI also disables the button meanwhile.
export async function remindAsk(payload: {
  workspaceId: string;
  id: string;
}): Promise<{ request?: RequestRecord; reminded?: boolean; delivery?: string } & RequestBoardResponse> {
  return decryptRequestBoardResponse(await request<{ request?: RequestRecord; reminded?: boolean; delivery?: string } & RequestBoardResponse>("/api/request-board", {
    method: "PATCH",
    body: JSON.stringify({ ...payload, action: "remind" }),
  }));
}

// "Maybe" — the reviewer defers a first answer. Not a final decision: the Ask
// stays repliable so replyToRequest ("Decide now") can still convert it later.
// Queueable + idempotent like a reply so a mid-send signal drop doesn't lose it.
export async function maybeAsk(payload: {
  workspaceId: string;
  id: string;
}): Promise<{ request?: RequestRecord; emailResult?: unknown } & RequestBoardResponse> {
  return decryptRequestBoardResponse(await request<{ request?: RequestRecord; emailResult?: unknown } & RequestBoardResponse>("/api/request-board", {
    method: "PATCH",
    body: JSON.stringify({ ...payload, action: "maybe" }),
  }, undefined, { queueable: true, intent: "ask:maybe" }));
}

export async function replyToRequest(payload: {
  workspaceId: string;
  id: string;
  decisions: Array<{
    label: string;
    decision: "Yes" | "Maybe" | "Let's chat" | "Counter" | "No";
    counter?: string;
    note?: string;
    targetType?: "act" | "timing" | "filming" | "general";
    actId?: string;
    counterActId?: string;
  }>;
  note?: string;
}): Promise<{ request?: RequestRecord; emailResult?: unknown } & RequestBoardResponse> {
  const body = await prepareReplyPayload(payload);
  return decryptRequestBoardResponse(await request<{ request?: RequestRecord; emailResult?: unknown } & RequestBoardResponse>("/api/request-board", {
    method: "PATCH",
    body: JSON.stringify({ ...body, action: "reply" }),
  // Replies to Asks carry counter text + notes the user typed. Losing a
  // reply mid-send (cell signal drop) without telling them would be a
  // disaster — they'd think their partner saw it and never followed up.
  // Queue + replay with an idempotency-key so the server-side reply
  // logic dedupes on replay.
  }, undefined, { queueable: true, intent: "ask:reply" }));
}

// --- Chat / direct messages ----------------------------------------------

const CHAT_MESSAGE_PURPOSE = "chat:message";

// E2EE rooms keep message bodies as client-side ciphertext: getRequestBoard's
// sibling here decrypts each box back to plaintext, or flags it locked when the
// room key isn't unlocked in this session (mirrors decryptRequestRecord).
async function decryptChatMessage(message: ChatMessage, workspaceId: string): Promise<ChatMessage> {
  const box = message.encryptedText;
  if (!box) return message;
  const result = await tryDecryptRoomJson<{ text: string; mediaKey?: string; mediaIv?: string }>(workspaceId, CHAT_MESSAGE_PURPOSE, box);
  if (result.ok && result.value) {
    const next: ChatMessage = { ...message, text: String(result.value.text || ""), e2eeLocked: false };
    // When Room Encryption is on, an image's key/iv ride inside the box — merge
    // them back onto media so the client can decrypt the R2 ciphertext.
    if (message.media && result.value.mediaKey && result.value.mediaIv) {
      next.media = { ...message.media, key: result.value.mediaKey, iv: result.value.mediaIv };
    }
    return next;
  }
  return { ...message, text: "", e2eeLocked: true };
}

async function decryptChatThread<T extends { workspaceId: string; messages?: ChatMessage[] }>(response: T): Promise<T> {
  const messages = await Promise.all(
    (response.messages || []).map((message) => decryptChatMessage(message, response.workspaceId)),
  );
  return { ...response, messages };
}

// Build the wire body for a message: ciphertext under encryptedText when the
// room requires E2EE and the key is unlocked, plaintext text otherwise.
async function prepareChatBody(workspaceId: string, text: string, e2ee: boolean, mediaSecret?: { key: string; iv: string }): Promise<{ text?: string; encryptedText?: RoomEncryptedBox }> {
  if (e2ee && hasUnlockedRoomE2eeKey(workspaceId)) {
    const payload = mediaSecret ? { text, mediaKey: mediaSecret.key, mediaIv: mediaSecret.iv } : { text };
    return { encryptedText: await encryptRoomJson(workspaceId, CHAT_MESSAGE_PURPOSE, payload) };
  }
  return { text };
}

export async function getChat(workspaceId: string, after?: number): Promise<ChatThreadResponse> {
  const params = new URLSearchParams({ workspaceId });
  if (Number.isFinite(after)) params.set("after", String(after));
  return decryptChatThread(await request<ChatThreadResponse>(`/api/chat?${params.toString()}`));
}

// Re-exported so the Sext composer can mint a key, pre-compute the message id
// (predictChatMessageId), and hand the SAME key to sendChatMessage — making the
// optimistic bubble's id match the server's so it reconciles in place.
export { generateIdempotencyKey };

// Mirror of functions/api/_idempotency.js idempotentId() for namespace
// "chat:message" / prefix "msg". MUST stay in lockstep with that file — if the
// server hash changes, the predicted id diverges and an optimistic message would
// briefly duplicate before reconciling. Guarded by a parity test (chat-id).
const _idemEncoder = new TextEncoder();
function cleanIdempotencyKeyClient(value: string): string {
  return String(value || "").trim().replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128);
}
function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
export async function predictChatMessageId(
  workspaceId: string,
  actorEmail: string,
  idempotencyKey: string,
): Promise<string> {
  const cleanedKey = cleanIdempotencyKeyClient(idempotencyKey);
  if (!cleanedKey) return "";
  const email = String(actorEmail || "").trim().toLowerCase();
  const material = ["chat:message", workspaceId || "", email, "", cleanedKey].join("\0");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", _idemEncoder.encode(material)));
  return `msg_${base64UrlFromBytes(digest).slice(0, 32)}`;
}

export async function sendChatMessage(payload: {
  workspaceId: string;
  text: string;
  e2ee: boolean;
  replyToId?: string;
  // When the caller pre-computed the message id (optimistic send), it passes the
  // same key here so the server derives the matching id.
  idempotencyKey?: string;
  media?: { mediaId: string; mediaType: string; mediaSize: number; key: string; iv: string };
}): Promise<{ workspaceId: string; message: ChatMessage }> {
  const e2eeOn = payload.e2ee && hasUnlockedRoomE2eeKey(payload.workspaceId);
  const mediaSecret = payload.media ? { key: payload.media.key, iv: payload.media.iv } : undefined;
  const body = await prepareChatBody(payload.workspaceId, payload.text, payload.e2ee, mediaSecret);
  // Always send the non-secret media pointer; include key/iv inline only when
  // the room isn't E2EE (when it is, they went into encryptedText above).
  const media = payload.media
    ? {
        mediaId: payload.media.mediaId,
        mediaType: payload.media.mediaType,
        mediaSize: payload.media.mediaSize,
        ...(e2eeOn ? {} : { key: payload.media.key, iv: payload.media.iv }),
      }
    : undefined;
  const response = await request<{ workspaceId: string; message: ChatMessage }>("/api/chat", {
    method: "POST",
    headers: { "idempotency-key": payload.idempotencyKey || generateIdempotencyKey() },
    body: JSON.stringify({ workspaceId: payload.workspaceId, replyToId: payload.replyToId, ...body, ...(media ? { media } : {}) }),
  });
  return { ...response, message: await decryptChatMessage(response.message, response.workspaceId) };
}

// Encrypt an image with a fresh per-message key, store the ciphertext in R2, and
// return the pointer + secret. The secret is placed into the message by
// sendChatMessage (in the E2EE box when on, else inline) — never sent here.
export async function uploadChatImage(payload: { workspaceId: string; file: Blob }): Promise<{ mediaId: string; mediaType: string; mediaSize: number; key: string; iv: string }> {
  const mediaType = payload.file.type || "image/jpeg";
  const cipher = await encryptChatImage(payload.file);
  const res = await request<{ mediaId: string }>(
    `/api/chat-media?workspaceId=${encodeURIComponent(payload.workspaceId)}`,
    { method: "POST", headers: { "content-type": "application/octet-stream" }, body: cipher.ciphertext },
  );
  return { mediaId: res.mediaId, mediaType, mediaSize: cipher.ciphertext.size, key: cipher.keyB64, iv: cipher.ivB64 };
}

// Fetch + decrypt a chat image's bytes for display. Returns a Blob the caller
// turns into an object URL.
export async function getChatImageBlob(payload: { workspaceId: string; media: ChatMedia }): Promise<Blob> {
  const { workspaceId, media } = payload;
  if (!media.key || !media.iv) throw new Error("This image is locked — unlock Room Encryption to view it.");
  const enc = await requestBlob(`/api/chat-media?workspaceId=${encodeURIComponent(workspaceId)}&id=${encodeURIComponent(media.mediaId)}`);
  return decryptChatImage(await enc.arrayBuffer(), media.key, media.iv, media.mediaType);
}

// Small in-memory LRU over decrypted chat-image blobs. The wire + at-rest
// policy for this ciphertext is no-store on purpose, which used to mean every
// mount of a bubble AND its lightbox re-downloaded + re-decrypted the same
// image. Memory only — nothing here touches disk — and wiped on sign-out.
const chatImageBlobCache = new Map<string, Promise<Blob>>();
const CHAT_IMAGE_BLOB_CACHE_MAX = 20;

export function getChatImageBlobCached(payload: { workspaceId: string; media: ChatMedia }): Promise<Blob> {
  const cacheKey = `${payload.workspaceId}:${payload.media.mediaId}`;
  const hit = chatImageBlobCache.get(cacheKey);
  if (hit) {
    // Refresh recency (Map preserves insertion order — delete + set = LRU touch).
    chatImageBlobCache.delete(cacheKey);
    chatImageBlobCache.set(cacheKey, hit);
    return hit;
  }
  const pending = getChatImageBlob(payload);
  chatImageBlobCache.set(cacheKey, pending);
  // A failed fetch/decrypt must not poison the cache.
  pending.catch(() => { chatImageBlobCache.delete(cacheKey); });
  while (chatImageBlobCache.size > CHAT_IMAGE_BLOB_CACHE_MAX) {
    const oldest = chatImageBlobCache.keys().next().value;
    if (oldest === undefined) break;
    chatImageBlobCache.delete(oldest);
  }
  return pending;
}

export function clearChatImageBlobCache(): void {
  chatImageBlobCache.clear();
}

export async function editChatMessage(payload: {
  workspaceId: string;
  id: string;
  text: string;
  e2ee: boolean;
}): Promise<{ workspaceId: string; message: ChatMessage }> {
  const body = await prepareChatBody(payload.workspaceId, payload.text, payload.e2ee);
  const response = await request<{ workspaceId: string; message: ChatMessage }>("/api/chat", {
    method: "PATCH",
    body: JSON.stringify({ workspaceId: payload.workspaceId, id: payload.id, ...body }),
  });
  return { ...response, message: await decryptChatMessage(response.message, response.workspaceId) };
}

export async function reactToChatMessage(payload: {
  workspaceId: string;
  id: string;
  emoji: string;
}): Promise<{ workspaceId: string; message: ChatMessage }> {
  const response = await request<{ workspaceId: string; message: ChatMessage }>("/api/chat", {
    method: "PATCH",
    body: JSON.stringify({ ...payload, action: "react" }),
  });
  return { ...response, message: await decryptChatMessage(response.message, response.workspaceId) };
}

export async function unsendChatMessage(payload: { workspaceId: string; id: string }): Promise<{ workspaceId: string; message: ChatMessage }> {
  return request("/api/chat", {
    method: "DELETE",
    body: JSON.stringify(payload),
  });
}

export async function markChatRead(payload: { workspaceId: string; seq: number }): Promise<{ readCursors: Record<string, number>; readAt?: Record<string, string> }> {
  return request("/api/chat", {
    method: "PATCH",
    body: JSON.stringify({ ...payload, action: "read" }),
  });
}

export async function sendChatTyping(workspaceId: string): Promise<void> {
  await request("/api/chat", {
    method: "PATCH",
    body: JSON.stringify({ workspaceId, action: "typing" }),
  }).catch(() => {});
}

// Resolve a RedGifs link to direct, muted-playable video URLs so a GIF pasted
// into Sext renders in our own <video>. Pass the full pasted URL (or a bare id):
// the server extracts candidate ids the same way the shelf does, so Share-button
// links resolve too. Returns null when RedGifs can't be reached or the clip is
// gone — the caller shows a plain link instead.
export async function resolveRedgifs(
  source: string,
  signal?: AbortSignal,
): Promise<{ hd: string; sd: string; poster: string } | null> {
  if (!source) return null;
  try {
    const result = await request<{ ok?: boolean; hd?: string; sd?: string; poster?: string }>(
      `/api/redgifs?url=${encodeURIComponent(source)}`,
      signal ? { signal } : undefined,
    );
    if (!result?.ok || (!result.hd && !result.sd)) return null;
    return { hd: result.hd || "", sd: result.sd || "", poster: result.poster || "" };
  } catch {
    return null;
  }
}

export type RedgifsSearchResult = { id: string; poster: string; sd: string; hd: string };

// Search RedGifs for the Sext GIF picker. Returns poster + video URLs; the
// picker sends the chosen clip as a normal RedGifs link (resolveRedgifs renders
// it). Best-effort: [] on any failure so the composer keeps its paste path.
export async function searchRedgifs(
  query: string,
  order: string = "trending",
  page: number = 1,
  signal?: AbortSignal,
): Promise<{ results: RedgifsSearchResult[]; pages: number }> {
  if (!query.trim()) return { results: [], pages: 1 };
  try {
    const result = await request<{ ok?: boolean; results?: RedgifsSearchResult[]; pages?: number }>(
      `/api/redgifs?action=search&q=${encodeURIComponent(query.trim())}&order=${encodeURIComponent(order)}&page=${page}`,
      signal ? { signal } : undefined,
    );
    return {
      results: Array.isArray(result?.results) ? result.results : [],
      pages: Math.max(1, Number(result?.pages) || 1),
    };
  } catch {
    return { results: [], pages: 1 };
  }
}

export async function resolveReviewToken(token: string): Promise<ReviewTokenResolveResponse> {
  return decryptReviewTokenResolveResponse(await request<ReviewTokenResolveResponse>("/api/review-token", {
    method: "POST",
    body: JSON.stringify({ action: "resolve", token }),
  }));
}

export async function submitReviewToken(payload: {
  token: string;
  workspaceId?: string;
  decisions: Array<{
    label: string;
    decision: "Yes" | "Maybe" | "Let's chat" | "Counter" | "No";
    counter?: string;
    note?: string;
    targetType?: "act" | "timing" | "filming" | "general";
    actId?: string;
    counterActId?: string;
  }>;
  note?: string;
}): Promise<ReviewTokenSubmitResponse> {
  const body = await prepareReviewTokenSubmitPayload(payload);
  return decryptReviewTokenSubmitResponse(await request<ReviewTokenSubmitResponse>("/api/review-token", {
    method: "POST",
    body: JSON.stringify(body),
  }), payload.workspaceId);
}

export async function getBoundaries(workspaceId?: string): Promise<BoundariesResponse> {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return decryptBoundariesResponse(await request<BoundariesResponse>(`/api/boundaries${qs}`));
}

export async function createBoundary(payload: {
  workspaceId: string;
  text: string;
  type: BoundaryType;
}): Promise<{ boundary: Boundary } & BoundariesResponse> {
  const body = await prepareBoundaryPayload(payload);
  return decryptBoundariesResponse(await request("/api/boundaries", {
    method: "POST",
    body: JSON.stringify(body),
  }));
}

export async function updateBoundary(payload: {
  workspaceId: string;
  id: string;
  text?: string;
  type?: BoundaryType;
}): Promise<{ boundary: Boundary } & BoundariesResponse> {
  const body = await prepareBoundaryPayload(payload);
  return decryptBoundariesResponse(await request("/api/boundaries", {
    method: "PATCH",
    body: JSON.stringify(body),
  }));
}

export async function deleteBoundary(payload: {
  workspaceId: string;
  id: string;
}): Promise<BoundariesResponse> {
  return decryptBoundariesResponse(await request("/api/boundaries", {
    method: "DELETE",
    body: JSON.stringify(payload),
  }));
}

export function getActs(workspaceId?: string): Promise<ActsResponse> {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<ActsResponse>(`/api/approved-acts${qs}`)
    .then(decryptActsResponse);
}

export function createAct(payload: {
  workspaceId: string;
  label: string;
  myComfort?: string;
  tags?: string[];
}): Promise<{ act: Act } & ActsResponse> {
  return prepareActPayload(payload)
    .then((body) => request<{ act: Act } & ActsResponse>("/api/approved-acts", {
      method: "POST",
      body: JSON.stringify(body),
    }))
    .then(decryptActsResponse);
}

export function updateAct(payload: {
  workspaceId: string;
  id: string;
  label?: string;
  myComfort?: string;
  tags?: string[];
}): Promise<{ act: Act } & ActsResponse> {
  return prepareActPayload(payload)
    .then((body) => request<{ act: Act } & ActsResponse>("/api/approved-acts", {
      method: "PATCH",
      body: JSON.stringify(body),
    }))
    .then(decryptActsResponse);
}

export function deleteAct(payload: {
  workspaceId: string;
  id: string;
}): Promise<ActsResponse> {
  return request<ActsResponse>("/api/approved-acts", {
    method: "DELETE",
    body: JSON.stringify(payload),
  }).then(decryptActsResponse);
}

export function savePushSubscription(payload: {
  workspaceId: string;
  subscription: PushSubscriptionJSON;
  preferences: Record<string, boolean>;
}): Promise<{ ok: boolean }> {
  return request("/api/push-subscribe", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function sendTestPush(workspaceId: string): Promise<{ ok: boolean }> {
  return request("/api/push-test", {
    method: "POST",
    body: JSON.stringify({ workspaceId }),
  });
}

export async function getFantasyBacklog(workspaceId?: string): Promise<FantasyBacklogResponse> {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return decryptFantasyBacklogResponse(await request<FantasyBacklogResponse>(`/api/fantasy-backlog${qs}`));
}

// Creating, archiving, restoring, or reacting to a kink changes the counts the
// Sexboard derives from the fantasy backlog ("waiting on partner" /
// "needs your take"). Drop the cached Sexboard + Inspiration snapshots so the
// next visit re-reads fresh from the server instead of painting a stale count
// out of the memory/IndexedDB cache (the "19 waiting" after archiving bug).
async function afterKinkMutation(
  p: Promise<FantasyBacklogResponse>,
): Promise<FantasyBacklogResponse> {
  const result = await p;
  invalidateResource("sexboard");
  invalidateResource("inspiration");
  return result;
}

export async function createKink(payload: {
  workspaceId: string;
  text: string;
  tags?: string[];
}): Promise<FantasyBacklogResponse> {
  const body = await prepareKinkTextPayload(payload);
  return afterKinkMutation(decryptFantasyBacklogResponse(await request<FantasyBacklogResponse>("/api/fantasy-backlog", {
    method: "POST",
    body: JSON.stringify(body),
  // Kinks/Ideas are emotional in-flight content too — same offline survival
  // policy as Asks.
  }, undefined, { queueable: true, intent: "kink:create" })));
}

export async function updateKinkText(payload: {
  workspaceId: string;
  id: string;
  text: string;
}): Promise<FantasyBacklogResponse> {
  const body = await prepareKinkTextPayload(payload);
  return decryptFantasyBacklogResponse(await request<FantasyBacklogResponse>("/api/fantasy-backlog", {
    method: "PATCH",
    body: JSON.stringify(body),
  }));
}

export async function deleteKink(payload: {
  workspaceId: string;
  id: string;
}): Promise<FantasyBacklogResponse> {
  return afterKinkMutation(decryptFantasyBacklogResponse(await request<FantasyBacklogResponse>("/api/fantasy-backlog", {
    method: "DELETE",
    body: JSON.stringify(payload),
  })));
}

export async function restoreKink(payload: {
  workspaceId: string;
  id: string;
}): Promise<FantasyBacklogResponse> {
  return afterKinkMutation(decryptFantasyBacklogResponse(await request<FantasyBacklogResponse>("/api/fantasy-backlog", {
    method: "PATCH",
    body: JSON.stringify({ ...payload, action: "restore" }),
  })));
}

export async function updateKinkReaction(payload: {
  workspaceId: string;
  id: string;
  by: string;
  label: string;
  note?: string;
}): Promise<FantasyBacklogResponse> {
  const body = await prepareKinkReactionPayload(payload);
  return afterKinkMutation(decryptFantasyBacklogResponse(await request<FantasyBacklogResponse>("/api/fantasy-backlog", {
    method: "PATCH",
    body: JSON.stringify({
      workspaceId: body.workspaceId,
      id: body.id,
      reactions: [{
        by: body.by,
        label: body.label,
        note: body.note || "",
        ...(body.encryptedNote ? { encryptedNote: body.encryptedNote } : {}),
      }],
    }),
  })));
}

export async function clearKinkReaction(payload: {
  workspaceId: string;
  id: string;
}): Promise<FantasyBacklogResponse> {
  return afterKinkMutation(decryptFantasyBacklogResponse(await request<FantasyBacklogResponse>("/api/fantasy-backlog", {
    method: "PATCH",
    body: JSON.stringify({
      workspaceId: payload.workspaceId,
      id: payload.id,
      reactions: [],
    }),
  })));
}

export function recordKinkFocus(payload: {
  workspaceId: string;
  id: string;
}): Promise<{ activityRecorded?: boolean; focusSuppressed?: string }> {
  return request<{ activityRecorded?: boolean; focusSuppressed?: string }>("/api/fantasy-backlog", {
    method: "PATCH",
    body: JSON.stringify({
      workspaceId: payload.workspaceId,
      id: payload.id,
      action: "focused",
    }),
  });
}

export async function addKinkComment(payload: {
  workspaceId: string;
  id: string;
  comment: string;
}): Promise<FantasyBacklogResponse> {
  const body = await prepareKinkCommentPayload(payload);
  return decryptFantasyBacklogResponse(await request<FantasyBacklogResponse>("/api/fantasy-backlog", {
    method: "PATCH",
    body: JSON.stringify(body),
  // Comments are emotional in-progress text — same offline-survival
  // policy as Asks and Kinks.
  }, undefined, { queueable: true, intent: "kink:comment" }));
}

export async function updateKinkComment(payload: {
  workspaceId: string;
  id: string;
  commentId: string;
  comment: string;
}): Promise<FantasyBacklogResponse> {
  const body = await prepareKinkCommentPayload({
    ...payload,
    action: "update_comment",
  });
  return decryptFantasyBacklogResponse(await request<FantasyBacklogResponse>("/api/fantasy-backlog", {
    method: "PATCH",
    body: JSON.stringify(body),
  }, undefined, { queueable: true, intent: "kink:comment-edit" }));
}

export function getShelf(workspaceId?: string): Promise<ShelfResponse> {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<ShelfResponse>(`/api/shelf${qs}`)
    .then((response) => decryptShelfResponse(response, workspaceId || ""));
}

export function saveShelfItem(payload: {
  workspaceId: string;
  content: string;
  title?: string;
}): Promise<ShelfResponse> {
  return prepareShelfItemPayload(payload)
    .then((body) => request<ShelfResponse>("/api/shelf", {
      method: "POST",
      body: JSON.stringify(body),
    }))
    .then((response) => decryptShelfResponse(response, payload.workspaceId));
}

export function setShelfReaction(payload: {
  workspaceId: string;
  id: string;
  reaction: ShelfReactionId | null;
}): Promise<ShelfResponse> {
  return request<ShelfResponse>("/api/shelf", {
    method: "PATCH",
    body: JSON.stringify(payload),
  }).then((response) => decryptShelfResponse(response, payload.workspaceId));
}

export function recordShelfReveal(payload: {
  workspaceId: string;
  id: string;
}): Promise<ShelfResponse & { activityRecorded?: boolean }> {
  return request<ShelfResponse & { activityRecorded?: boolean }>("/api/shelf", {
    method: "PATCH",
    body: JSON.stringify({
      workspaceId: payload.workspaceId,
      id: payload.id,
      action: "revealed",
    }),
  }).then((response) => decryptShelfResponse(response, payload.workspaceId));
}

export function recordShelfFocus(payload: {
  workspaceId: string;
  id: string;
}): Promise<ShelfResponse & { activityRecorded?: boolean; focusSuppressed?: string }> {
  return request<ShelfResponse & { activityRecorded?: boolean; focusSuppressed?: string }>("/api/shelf", {
    method: "PATCH",
    body: JSON.stringify({
      workspaceId: payload.workspaceId,
      id: payload.id,
      action: "focused",
    }),
  }).then((response) => decryptShelfResponse(response, payload.workspaceId));
}

export function updateShelfTitle(payload: {
  workspaceId: string;
  id: string;
  title: string;
}): Promise<ShelfResponse> {
  return prepareShelfTitlePayload(payload)
    .then((body) => request<ShelfResponse>("/api/shelf", {
      method: "PATCH",
      body: JSON.stringify(body),
    }))
    .then((response) => decryptShelfResponse(response, payload.workspaceId));
}

export function getVault(workspaceId?: string): Promise<VaultResponse> {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<VaultResponse>(`/api/vault${qs}`);
}

// Note: the visible-before-unlock `displayTitle` is server-controlled (always
// "Private Clip") so plaintext clip titles never reach KV/DB. The real title
// is sent encrypted via `titleCiphertext` / `titleIv` and decrypted on the
// client after vault unlock.
export function uploadVaultClip(payload: {
  workspaceId: string;
  id?: string;
  file: Blob;
  mediaType: string;
  originalName?: string;
  originalSize: number;
  durationMs?: number;
  salt: string;
  videoIv: string;
  encryptionVersion?: string;
  iterations: number;
  titleCiphertext?: string;
  titleIv?: string;
  titleVersion?: string;
}): Promise<VaultResponse> {
  const form = new FormData();
  form.set("workspaceId", payload.workspaceId);
  if (payload.id) form.set("id", payload.id);
  form.set("action", "upload");
  form.set("consentConfirmed", "true");
  form.set("file", payload.file, "video.enc");
  form.set("mediaType", payload.mediaType);
  if (payload.originalName) form.set("originalName", payload.originalName);
  form.set("originalSize", String(payload.originalSize || 0));
  form.set("durationMs", String(payload.durationMs || 0));
  form.set("salt", payload.salt);
  form.set("videoIv", payload.videoIv);
  if (payload.encryptionVersion) form.set("encryptionVersion", payload.encryptionVersion);
  form.set("iterations", String(payload.iterations));
  if (payload.titleCiphertext) form.set("titleCiphertext", payload.titleCiphertext);
  if (payload.titleIv) form.set("titleIv", payload.titleIv);
  if (payload.titleVersion) form.set("titleVersion", payload.titleVersion);
  return request<VaultResponse>("/api/vault", {
    method: "POST",
    body: form,
  });
}

export function addVaultMoment(payload: {
  workspaceId: string;
  id: string;
  momentId?: string;
  frame: Blob;
  frameIv: string;
  frameVersion?: string;
  timestampMs: number;
  titleCiphertext?: string;
  titleIv?: string;
  titleVersion?: string;
  noteCiphertext?: string;
  noteIv?: string;
  noteVersion?: string;
}): Promise<VaultResponse> {
  const form = new FormData();
  form.set("workspaceId", payload.workspaceId);
  form.set("action", "moment");
  form.set("id", payload.id);
  if (payload.momentId) form.set("momentId", payload.momentId);
  form.set("frame", payload.frame, "moment.enc");
  form.set("frameIv", payload.frameIv);
  if (payload.frameVersion) form.set("frameVersion", payload.frameVersion);
  form.set("timestampMs", String(payload.timestampMs || 0));
  if (payload.titleCiphertext) form.set("titleCiphertext", payload.titleCiphertext);
  if (payload.titleIv) form.set("titleIv", payload.titleIv);
  if (payload.titleVersion) form.set("titleVersion", payload.titleVersion);
  if (payload.noteCiphertext) form.set("noteCiphertext", payload.noteCiphertext);
  if (payload.noteIv) form.set("noteIv", payload.noteIv);
  if (payload.noteVersion) form.set("noteVersion", payload.noteVersion);
  return request<VaultResponse>("/api/vault", {
    method: "POST",
    body: form,
  });
}

// Note: server pins displayTitle to "Private Clip" and ignores any value the
// client supplies. The rename channel is the encrypted `title` payload.
export function updateVaultTitle(payload: {
  workspaceId: string;
  id: string;
  titleCiphertext: string;
  titleIv: string;
  titleVersion?: string;
}): Promise<VaultResponse> {
  return request<VaultResponse>("/api/vault", {
    method: "PATCH",
    body: JSON.stringify({
      workspaceId: payload.workspaceId,
      id: payload.id,
      action: "title",
      title: {
        ...(payload.titleVersion ? { v: payload.titleVersion } : {}),
        ciphertext: payload.titleCiphertext,
        iv: payload.titleIv,
      },
    }),
  });
}

export function updateVaultMomentTitle(payload: {
  workspaceId: string;
  id: string;
  momentId: string;
  titleCiphertext: string;
  titleIv: string;
  titleVersion?: string;
}): Promise<VaultResponse> {
  return request<VaultResponse>("/api/vault", {
    method: "PATCH",
    body: JSON.stringify({
      workspaceId: payload.workspaceId,
      id: payload.id,
      action: "moment_title",
      momentId: payload.momentId,
      title: {
        ...(payload.titleVersion ? { v: payload.titleVersion } : {}),
        ciphertext: payload.titleCiphertext,
        iv: payload.titleIv,
      },
    }),
  });
}

export function getVaultMedia(payload: {
  workspaceId: string;
  id: string;
  kind?: "video" | "moment";
  momentId?: string;
}): Promise<Blob> {
  const params = new URLSearchParams();
  params.set("workspaceId", payload.workspaceId);
  params.set("id", payload.id);
  if (payload.kind) params.set("kind", payload.kind);
  if (payload.momentId) params.set("momentId", payload.momentId);
  return requestBlob(`/api/vault-media?${params.toString()}`);
}

export function setVaultReaction(payload: {
  workspaceId: string;
  id: string;
  reaction: VaultReactionId | null;
}): Promise<VaultResponse> {
  return request<VaultResponse>("/api/vault", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function addVaultComment(payload: {
  workspaceId: string;
  id: string;
  commentId?: string;
  commentCiphertext: string;
  commentIv: string;
  commentVersion?: string;
}): Promise<VaultResponse> {
  return request<VaultResponse>("/api/vault", {
    method: "PATCH",
    body: JSON.stringify({
      workspaceId: payload.workspaceId,
      id: payload.id,
      action: "comment",
      ...(payload.commentId ? { commentId: payload.commentId } : {}),
      comment: {
        ...(payload.commentVersion ? { v: payload.commentVersion } : {}),
        ciphertext: payload.commentCiphertext,
        iv: payload.commentIv,
      },
    }),
  // Vault comments are encrypted text the user typed during a vault
  // unlock session. Losing one to network silently is the same kind of
  // emotional disaster as losing an Ask reply — queue + replay.
  }, undefined, { queueable: true, intent: "vault:comment" });
}

export function deleteVaultItem(payload: {
  workspaceId: string;
  id: string;
}): Promise<VaultResponse> {
  return request<VaultResponse>("/api/vault", {
    method: "DELETE",
    body: JSON.stringify(payload),
  });
}

export function deleteVaultMoment(payload: {
  workspaceId: string;
  id: string;
  momentId: string;
}): Promise<VaultResponse> {
  return request<VaultResponse>("/api/vault", {
    method: "DELETE",
    body: JSON.stringify({
      workspaceId: payload.workspaceId,
      id: payload.id,
      action: "moment",
      momentId: payload.momentId,
    }),
  });
}

export function getPile(workspaceId?: string): Promise<PileResponse> {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<PileResponse>(`/api/pile${qs}`)
    .then((response) => decryptPileResponse(response, workspaceId || ""));
}

export function startPile(payload: {
  workspaceId: string;
  revealAt: string;
}): Promise<PileResponse> {
  return request<PileResponse>("/api/pile", {
    method: "POST",
    body: JSON.stringify({ ...payload, action: "start" }),
  }).then((response) => decryptPileResponse(response, payload.workspaceId));
}

export function updatePileTime(payload: {
  workspaceId: string;
  revealAt: string;
}): Promise<PileResponse> {
  return request<PileResponse>("/api/pile", {
    method: "POST",
    body: JSON.stringify({ ...payload, action: "update-time" }),
  }).then((response) => decryptPileResponse(response, payload.workspaceId));
}

export function dropPileAct(payload: {
  workspaceId: string;
  label: string;
}): Promise<PileResponse> {
  return preparePileDropPayload(payload)
    .then((body) => request<PileResponse>("/api/pile", {
      method: "POST",
      body: JSON.stringify({ ...body, action: "drop" }),
    }))
    .then((response) => decryptPileResponse(response, payload.workspaceId));
}

export function undropPileAct(payload: {
  workspaceId: string;
  label: string;
}): Promise<PileResponse> {
  return preparePileUndropPayload(payload)
    .then((body) => request<PileResponse>("/api/pile", {
      method: "POST",
      body: JSON.stringify({ ...body, action: "undrop" }),
    }))
    .then((response) => decryptPileResponse(response, payload.workspaceId));
}

export function endPile(payload: {
  workspaceId: string;
}): Promise<PileResponse> {
  return request<PileResponse>(`/api/pile?workspaceId=${encodeURIComponent(payload.workspaceId)}`, {
    method: "DELETE",
  }).then((response) => decryptPileResponse(response, payload.workspaceId));
}

export function declinePile(payload: {
  workspaceId: string;
}): Promise<PileResponse> {
  return request<PileResponse>("/api/pile", {
    method: "POST",
    body: JSON.stringify({ ...payload, action: "decline" }),
  }).then((response) => decryptPileResponse(response, payload.workspaceId));
}

export function lockPile(payload: {
  workspaceId: string;
}): Promise<PileResponse> {
  return request<PileResponse>("/api/pile", {
    method: "POST",
    body: JSON.stringify({ ...payload, action: "lock" }),
  }).then((response) => decryptPileResponse(response, payload.workspaceId));
}

export function removePileSession(payload: {
  workspaceId: string;
  sessionId: string;
}): Promise<PileResponse> {
  const qs = new URLSearchParams({
    workspaceId: payload.workspaceId,
    sessionId: payload.sessionId,
  });
  return request<PileResponse>(`/api/pile?${qs.toString()}`, {
    method: "DELETE",
  }).then((response) => decryptPileResponse(response, payload.workspaceId));
}

export function getBlindReveal(workspaceId?: string): Promise<BlindRevealResponse> {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<BlindRevealResponse>(`/api/blind-reveals${qs}`)
    .then(decryptBlindRevealResponse);
}

export function getSexQuiz(workspaceId?: string): Promise<SexQuizResponse> {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request<SexQuizResponse>(`/api/sex-quiz${qs}`);
}

export function submitSexQuiz(payload: {
  workspaceId: string;
  ratings: Record<string, SexQuizRating>;
  topPicks: string[];
}): Promise<SexQuizResponse> {
  return request<SexQuizResponse>("/api/sex-quiz", {
    method: "POST",
    body: JSON.stringify({ ...payload, action: "submit" }),
  });
}

export function retakeSexQuiz(workspaceId: string): Promise<SexQuizResponse> {
  return request<SexQuizResponse>("/api/sex-quiz", {
    method: "POST",
    body: JSON.stringify({ workspaceId, action: "retake" }),
  });
}

export function setSexQuizFullReveal(payload: { workspaceId: string; on: boolean }): Promise<SexQuizResponse> {
  return request<SexQuizResponse>("/api/sex-quiz", {
    method: "POST",
    body: JSON.stringify({ ...payload, action: "full_reveal" }),
  });
}

export function setSexQuizTopPicks(payload: { workspaceId: string; topPicks: string[] }): Promise<SexQuizResponse> {
  return request<SexQuizResponse>("/api/sex-quiz", {
    method: "POST",
    body: JSON.stringify({ ...payload, action: "set_top_picks" }),
  });
}

export function getGreenLights(workspaceId: string): Promise<GreenLightsResponse> {
  return request<GreenLightsResponse>(`/api/green-lights?workspaceId=${encodeURIComponent(workspaceId)}`);
}

export function submitGreenLights(payload: { workspaceId: string; answers: Record<string, GreenLightAnswer> }): Promise<GreenLightsResponse> {
  return request<GreenLightsResponse>("/api/green-lights", {
    method: "POST",
    body: JSON.stringify({ ...payload, action: "submit" }),
  });
}

export function retakeGreenLights(workspaceId: string): Promise<GreenLightsResponse> {
  return request<GreenLightsResponse>("/api/green-lights", {
    method: "POST",
    body: JSON.stringify({ workspaceId, action: "retake" }),
  });
}

export function getPrompt(payload: {
  workspaceId: string;
  kind: "confidence" | "curiosity";
}): Promise<PromptResponse> {
  return request<PromptResponse>(
    `/api/prompts?workspaceId=${encodeURIComponent(payload.workspaceId)}&kind=${encodeURIComponent(payload.kind)}`,
  );
}

export function narrateActs(payload: {
  you: string;
  partner: string;
  acts: string[];
  timing?: string;
  filming?: boolean;
}): Promise<{ text?: string; fallback?: string; source?: string }> {
  return requestNarration("/api/narrate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function requestNarration(url: string, init: RequestInit = {}): Promise<{ text?: string; fallback?: string; source?: string }> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) {
    maybeReconnectStandalonePwa();
    throw new ApiUnauthorizedError();
  }
  const text = await response.text();
  const data = text ? safeJson(text) : null;
  if (!response.ok && !(data as { fallback?: string } | null)?.fallback) {
    const message = (data as ApiError | null)?.error || response.statusText || "Request failed";
    throw new ApiFailureError(response.status, message);
  }
  return (data || {}) as { text?: string; fallback?: string; source?: string };
}

export function createBlindReveal(payload: {
  workspaceId: string;
  prompt: string;
}): Promise<BlindRevealResponse> {
  return prepareCreateBlindRevealPayload(payload)
    .then((body) => request<BlindRevealResponse>("/api/blind-reveals", {
      method: "POST",
      body: JSON.stringify({ ...body, action: "create" }),
    }))
    .then(decryptBlindRevealResponse);
}

export function submitBlindReveal(payload: {
  workspaceId: string;
  id: string;
  text: string;
}): Promise<BlindRevealResponse> {
  return prepareSubmitBlindRevealPayload(payload)
    .then((body) => request<BlindRevealResponse>("/api/blind-reveals", {
      method: "POST",
      body: JSON.stringify({ ...body, action: "submit" }),
    }))
    .then(decryptBlindRevealResponse);
}

export function archiveBlindReveal(payload: {
  workspaceId: string;
  id: string;
}): Promise<BlindRevealResponse> {
  return request<BlindRevealResponse>("/api/blind-reveals", {
    method: "POST",
    body: JSON.stringify({ ...payload, action: "archive" }),
  }).then(decryptBlindRevealResponse);
}

export function promoteBlindRevealEntry(payload: {
  workspaceId: string;
  id: string;
}): Promise<BlindRevealResponse> {
  return request<BlindRevealResponse>("/api/blind-reveals", {
    method: "POST",
    body: JSON.stringify({ ...payload, action: "promote_entry" }),
  }).then(decryptBlindRevealResponse);
}

// Take back a reveal you started, before it opens (status "open"). Starter-only.
export function cancelBlindReveal(payload: {
  workspaceId: string;
  id: string;
}): Promise<BlindRevealResponse> {
  return request<BlindRevealResponse>("/api/blind-reveals", {
    method: "POST",
    body: JSON.stringify({ ...payload, action: "cancel" }),
  }).then(decryptBlindRevealResponse);
}

export async function updateWorkspaceAction(payload: {
  workspaceId: string;
  action: "schedule_deletion" | "cancel_deletion" | "finalize_deletion" | "leave";
  confirmation?: string;
}): Promise<{ workspace?: unknown; ok?: boolean; deletedWorkspaceId?: string }> {
  const result = await request<{ workspace?: unknown; ok?: boolean; deletedWorkspaceId?: string }>("/api/workspace", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  dispatchProfileStale();
  return result;
}

// ---------- Workspace + invite ----------

export interface InvitePreview {
  id: string;
  workspaceId: string;
  workspaceName: string;
  inviterEmail: string;
  inviterName: string;
  inviteeEmail: string;
  inviteeName: string;
  createdAt: string;
  expiresAt: string;
  status: string;
  claimable: boolean;
}

export interface InviteListResponse {
  invites: InvitePreview[];
  sent: InvitePreview[];
}

export async function createWorkspaceForSelf(payload: {
  ownerName?: string;
  partnerName?: string;
  displayName?: string;
  workspaceName?: string;
}): Promise<ProfileResponse> {
  const result = await request<ProfileResponse>("/api/profile", {
    method: "POST",
    body: JSON.stringify({ action: "create_workspace", ...payload }),
  });
  dispatchProfileStale();
  return result;
}

export async function createClaimableInvite(payload: {
  workspaceId: string;
}): Promise<{ invite: InvitePreview; inviteUrl: string }> {
  const result = await request<{ invite: InvitePreview; inviteUrl: string }>("/api/invite", {
    method: "POST",
    body: JSON.stringify({ action: "send", workspaceId: payload.workspaceId }),
  });
  dispatchProfileStale();
  return result;
}

export function getInvitePreview(inviteId: string, signal?: AbortSignal): Promise<{ invite: InvitePreview }> {
  return request<{ invite: InvitePreview }>(
    `/api/invite?inviteId=${encodeURIComponent(inviteId)}`,
    signal ? { signal } : undefined,
  );
}

export function getMyInvites(): Promise<InviteListResponse> {
  return request<InviteListResponse>("/api/invite");
}

export async function acceptInvite(inviteId: string): Promise<{ workspaceId: string }> {
  const result = await request<{ workspaceId: string }>("/api/invite", {
    method: "PATCH",
    body: JSON.stringify({ inviteId, action: "accept" }),
  });
  dispatchProfileStale();
  return result;
}

export async function declineInvite(inviteId: string): Promise<{ ok: boolean }> {
  const result = await request<{ ok: boolean }>("/api/invite", {
    method: "PATCH",
    body: JSON.stringify({ inviteId, action: "decline" }),
  });
  dispatchProfileStale();
  return result;
}

export async function revokeInvite(inviteId: string): Promise<{ ok: boolean }> {
  const result = await request<{ ok: boolean }>("/api/invite", {
    method: "DELETE",
    body: JSON.stringify({ inviteId }),
  });
  dispatchProfileStale();
  return result;
}

export function submitFeedback(payload: FeedbackPayload): Promise<FeedbackResponse> {
  return request<FeedbackResponse>("/api/feedback", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getAdminDashboard(): Promise<AdminDashboardResponse> {
  return request<AdminDashboardResponse>("/api/admin/dashboard");
}

export function deleteAdminFeedback(payload: {
  workspaceId: string;
  feedbackId: string;
}): Promise<AdminDeleteFeedbackResponse> {
  return request<AdminDeleteFeedbackResponse>("/api/admin/dashboard", {
    method: "DELETE",
    body: JSON.stringify(payload),
  });
}

// CF Access logout — clears the session cookie and bounces back to /.
export const CF_ACCESS_LOGOUT_URL = "/cdn-cgi/access/logout";
