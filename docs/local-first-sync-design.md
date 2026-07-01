# Local-First Sync — Scoping & Design

Status: **proposal / scoping**. Not yet approved or started.
Author: perf investigation follow-up (see the SWR work in `web/src/lib/resource-cache.ts`, PR #73).

---

## 1. Problem

Every heavy page gates its first paint on an `await`ed API call, and those run
**~0.5–0.9s** server-side. Traced on the deployed app:

| endpoint | TTFB | download |
|---|---|---|
| `/api/sexboard` | 488–920ms | 4ms |

The cost is **not** transfer, bundle, CSS, or N+1 — the read handlers are already
parallel (`functions/api/sexboard.js` does `Promise.all` of 6 reads). It's
**Cloudflare KV cold-read latency**: a 2-person private app never makes keys hot
at an edge POP, so nearly every read hits central store, plus a ~107ms
`ensurePlatformIdentity` auth prefix. KV is the wrong fit for this access pattern.

The in-memory SWR cache (PR #73) hides this on **revisit**, but **first visit per
session and the underlying latency remain**. Local-first removes the class of
problem: never fetch-on-nav.

## 2. Why local-first fits this app unusually well

- **Tiny dataset, two users, append-mostly.** A couple's entire request board /
  fantasy backlog / pile / shelf is small and grows slowly. It fits in the client.
- **A realtime spine already exists.** `web/src/lib/use-live-room.ts` already
  subscribes to a room socket and resumes with `lastEventSeq`. Today it reacts to
  an event by **refetching everything** — that is the waste. Evolve it to *apply
  the delta to a local store*.
- **IndexedDB is already in use** (`web/src/lib/offline-queue.ts`) for queued writes.
- **The server already sequences events** — the room Durable Object issues a
  monotonic `seq` (`room.event { seq }`). That is the total order a replica needs.

## 3. Core decision: the local replica stores CIPHERTEXT

This is the design's keystone and what makes local-first compatible with the
app's E2EE + secure-caching boundary.

Throughout the app the rule is **never write decrypted data to disk** (the SW
doesn't cache `/api`; `resource-cache.ts` is memory-only; private notes + vault
titles are AES-GCM-encrypted at rest via `device-cipher.ts`). A persistent local
replica must not break that.

**So the replica mirrors the server's *encrypted* records.** IndexedDB stores the
same ciphertext blobs the server (KV) holds. Decryption happens **in memory on
read**, exactly as it does today (`room-record-crypto.ts`) — only the network hop
disappears. This means:

- At rest, IDB holds ciphertext only → same exposure as the server, no new leak.
- Sync exchanges **encrypted deltas** → the room DO / WS relays them **without
  decrypting** → E2EE preserved end-to-end.
- Offline reads = read local ciphertext + decrypt in memory.
- On sign-out / relock, wipe the IDB database (reuse the existing
  `indexedDB.deleteDatabase` pattern in `signout.ts` / `PwaBridge`).
- While the room key is locked (the 30s away-relock in `room-crypto.ts`), the
  replica shows a locked state — it cannot decrypt, same as today.

## 4. Architecture

**Server stays authoritative + is the sequencer.** This is server-authoritative
replication (Replicache-style), NOT peer-to-peer CRDT. The server orders writes
by `seq`; clients hold a replica reconciled against that order. Simpler than CRDT
and fits E2EE (the server sequences opaque ciphertext blindly).

```
        write (ciphertext + mutationId)
client ───────────────────────────────────▶ Pages Function
  │                                            │ store in KV, assign seq
  │ optimistic apply to local replica          │ broadcast {seq, resource,
  │                                            │   entityId, action, ciphertext}
  │           room.event {seq, ..., ciphertext}│   to partner over the room DO
  ◀────────────────────────────────────────────┘
  │ apply delta to IndexedDB (no refetch)
  ▼
render from local replica (decrypt in memory) — 0ms, no /api on nav
```

Pieces:
- **Local store** (`web/src/lib/local-store.ts`, new): IndexedDB, one object store
  per resource keyed by `entityId`, value = `{ seq, ciphertext, deletedAt? }`.
  Plus a `meta` store holding `lastSeq` per resource. Read API decrypts in memory
  and caches the decrypted view (the existing in-memory layer / `resource-cache`).
- **Pull** (initial hydration / cold start / gap recovery): a `GET /api/sync/pull
  ?since=<seq>` returning all encrypted records with `seq > since` + the latest
  `seq`. One round trip to fully hydrate; thereafter incremental via WS.
- **Push** (writes): existing write endpoints, extended to (a) assign `seq`,
  (b) broadcast the ciphertext delta to the partner. Client applies optimistically
  with a `mutationId`; server echo confirms / supersedes.
- **Delta apply**: extend the room protocol so `room.event` carries the encrypted
  record blob (today it carries only metadata). Client applies directly — no refetch.
- **Ordering / gap handling**: client tracks `lastSeq`; if a delta arrives with
  `seq > lastSeq + 1` (missed events while offline), trigger a `pull?since=lastSeq`.
  Reuses the `lastEventSeq` resume already in `use-live-room.ts`.

## 5. Conflict resolution

Append-mostly + 2 users → conflicts are rare (both edit the same record at once).
Policy:
- **Per-record last-write-wins**, ordered by server `seq` (the DO is the tiebreaker,
  so "last" is well-defined and not clock-dependent).
- **Deletes = tombstones** (`deletedAt`) so a delete can't be resurrected by a
  late-arriving older write.
- Optimistic local writes are replaced by the server's sequenced version on echo.

Full CRDT (Yjs/Automerge) is **rejected**: overkill for append-mostly couple data,
and its merge metadata complicates the ciphertext-only-at-rest model.

## 6. Data model & scope

In scope (the per-nav fetch offenders, all small JSON lists in KV today):
`request-board`, `fantasy-backlog`, `shelf`, `pile`, `blind-reveals`, `acts`,
`boundaries`, plus `activity` (read-model) and `presence` (ephemeral — stays
socket-only, not persisted).

**Out of scope (separate concern): Vault media.** Large encrypted R2 blobs.
Option later: cache the *encrypted* blobs in IndexedDB / CacheStorage (ciphertext,
so safe) for offline playback — but that's its own project; not part of v1.

`profile` / workspace: keep `getProfileCached` (already cached); optionally fold
into the replica later.

## 7. Two-runtime constraint (hard rule)

The room protocol has **two implementations of one protocol**: the Cloudflare DO
(`workers/room/src/index.js`) and the Node WS room (`selfhost/lib/ws-room.mjs`).
Per the repo rules, **any protocol change must update both**. Carrying ciphertext
on `room.event` + the `pull` endpoint must land in both, with a shared protocol
conformance test.

## 8. Build vs buy

**Build a thin layer on the existing spine. Do not adopt a framework.**
- **Replicache**: closest pattern (client mutations + server push/pull + LWW), but
  it's a paid product and assumes a mutator/server model we'd reshape anyway.
  *Borrow the pattern, not the dependency.*
- **Zero / ElectricSQL / Triplit**: want to index/query rows **server-side** — our
  data is ciphertext the server can't read. Fundamental mismatch with E2EE.
- **Automerge / Yjs (CRDT)**: overkill for append-mostly; metadata fights the
  ciphertext-at-rest model.

We already have ~60% of the engine (room DO + seq'd WS + `lastEventSeq` resume +
client crypto + IDB). The gap is: local store, pull endpoint, ciphertext-on-delta,
optimistic write reconciliation.

## 9. Phased rollout (de-risked, flag-gated)

- **Phase 0 — Foundation (shadow mode).** Build `local-store.ts` + `pull` endpoint.
  Populate the replica from existing fetches and **compare** to network results in
  the console. No behavior change. Proves the store + decrypt path.
- **Phase 1 — One resource reads local.** Pick `request-board` (the Sexboard board).
  Read from the replica; apply WS deltas with ciphertext; `pull` on gap. Everything
  else stays on fetch. **Measure nav latency.** This is the risky/valuable proof.
- **Phase 2 — Expand reads** to fantasy-backlog, pile, shelf, acts, boundaries,
  blind-reveals.
- **Phase 3 — Writes.** Optimistic local apply + server sequence + offline write
  (merge with the existing `offline-queue`).
- **Phase 4 — Drop per-nav fetches.** Nav reads purely local; `pull` only on
  cold start / gap. Delete the SWR shim where the replica supersedes it.

Each phase is independently shippable and flag-gated (`?lf=1` / env flag), with
fetch fallback if the replica is unavailable (Safari private mode, IDB eviction).

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Protocol change touches both room impls | Shared conformance test; land DO + selfhost together (repo rule). |
| Decrypted data leaking to disk | Replica stores **ciphertext only**; decrypt in memory; wipe IDB on signout. |
| Key locked / rotated → can't decrypt replica | Show locked state (as today); re-decrypt on unlock; relock wipes the in-memory decrypted view, not the ciphertext. |
| IDB eviction (Safari ITP / private mode) | `pull` fallback; treat replica as a cache, server as source of truth. |
| Migration of existing users | `pull?since=0` hydrates from current KV; flag-gated rollout with fetch fallback. |
| Conflict edge cases | Server `seq` LWW + tombstones; covered by sync conformance tests. |
| Scope creep into Vault media | Explicitly out of v1. |
| Gates (E2EE, two-user, selfhost) | New sync test + run existing `check:e2ee`, `check:two-user`, `selfhost:*`. |

## 11. Effort (rough)

- Phase 0–1 (foundation + one resource proof): the bulk of the design risk. Several
  PRs.
- Phases 2–4: largely mechanical expansion once the pattern is proven.
This is a **multi-PR project**, not a single change. Phase 1's measurement is the
go/no-go gate for the rest.

## 12. Open questions (need owner input)

1. **Ciphertext-in-IndexedDB acceptable?** (Proposed: yes — same exposure as the
   server, never decrypted at rest. This doc assumes yes.)
2. **Offline writes** in scope for v1, or instant *reads* only first?
3. **Vault media** offline — defer (proposed) or include?
4. **Conflict policy**: is per-record LWW acceptable, or must concurrent edits to
   the same record both be preserved? (LWW proposed.)
5. **Rollout**: behind a flag for the maintainer's own instance first, then default-on?
