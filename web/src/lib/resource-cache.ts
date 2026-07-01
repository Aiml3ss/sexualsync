"use client";

import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { decryptFromString, encryptToString } from "./device-cipher";

/**
 * Stale-while-revalidate cache for page-level resource snapshots, with an
 * encrypted on-disk tier so the win survives a cold start (app reopen / full
 * reload / first visit of a session), not just same-session SPA revisits.
 *
 * Why: every heavy page gates its first paint on an awaited API call, and those
 * run ~0.5-0.9s (CF KV is cold for a low-traffic private app). This holds the
 * last successfully-rendered UI state per route so a page paints from it
 * instantly while its own reload() revalidates in the background.
 *
 * THREE TIERS:
 *   1. memory (sync, 0ms)        — same-session revisits.
 *   2. IndexedDB (async, ~tens of ms + one-time key derive) — cold start.
 *   3. network (the page's reload()) — the source of truth; always revalidates.
 *
 * THIS IS A DISPOSABLE READ CACHE. The server remains authoritative; nothing
 * here is ever written back to the server, so it cannot corrupt or lose data.
 * On any miss/decrypt-failure we fall through to the network.
 *
 * SECURITY: snapshots hold DECRYPTED data, so the on-disk tier stores them as
 * AES-GCM ciphertext via device-cipher (per-install device key), never
 * plaintext — same boundary as private notes / vault titles. Memory tier is
 * in-process only. Both are wiped by clearResourceCache() on sign-out and the
 * cross-tab relock broadcast.
 */

const MEM = new Map<string, unknown>();
const DB_NAME = "ss-snapshots";
const STORE = "snapshots";
const DB_VERSION = 1;

// --- Public memory API -----------------------------------------------------

/** Sync read of the in-memory snapshot for a route key. */
export function getCachedResource<T>(key: string): T | undefined {
  return MEM.get(key) as T | undefined;
}

/** Store the latest snapshot: memory now, encrypted IDB in the background. */
export function setCachedResource<T>(key: string, value: T): void {
  MEM.set(key, value);
  void persist(key, value);
}

/** Drop one route's snapshot from both tiers. */
export function invalidateResource(key: string): void {
  MEM.delete(key);
  void idbDelete(key);
}

/** Wipe everything (sign-out / cross-tab relock). */
export function clearResourceCache(): void {
  MEM.clear();
  void idbClear();
}

/**
 * Cold-start loader: decrypt the persisted snapshot for a key and promote it to
 * memory. Returns undefined on miss / unavailable IDB / decrypt failure.
 */
export async function loadColdSnapshot<T>(key: string): Promise<T | undefined> {
  try {
    const encoded = await idbGet(key);
    if (!encoded) return undefined;
    const json = await decryptFromString(encoded);
    if (!json) return undefined;
    const value = JSON.parse(json) as T;
    if (MEM.get(key) === undefined) MEM.set(key, value);
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Hook: on mount, if there's no in-memory snapshot, asynchronously load the
 * persisted one and apply it ONLY while the page is still in its "loading"
 * state — so it never clobbers fresh data the network already delivered. No-op
 * once memory is warm (same-session revisit) or once reload() has resolved.
 */
export function useColdStart<S extends { kind: string }>(
  key: string,
  setState: Dispatch<SetStateAction<S>>,
): void {
  useEffect(() => {
    if (getCachedResource(key) !== undefined) return;
    let cancelled = false;
    void loadColdSnapshot<S>(key).then((snapshot) => {
      if (cancelled || snapshot === undefined) return;
      setState((current) => (current.kind === "loading" ? snapshot : current));
    });
    return () => { cancelled = true; };
  }, [key, setState]);
}

// --- Internals -------------------------------------------------------------

async function persist<T>(key: string, value: T): Promise<void> {
  try {
    const encoded = await encryptToString(JSON.stringify(value));
    await idbPut(key, encoded);
  } catch {
    // Encryption/IDB unavailable (private mode, quota) — memory tier still works.
  }
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let settled = false;
    const done = (db: IDBDatabase | null) => { if (!settled) { settled = true; resolve(db); } };
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        try {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        } catch { /* ignore */ }
      };
      req.onsuccess = () => done(req.result);
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
    } catch {
      done(null);
    }
  });
}

function idbGet(key: string): Promise<string | null> {
  return new Promise(async (resolve) => {
    const db = await openDb();
    if (!db) return resolve(null);
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbPut(key: string, value: string): Promise<void> {
  return new Promise(async (resolve) => {
    const db = await openDb();
    if (!db) return resolve();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

function idbDelete(key: string): Promise<void> {
  return new Promise(async (resolve) => {
    const db = await openDb();
    if (!db) return resolve();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

function idbClear(): Promise<void> {
  return new Promise(async (resolve) => {
    const db = await openDb();
    if (!db) return resolve();
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
