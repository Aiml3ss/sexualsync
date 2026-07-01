/**
 * IndexedDB-backed write queue for offline-composed writes.
 *
 * Pattern: a composer wrapped with `queueOnFailure(fn, request)` will call
 * `fn(request)` when online. If the network fails, the request is enqueued
 * to IndexedDB. Whenever the browser comes back online (or the PWA is
 * focused), `flushOfflineQueue()` retries every queued write in arrival
 * order. Successful writes are dropped; failures stay queued for the next
 * attempt with a small backoff.
 *
 * Why IndexedDB instead of localStorage: blobs, JSON-incompatible bodies,
 * and the fact that this state needs to survive PWA cold launches. The
 * browser persists IndexedDB independent of the tab lifecycle.
 *
 * Why no Service Worker `sync` event: iOS Safari ships no `sync` event at
 * all, and our biggest mobile audience is iPhone. We hook `online` +
 * focus + visibilitychange instead. The SW can still fire flush on its
 * own clients when it sees a `sync` event in supported browsers — that's
 * a future addition, the IDB store is shared.
 */

const DB_NAME = "ss-offline-queue";
const DB_VERSION = 1;
const STORE_NAME = "queued-writes";
const BODY_ENVELOPE_MARKER = "__sxsOfflineQueueEncrypted";
const BODY_ENVELOPE_VERSION = 1 as const;
const QUEUE_SECRET_KEY = "ss:offline-queue:dk:v1";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface QueuedBodyEnvelope {
  [BODY_ENVELOPE_MARKER]: true;
  v: typeof BODY_ENVELOPE_VERSION;
  alg: "AES-GCM";
  iv: string;
  ct: string;
}

export interface QueuedWriteRecord {
  id?: number;
  // Tag used by the composer to surface "Saved when back online" UX and to
  // group / dedupe by intent. Examples: "ask:create", "idea:comment".
  intent: string;
  // Idempotency key the server uses to dedupe replayed writes. Generate
  // once at composer-call time, reuse on every retry.
  idempotencyKey: string;
  url: string;
  method: string;
  // Body shape: only JSON bodies are queueable. FormData (binary uploads)
  // is not — vault clip uploads need their own resumable channel (H-3).
  body: unknown;
  // Wall-clock when first queued, for "this has been sitting for X" UX.
  enqueuedAt: number;
  // Last retry timestamp + attempt count; cron-style backoff.
  lastTriedAt: number;
  attempts: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let queueKeyPromise: Promise<CryptoKey> | null = null;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function readOrCreateQueueSecret(): Uint8Array {
  if (typeof window === "undefined" || !window.localStorage) {
    throw new Error("Offline queue encryption requires localStorage.");
  }
  const existing = window.localStorage.getItem(QUEUE_SECRET_KEY);
  if (existing) return base64ToBytes(existing);
  const secret = crypto.getRandomValues(new Uint8Array(32));
  window.localStorage.setItem(QUEUE_SECRET_KEY, bytesToBase64(secret));
  return secret;
}

function getQueueKey(): Promise<CryptoKey> {
  if (queueKeyPromise) return queueKeyPromise;
  queueKeyPromise = crypto.subtle.importKey(
    "raw",
    readOrCreateQueueSecret() as BufferSource,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  queueKeyPromise.catch(() => { queueKeyPromise = null; });
  return queueKeyPromise;
}

function isQueuedBodyEnvelope(value: unknown): value is QueuedBodyEnvelope {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { [BODY_ENVELOPE_MARKER]?: unknown })[BODY_ENVELOPE_MARKER] === true
    && (value as { v?: unknown }).v === BODY_ENVELOPE_VERSION
    && (value as { alg?: unknown }).alg === "AES-GCM"
    && typeof (value as { iv?: unknown }).iv === "string"
    && typeof (value as { ct?: unknown }).ct === "string"
  );
}

function bodyAad(record: Pick<QueuedWriteRecord, "intent" | "idempotencyKey" | "url" | "method" | "enqueuedAt">): Uint8Array {
  return textEncoder.encode(JSON.stringify({
    v: BODY_ENVELOPE_VERSION,
    intent: record.intent,
    idempotencyKey: record.idempotencyKey,
    url: record.url,
    method: record.method,
    enqueuedAt: record.enqueuedAt,
  }));
}

async function encryptQueuedBody(record: QueuedWriteRecord): Promise<QueuedBodyEnvelope> {
  const key = await getQueueKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(record.body ?? null));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: bodyAad(record) as BufferSource },
    key,
    plaintext,
  );
  return {
    [BODY_ENVELOPE_MARKER]: true,
    v: BODY_ENVELOPE_VERSION,
    alg: "AES-GCM",
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(encrypted)),
  };
}

async function decryptQueuedBody(record: QueuedWriteRecord): Promise<unknown> {
  if (!isQueuedBodyEnvelope(record.body)) return record.body;
  const key = await getQueueKey();
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(record.body.iv) as BufferSource,
      additionalData: bodyAad(record) as BufferSource,
    },
    key,
    base64ToBytes(record.body.ct) as BufferSource,
  );
  return JSON.parse(textDecoder.decode(decrypted));
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available."));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed."));
  });
  return dbPromise;
}

function runTransaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    let outcome: T | undefined;
    const maybe = work(store);
    if (maybe instanceof IDBRequest) {
      maybe.onsuccess = () => { outcome = maybe.result as T; };
      maybe.onerror = () => reject(maybe.error || new Error("IndexedDB request failed."));
    } else {
      Promise.resolve(maybe).then((value) => { outcome = value; }).catch(reject);
    }
    tx.oncomplete = () => resolve(outcome as T);
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
  }));
}

export function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID: 32 random base36 chars.
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

export async function enqueueWrite(record: Omit<QueuedWriteRecord, "id" | "enqueuedAt" | "lastTriedAt" | "attempts">): Promise<number> {
  const now = Date.now();
  const full: QueuedWriteRecord = {
    ...record,
    enqueuedAt: now,
    lastTriedAt: 0,
    attempts: 0,
  };
  full.body = await encryptQueuedBody(full);
  return runTransaction("readwrite", (store) => store.add(full)) as Promise<number>;
}

export async function listQueuedWrites(): Promise<QueuedWriteRecord[]> {
  return runTransaction("readonly", (store) => store.getAll()) as Promise<QueuedWriteRecord[]>;
}

export async function removeQueuedWrite(id: number): Promise<void> {
  await runTransaction("readwrite", (store) => store.delete(id));
}

async function updateQueuedWrite(record: QueuedWriteRecord): Promise<void> {
  await runTransaction("readwrite", (store) => store.put(record));
}

let flushing = false;
const flushListeners = new Set<(count: number) => void>();

export function subscribeOfflineFlush(fn: (count: number) => void): () => void {
  flushListeners.add(fn);
  return () => flushListeners.delete(fn);
}

function notifyListeners(count: number) {
  flushListeners.forEach((fn) => {
    try { fn(count); } catch { /* listener errors are non-fatal */ }
  });
}

// Fired when a queued write is discarded WITHOUT having been applied (boundary
// conflict, expired session). The user was promised "will send when you're
// back online" — silently dropping that intent breaks the promise, so surface
// it to whoever is listening (LiveActivityToast shows these as notices).
export const OFFLINE_WRITE_DROPPED_EVENT = "ss:offline-write-dropped";

export interface DroppedOfflineWriteDetail {
  intent: string;
  reason: string;
}

function announceDroppedWrite(record: QueuedWriteRecord, reason: string) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent<DroppedOfflineWriteDetail>(OFFLINE_WRITE_DROPPED_EVENT, {
      detail: { intent: record.intent, reason },
    }));
  } catch { /* announcement is best-effort */ }
}

// Backoff: 0 attempts → retry immediately; 1 → wait 5s; 2 → 15s; 3 → 60s.
function isReadyToRetry(record: QueuedWriteRecord, now: number): boolean {
  if (record.attempts <= 0) return true;
  const minDelay = Math.min(5 * 60_000, 5_000 * Math.pow(3, record.attempts - 1));
  return now - record.lastTriedAt >= minDelay;
}

export async function flushOfflineQueue(): Promise<{ flushed: number; failed: number; pending: number }> {
  if (flushing) return { flushed: 0, failed: 0, pending: 0 };
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { flushed: 0, failed: 0, pending: 0 };
  }
  flushing = true;
  let flushed = 0;
  let failed = 0;
  try {
    const records = await listQueuedWrites();
    const now = Date.now();
    const ordered = records.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    for (const record of ordered) {
      if (!isReadyToRetry(record, now)) continue;
      try {
        const body = await decryptQueuedBody(record);
        const response = await fetch(record.url, {
          method: record.method,
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            "content-type": "application/json",
            "idempotency-key": record.idempotencyKey,
          },
          body: typeof body === "string" ? body : JSON.stringify(body),
        });
        if (response.ok || response.status === 409) {
          // 409 normally means the write already landed (idempotent replay /
          // "already accepted") — treat as success. EXCEPT a boundary
          // conflict: the body carries a `conflicts` array when the queued
          // intent was rejected against a Hard No added since it was saved.
          // That can never succeed on retry, so drop it — but say so.
          if (response.status === 409) {
            const body = await response.json().catch(() => null) as { error?: string; conflicts?: unknown[] } | null;
            if (body && Array.isArray(body.conflicts) && body.conflicts.length) {
              announceDroppedWrite(record, body.error || "A saved change conflicts with a Hard No boundary and wasn't sent.");
            }
          }
          if (record.id !== undefined) await removeQueuedWrite(record.id);
          flushed += 1;
          continue;
        }
        if (response.status === 401) {
          // Don't keep retrying writes after the user signed out — these
          // would just bounce off auth. Drop the record so we don't drain
          // the user's battery on a futile loop — but tell the user their
          // saved change didn't make it.
          announceDroppedWrite(record, "You were signed out before a saved change could send.");
          if (record.id !== undefined) await removeQueuedWrite(record.id);
          continue;
        }
        await updateQueuedWrite({
          ...record,
          attempts: record.attempts + 1,
          lastTriedAt: Date.now(),
        });
        failed += 1;
      } catch {
        await updateQueuedWrite({
          ...record,
          attempts: record.attempts + 1,
          lastTriedAt: Date.now(),
        });
        failed += 1;
      }
    }
    const remaining = await listQueuedWrites();
    notifyListeners(remaining.length);
    return { flushed, failed, pending: remaining.length };
  } finally {
    flushing = false;
  }
}

let listenersInstalled = false;

export function installOfflineQueueListeners(): void {
  if (listenersInstalled || typeof window === "undefined") return;
  listenersInstalled = true;
  const trigger = () => { void flushOfflineQueue(); };
  window.addEventListener("online", trigger);
  window.addEventListener("focus", trigger);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") trigger();
  });
  // Best-effort initial sweep on mount in case writes are pending from a
  // prior session that was killed before they could flush.
  trigger();
}
