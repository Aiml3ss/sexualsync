import type {
  Act,
  ActsResponse,
  BoundariesResponse,
  Boundary,
  BoundaryType,
  BlindReveal,
  BlindRevealEntry,
  BlindRevealResponse,
  BootstrapResponse,
  DecisionItem,
  FantasyBacklogResponse,
  Filming,
  KinkComment,
  KinkIdea,
  KinkReaction,
  PileEncryptedLabel,
  PileResponse,
  PileSession,
  PileView,
  RequestBoardResponse,
  RequestRecord,
  ReviewTokenResolveResponse,
  ReviewTokenSubmitResponse,
  SexboardResponse,
  ShelfItem,
  ShelfResponse,
  Timing,
} from "./types";
import {
  ROOM_E2EE_LOCKED_LABEL,
  ROOM_E2EE_PLACEHOLDER,
  createRoomBlindIndex,
  encryptRoomJson,
  hasUnlockedRoomE2eeKey,
  isRoomE2eeEnabled,
  isRoomEncryptedBox,
  type RoomE2eeRecoveryCandidate,
  tryDecryptRoomJson,
  type RoomEncryptedBox,
} from "./room-crypto";
import {
  redgifsShelfFromUrl,
  shelfContentLooksLikeUrl,
  shelfSourceForUrl,
  shelfSourceLabelForUrl,
} from "./shelf-source";

// Shelf/RedGifs URL logic lives in ./shelf-source (pure, no crypto). Re-export
// the public helpers so existing importers of this module keep compiling.
export { normalizeRedgifsId, redgifsIdFromUrl, shelfSourceForUrl } from "./shelf-source";

type JsonRecord = Record<string, unknown>;

const REQUEST_PAYLOAD_PURPOSE = "request:payload";
const REQUEST_REPLY_PURPOSE = "request:reply";
const BOUNDARY_TEXT_PURPOSE = "boundary:text";
const KINK_TEXT_PURPOSE = "kink:text";
const KINK_COMMENT_PURPOSE = "kink:comment";
const KINK_REACTION_NOTE_PURPOSE = "kink:reaction-note";
const BLIND_REVEAL_PROMPT_PURPOSE = "blind-reveal:prompt";
const BLIND_REVEAL_ENTRY_PURPOSE = KINK_TEXT_PURPOSE;
const SHELF_CONTENT_PURPOSE = "shelf:content";
const SHELF_TITLE_PURPOSE = "shelf:title";
const ACT_PAYLOAD_PURPOSE = "act:payload";
const PILE_LABEL_PURPOSE = "pile:label";
const ROOM_E2EE_RECOVERY_PURPOSES = [
  REQUEST_PAYLOAD_PURPOSE,
  REQUEST_REPLY_PURPOSE,
  BOUNDARY_TEXT_PURPOSE,
  KINK_TEXT_PURPOSE,
  KINK_COMMENT_PURPOSE,
  KINK_REACTION_NOTE_PURPOSE,
  BLIND_REVEAL_PROMPT_PURPOSE,
  SHELF_CONTENT_PURPOSE,
  SHELF_TITLE_PURPOSE,
  ACT_PAYLOAD_PURPOSE,
  PILE_LABEL_PURPOSE,
];

interface EncryptedRequestPayload {
  categories: string[];
  timing: Timing;
  filming: Filming;
  note: string;
  boundaryConflicts: string[];
}

interface EncryptedReplyPayload {
  decisions: DecisionItem[];
  note: string;
}

interface EncryptedBoundaryPayload {
  text: string;
}

interface EncryptedTextPayload {
  text: string;
  tags?: string[];
}

interface EncryptedReactionNotePayload {
  note: string;
}

interface EncryptedPromptPayload {
  prompt: string;
}

interface EncryptedEntryPayload {
  text: string;
}

interface EncryptedShelfContentPayload {
  content: string;
}

interface EncryptedShelfTitlePayload {
  title: string;
}

interface EncryptedActPayload {
  label: string;
  tags: string[];
}

interface EncryptedPileLabelPayload {
  label: string;
}

function shouldEncrypt(workspaceId: string) {
  return isRoomE2eeEnabled(workspaceId) || hasUnlockedRoomE2eeKey(workspaceId);
}

function requireUnlocked(workspaceId: string) {
  if (shouldEncrypt(workspaceId) && !hasUnlockedRoomE2eeKey(workspaceId)) {
    throw new Error("Unlock Room Encryption in Privacy first.");
  }
}

export function collectRoomE2eeRecoveryCandidates(value: unknown): RoomE2eeRecoveryCandidate[] {
  const candidates: RoomE2eeRecoveryCandidate[] = [];
  const seen = new Set<unknown>();
  const seenCandidates = new Set<string>();

  function visit(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (isRoomEncryptedBox(node)) {
      for (const purpose of ROOM_E2EE_RECOVERY_PURPOSES) {
        const key = `${purpose}:${node.kdf || "v1"}:${node.iv}:${node.ciphertext}`;
        if (seenCandidates.has(key)) continue;
        seenCandidates.add(key);
        candidates.push({ purpose, box: node });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    Object.values(node as JsonRecord).forEach(visit);
  }

  visit(value);
  return candidates;
}

function cleanArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : [];
}

function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  labels.forEach((label) => {
    const value = String(label || "").trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return;
    seen.add(key);
    out.push(value);
  });
  return out;
}

function timingFromCounter(value: unknown): Timing | "" {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (/\btonight\b/.test(text)) return "Tonight";
  if (/\bmid[-\s]?day\b|\bnoon\b|\bafternoon\b/.test(text)) return "Mid-day";
  if (/\btomorrow\b/.test(text)) return "Tomorrow";
  if (/\bnext\s+week\b/.test(text)) return "Next week";
  return "";
}

function filmingFromCounter(value: unknown): Filming | "" {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (/\b(no|without|nope)\b/.test(text)) return "No";
  if (/\b(yes|film|record|camera)\b/.test(text)) return "Yes";
  return "";
}

function applyAcceptedCounterState(record: RequestRecord, decisions: DecisionItem[]): RequestRecord {
  if (!record.counterAcceptedAt) return record;
  const counters = decisions.filter((item) => item.counter || item.counterActId);
  if (!counters.length) return record;

  const actLabels = uniqueLabels([
    ...decisions
      .filter((item) => item.decision === "Yes" && item.targetType === "act")
      .map((item) => item.label),
    ...counters
      .filter((item) => item.targetType === "act")
      .map((item) => item.counter || item.label),
  ]);
  const timingCounter = counters.find((item) => item.targetType === "timing") || null;
  const filmingCounter = counters.find((item) => item.targetType === "filming") || null;
  return {
    ...record,
    ...(actLabels.length ? { categories: actLabels } : {}),
    timing: timingFromCounter(timingCounter?.counter || timingCounter?.label) || record.timing,
    filming: filmingFromCounter(filmingCounter?.counter || filmingCounter?.label) || record.filming,
    acceptedCounters: counters,
    acceptedTimingCounter: timingCounter,
    acceptedFilmingCounter: filmingCounter,
  };
}

function lockedRequest(record: RequestRecord): RequestRecord {
  return {
    ...record,
    categories: [ROOM_E2EE_LOCKED_LABEL],
    note: "",
    boundaryConflicts: [],
    e2eeLocked: true,
  } as RequestRecord;
}

function lockedBoundary(boundary: Boundary): Boundary {
  return {
    ...boundary,
    text: ROOM_E2EE_LOCKED_LABEL,
    e2eeLocked: true,
  } as Boundary;
}

function lockedKink(idea: KinkIdea): KinkIdea {
  return {
    ...idea,
    text: ROOM_E2EE_LOCKED_LABEL,
    e2eeLocked: true,
  } as KinkIdea;
}

function lockedComment(comment: KinkComment): KinkComment {
  return {
    ...comment,
    text: ROOM_E2EE_LOCKED_LABEL,
    e2eeLocked: true,
  } as KinkComment;
}

function lockedBlindRevealEntry(entry: BlindRevealEntry): BlindRevealEntry {
  return {
    ...entry,
    text: ROOM_E2EE_LOCKED_LABEL,
    e2eeLocked: true,
  } as BlindRevealEntry;
}

function lockedShelfItem(item: ShelfItem): ShelfItem {
  return {
    ...item,
    title: item.title || ROOM_E2EE_LOCKED_LABEL,
    passageText: ROOM_E2EE_LOCKED_LABEL,
    sourceUrl: "",
    embedUrl: "",
    posterUrl: "",
    videoHdUrl: "",
    videoSdUrl: "",
    e2eeLocked: true,
  } as ShelfItem;
}

function lockedAct(act: Act): Act {
  return {
    ...act,
    label: ROOM_E2EE_LOCKED_LABEL,
    tags: [],
    e2eeLocked: true,
  } as Act;
}

function placeholderDecision(decision: Partial<DecisionItem>): DecisionItem {
  return {
    label: ROOM_E2EE_PLACEHOLDER,
    decision: decision.decision || "",
    counter: "",
    counterActId: "",
    note: "",
    targetType: decision.targetType || "act",
    actId: "",
  };
}

export async function prepareCreateRequestPayload<T extends {
  workspaceId: string;
  categories: string[];
  timing: Timing;
  filming: Filming;
  note?: string;
  boundaryConflicts?: string[];
}>(payload: T): Promise<T & { encryptedPayload?: RoomEncryptedBox }> {
  if (!shouldEncrypt(payload.workspaceId)) return payload;
  requireUnlocked(payload.workspaceId);
  const encryptedPayload = await encryptRoomJson<EncryptedRequestPayload>(
    payload.workspaceId,
    REQUEST_PAYLOAD_PURPOSE,
    {
      categories: payload.categories,
      timing: payload.timing,
      filming: payload.filming,
      note: payload.note || "",
      boundaryConflicts: payload.boundaryConflicts || [],
    },
  );
  return {
    ...payload,
    categories: [ROOM_E2EE_PLACEHOLDER],
    timing: "Tonight",
    filming: "No",
    note: "",
    boundaryConflicts: [],
    encryptedPayload,
  };
}

export async function prepareReplyPayload<T extends {
  workspaceId: string;
  decisions: Array<Partial<DecisionItem>>;
  note?: string;
}>(payload: T): Promise<T & { encryptedReply?: RoomEncryptedBox }> {
  if (!shouldEncrypt(payload.workspaceId)) return payload;
  requireUnlocked(payload.workspaceId);
  const decisions = payload.decisions.map((item) => ({
    label: String(item.label || ""),
    decision: item.decision || "",
    counter: String(item.counter || ""),
    counterActId: String(item.counterActId || ""),
    note: String(item.note || ""),
    targetType: item.targetType || "act",
    actId: String(item.actId || ""),
  })) as DecisionItem[];
  const encryptedReply = await encryptRoomJson<EncryptedReplyPayload>(
    payload.workspaceId,
    REQUEST_REPLY_PURPOSE,
    { decisions, note: payload.note || "" },
  );
  return {
    ...payload,
    decisions: payload.decisions.map(placeholderDecision),
    note: "",
    encryptedReply,
  };
}

export async function prepareReviewTokenSubmitPayload<T extends {
  workspaceId?: string;
  decisions: Array<Partial<DecisionItem>>;
  note?: string;
}>(payload: T): Promise<T & { encryptedReply?: RoomEncryptedBox }> {
  if (!payload.workspaceId) return payload;
  return prepareReplyPayload(payload as T & { workspaceId: string });
}

export async function prepareBoundaryPayload<T extends {
  workspaceId: string;
  text?: string;
  type?: BoundaryType;
}>(payload: T): Promise<T & { encryptedText?: RoomEncryptedBox }> {
  if (!payload.text || !shouldEncrypt(payload.workspaceId)) return payload;
  requireUnlocked(payload.workspaceId);
  const encryptedText = await encryptRoomJson<EncryptedBoundaryPayload>(
    payload.workspaceId,
    BOUNDARY_TEXT_PURPOSE,
    { text: payload.text },
  );
  return {
    ...payload,
    text: ROOM_E2EE_PLACEHOLDER,
    encryptedText,
  };
}

export async function prepareKinkTextPayload<T extends {
  workspaceId: string;
  text: string;
  tags?: string[];
}>(payload: T): Promise<T & { encryptedText?: RoomEncryptedBox }> {
  if (!shouldEncrypt(payload.workspaceId)) return payload;
  requireUnlocked(payload.workspaceId);
  const encryptedText = await encryptRoomJson<EncryptedTextPayload>(
    payload.workspaceId,
    KINK_TEXT_PURPOSE,
    { text: payload.text, tags: payload.tags },
  );
  return {
    ...payload,
    text: ROOM_E2EE_PLACEHOLDER,
    ...(Object.prototype.hasOwnProperty.call(payload, "tags") ? { tags: [] } : {}),
    encryptedText,
  };
}

export async function prepareKinkCommentPayload<T extends {
  workspaceId: string;
  comment: string;
}>(payload: T): Promise<T & { encryptedComment?: RoomEncryptedBox }> {
  if (!shouldEncrypt(payload.workspaceId)) return payload;
  requireUnlocked(payload.workspaceId);
  const encryptedComment = await encryptRoomJson<EncryptedTextPayload>(
    payload.workspaceId,
    KINK_COMMENT_PURPOSE,
    { text: payload.comment },
  );
  return {
    ...payload,
    comment: ROOM_E2EE_PLACEHOLDER,
    encryptedComment,
  };
}

export async function prepareKinkReactionPayload<T extends {
  workspaceId: string;
  note?: string;
}>(payload: T): Promise<T & { encryptedNote?: RoomEncryptedBox }> {
  if (!payload.note || !shouldEncrypt(payload.workspaceId)) return payload;
  requireUnlocked(payload.workspaceId);
  const encryptedNote = await encryptRoomJson<EncryptedReactionNotePayload>(
    payload.workspaceId,
    KINK_REACTION_NOTE_PURPOSE,
    { note: payload.note },
  );
  return {
    ...payload,
    note: "",
    encryptedNote,
  };
}

export async function prepareCreateBlindRevealPayload<T extends {
  workspaceId: string;
  prompt: string;
}>(payload: T): Promise<T & { encryptedPrompt?: RoomEncryptedBox }> {
  if (!shouldEncrypt(payload.workspaceId)) return payload;
  requireUnlocked(payload.workspaceId);
  const encryptedPrompt = await encryptRoomJson<EncryptedPromptPayload>(
    payload.workspaceId,
    BLIND_REVEAL_PROMPT_PURPOSE,
    { prompt: payload.prompt },
  );
  return {
    ...payload,
    prompt: ROOM_E2EE_PLACEHOLDER,
    encryptedPrompt,
  };
}

export async function prepareSubmitBlindRevealPayload<T extends {
  workspaceId: string;
  text: string;
}>(payload: T): Promise<T & { encryptedText?: RoomEncryptedBox }> {
  if (!shouldEncrypt(payload.workspaceId)) return payload;
  requireUnlocked(payload.workspaceId);
  const encryptedText = await encryptRoomJson<EncryptedEntryPayload>(
    payload.workspaceId,
    BLIND_REVEAL_ENTRY_PURPOSE,
    { text: payload.text },
  );
  return {
    ...payload,
    text: ROOM_E2EE_PLACEHOLDER,
    encryptedText,
  };
}

export async function prepareShelfItemPayload<T extends {
  workspaceId: string;
  content: string;
  title?: string;
}>(payload: T): Promise<T & { encryptedContent?: RoomEncryptedBox; encryptedTitle?: RoomEncryptedBox }> {
  if (!shouldEncrypt(payload.workspaceId)) return payload;
  requireUnlocked(payload.workspaceId);
  const encryptedContent = await encryptRoomJson<EncryptedShelfContentPayload>(
    payload.workspaceId,
    SHELF_CONTENT_PURPOSE,
    { content: payload.content },
  );
  const encryptedTitle = payload.title
    ? await encryptRoomJson<EncryptedShelfTitlePayload>(
      payload.workspaceId,
      SHELF_TITLE_PURPOSE,
      { title: payload.title },
    )
    : undefined;
  return {
    ...payload,
    content: ROOM_E2EE_PLACEHOLDER,
    title: encryptedTitle ? ROOM_E2EE_PLACEHOLDER : "",
    encryptedContent,
    ...(encryptedTitle ? { encryptedTitle } : {}),
  };
}

export async function prepareShelfTitlePayload<T extends {
  workspaceId: string;
  title: string;
}>(payload: T): Promise<T & { encryptedTitle?: RoomEncryptedBox }> {
  if (!shouldEncrypt(payload.workspaceId)) return payload;
  requireUnlocked(payload.workspaceId);
  if (!payload.title) return payload;
  const encryptedTitle = await encryptRoomJson<EncryptedShelfTitlePayload>(
    payload.workspaceId,
    SHELF_TITLE_PURPOSE,
    { title: payload.title },
  );
  return {
    ...payload,
    title: ROOM_E2EE_PLACEHOLDER,
    encryptedTitle,
  };
}

export async function prepareActPayload<T extends {
  workspaceId: string;
  label?: string;
  tags?: string[];
}>(payload: T): Promise<T & { encryptedPayload?: RoomEncryptedBox }> {
  if (!payload.label || !shouldEncrypt(payload.workspaceId)) return payload;
  requireUnlocked(payload.workspaceId);
  const encryptedPayload = await encryptRoomJson<EncryptedActPayload>(
    payload.workspaceId,
    ACT_PAYLOAD_PURPOSE,
    { label: payload.label, tags: payload.tags || [] },
  );
  return {
    ...payload,
    label: ROOM_E2EE_PLACEHOLDER,
    ...(Object.prototype.hasOwnProperty.call(payload, "tags") ? { tags: [] } : {}),
    encryptedPayload,
  };
}

function normalizedPileLabel(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function pileLabelToken(workspaceId: string, label: string) {
  return createRoomBlindIndex(workspaceId, PILE_LABEL_PURPOSE, normalizedPileLabel(label));
}

export async function preparePileDropPayload<T extends {
  workspaceId: string;
  label: string;
}>(payload: T): Promise<T & { labelToken?: string; encryptedLabel?: RoomEncryptedBox }> {
  if (!shouldEncrypt(payload.workspaceId)) return payload;
  requireUnlocked(payload.workspaceId);
  const labelToken = await pileLabelToken(payload.workspaceId, payload.label);
  const encryptedLabel = await encryptRoomJson<EncryptedPileLabelPayload>(
    payload.workspaceId,
    PILE_LABEL_PURPOSE,
    { label: payload.label },
  );
  return {
    ...payload,
    label: ROOM_E2EE_PLACEHOLDER,
    labelToken,
    encryptedLabel,
  };
}

export async function preparePileUndropPayload<T extends {
  workspaceId: string;
  label: string;
}>(payload: T): Promise<T & { labelToken?: string }> {
  if (!shouldEncrypt(payload.workspaceId)) return payload;
  requireUnlocked(payload.workspaceId);
  return {
    ...payload,
    label: ROOM_E2EE_PLACEHOLDER,
    labelToken: await pileLabelToken(payload.workspaceId, payload.label),
  };
}

async function decryptRequestRecord(record: RequestRecord, workspaceId: string): Promise<RequestRecord> {
  const encryptedPayload = (record as unknown as JsonRecord).encryptedPayload;
  const encryptedReply = (record as unknown as JsonRecord).encryptedReply;
  let next = { ...record };
  let locked = false;

  if (isRoomEncryptedBox(encryptedPayload)) {
    const decrypted = await tryDecryptRoomJson<EncryptedRequestPayload>(
      workspaceId,
      REQUEST_PAYLOAD_PURPOSE,
      encryptedPayload,
    );
    if (decrypted.ok && decrypted.value) {
      next = {
        ...next,
        categories: cleanArray(decrypted.value.categories),
        timing: decrypted.value.timing || next.timing,
        filming: decrypted.value.filming || next.filming,
        note: decrypted.value.note || "",
        boundaryConflicts: cleanArray(decrypted.value.boundaryConflicts),
      };
    } else {
      locked = true;
    }
  }

  if (isRoomEncryptedBox(encryptedReply)) {
    const decrypted = await tryDecryptRoomJson<EncryptedReplyPayload>(
      workspaceId,
      REQUEST_REPLY_PURPOSE,
      encryptedReply,
    );
    if (decrypted.ok && decrypted.value) {
      const decisions = Array.isArray(decrypted.value.decisions) ? decrypted.value.decisions : [];
      next = applyAcceptedCounterState({
        ...next,
        decisions,
        counters: decisions.filter((item) => item.counter || item.counterActId),
        feedback: decrypted.value.note || "",
      }, decisions);
    } else {
      locked = true;
    }
  }

  return locked ? lockedRequest(next) : next;
}

async function decryptRequestList(records: RequestRecord[] = [], workspaceId: string) {
  return Promise.all(records.map((record) => decryptRequestRecord(record, workspaceId || record.workspaceId)));
}

export async function decryptRequestBoardResponse<T extends RequestBoardResponse>(response: T): Promise<T> {
  const workspaceId = response.workspaceId || "";
  const requests = await decryptRequestList(response.requests, workspaceId);
  const activeRequests = await decryptRequestList(response.activeRequests, workspaceId);
  const history = await decryptRequestList(response.history, workspaceId);
  const request = (response as unknown as { request?: RequestRecord }).request;
  return {
    ...response,
    ...(request ? { request: await decryptRequestRecord(request, workspaceId || request.workspaceId) } : {}),
    requests,
    activeRequests,
    history,
  };
}

async function decryptBoundary(boundary: Boundary, workspaceId: string): Promise<Boundary> {
  const encryptedText = (boundary as unknown as JsonRecord).encryptedText;
  if (!isRoomEncryptedBox(encryptedText)) return boundary;
  const decrypted = await tryDecryptRoomJson<EncryptedBoundaryPayload>(
    workspaceId,
    BOUNDARY_TEXT_PURPOSE,
    encryptedText,
  );
  if (decrypted.ok && decrypted.value?.text) {
    return { ...boundary, text: decrypted.value.text };
  }
  return lockedBoundary(boundary);
}

export async function decryptBoundariesResponse<T extends BoundariesResponse>(response: T): Promise<T> {
  const workspaceId = response.workspaceId || "";
  const boundary = (response as unknown as { boundary?: Boundary }).boundary;
  return {
    ...response,
    ...(boundary ? { boundary: await decryptBoundary(boundary, workspaceId || boundary.workspaceId) } : {}),
    boundaries: await Promise.all((response.boundaries || []).map((item) => decryptBoundary(item, workspaceId))),
  };
}

async function decryptKinkComment(comment: KinkComment, workspaceId: string): Promise<KinkComment> {
  const encryptedText = (comment as unknown as JsonRecord).encryptedText;
  if (!isRoomEncryptedBox(encryptedText)) return comment;
  const decrypted = await tryDecryptRoomJson<EncryptedTextPayload>(
    workspaceId,
    KINK_COMMENT_PURPOSE,
    encryptedText,
  );
  if (decrypted.ok && decrypted.value?.text) {
    return { ...comment, text: decrypted.value.text };
  }
  return lockedComment(comment);
}

async function decryptKinkReaction(reaction: KinkReaction, workspaceId: string): Promise<KinkReaction> {
  const encryptedNote = (reaction as unknown as JsonRecord).encryptedNote;
  if (!isRoomEncryptedBox(encryptedNote)) return reaction;
  const decrypted = await tryDecryptRoomJson<EncryptedReactionNotePayload>(
    workspaceId,
    KINK_REACTION_NOTE_PURPOSE,
    encryptedNote,
  );
  if (decrypted.ok && decrypted.value) {
    return { ...reaction, note: decrypted.value.note || "" };
  }
  return { ...reaction, note: ROOM_E2EE_LOCKED_LABEL };
}

async function decryptKinkIdea(idea: KinkIdea, workspaceId: string): Promise<KinkIdea> {
  const encryptedText = (idea as unknown as JsonRecord).encryptedText;
  let next: KinkIdea = { ...idea };
  let locked = false;

  if (isRoomEncryptedBox(encryptedText)) {
    const decrypted = await tryDecryptRoomJson<EncryptedTextPayload>(
      workspaceId,
      KINK_TEXT_PURPOSE,
      encryptedText,
    );
    if (decrypted.ok && decrypted.value?.text) {
      next.text = decrypted.value.text;
      if (Array.isArray(decrypted.value.tags)) next.tags = decrypted.value.tags;
    } else {
      locked = true;
    }
  }

  next = {
    ...next,
    comments: await Promise.all((next.comments || []).map((comment) => decryptKinkComment(comment, workspaceId))),
    reactions: await Promise.all((next.reactions || []).map((reaction) => decryptKinkReaction(reaction, workspaceId))),
  };

  return locked ? lockedKink(next) : next;
}

async function decryptKinkList(ideas: KinkIdea[] = [], workspaceId: string) {
  return Promise.all(ideas.map((idea) => decryptKinkIdea(idea, workspaceId || idea.workspaceId)));
}

export async function decryptFantasyBacklogResponse<T extends FantasyBacklogResponse>(response: T): Promise<T> {
  if (!response) return response;
  const workspaceId = response.workspaceId || "";
  const idea = (response as unknown as { idea?: KinkIdea }).idea;
  return {
    ...response,
    ...(idea ? { idea: await decryptKinkIdea(idea, workspaceId || idea.workspaceId) } : {}),
    ideas: await decryptKinkList(response.ideas, workspaceId),
    graveyard: await decryptKinkList(response.graveyard, workspaceId),
  };
}

async function decryptBlindRevealEntry(entry: BlindRevealEntry, workspaceId: string): Promise<BlindRevealEntry> {
  const encryptedText = (entry as unknown as JsonRecord).encryptedText;
  if (!isRoomEncryptedBox(encryptedText)) return entry;
  const decrypted = await tryDecryptRoomJson<EncryptedEntryPayload>(
    workspaceId,
    BLIND_REVEAL_ENTRY_PURPOSE,
    encryptedText,
  );
  if (decrypted.ok && decrypted.value?.text) {
    return { ...entry, text: decrypted.value.text };
  }
  return lockedBlindRevealEntry(entry);
}

async function decryptBlindReveal(reveal: BlindReveal, workspaceId: string): Promise<BlindReveal> {
  const encryptedPrompt = (reveal as unknown as JsonRecord).encryptedPrompt;
  let next: BlindReveal = { ...reveal };
  let promptLocked = false;

  if (isRoomEncryptedBox(encryptedPrompt)) {
    const decrypted = await tryDecryptRoomJson<EncryptedPromptPayload>(
      workspaceId,
      BLIND_REVEAL_PROMPT_PURPOSE,
      encryptedPrompt,
    );
    if (decrypted.ok && decrypted.value?.prompt) {
      next.prompt = decrypted.value.prompt;
    } else {
      next.prompt = ROOM_E2EE_LOCKED_LABEL;
      promptLocked = true;
    }
  }

  return {
    ...next,
    myEntry: next.myEntry ? await decryptBlindRevealEntry(next.myEntry, workspaceId) : null,
    entries: await Promise.all((next.entries || []).map((entry) => decryptBlindRevealEntry(entry, workspaceId))),
    ...(promptLocked ? { e2eeLocked: true } : {}),
  } as BlindReveal;
}

async function decryptBlindRevealList(reveals: BlindReveal[] = [], workspaceId: string) {
  return Promise.all(reveals.map((reveal) => decryptBlindReveal(reveal, workspaceId || reveal.workspaceId)));
}

export async function decryptBlindRevealResponse<T extends BlindRevealResponse>(response: T): Promise<T> {
  if (!response) return response;
  const workspaceId = response.workspaceId || "";
  return {
    ...response,
    activeReveal: response.activeReveal ? await decryptBlindReveal(response.activeReveal, workspaceId) : null,
    ...(response.reveal ? { reveal: await decryptBlindReveal(response.reveal, workspaceId || response.reveal.workspaceId) } : {}),
    ...(response.reveals ? { reveals: await decryptBlindRevealList(response.reveals, workspaceId) } : {}),
    ...(response.idea ? { idea: await decryptKinkIdea(response.idea, workspaceId || response.idea.workspaceId) } : {}),
  };
}

async function decryptShelfItem(item: ShelfItem, workspaceId: string): Promise<ShelfItem> {
  const encryptedContent = (item as unknown as JsonRecord).encryptedContent;
  const encryptedTitle = (item as unknown as JsonRecord).encryptedTitle;
  let next: ShelfItem = { ...item };
  let locked = false;

  if (isRoomEncryptedBox(encryptedContent)) {
    const decrypted = await tryDecryptRoomJson<EncryptedShelfContentPayload>(
      workspaceId,
      SHELF_CONTENT_PURPOSE,
      encryptedContent,
    );
    if (decrypted.ok && decrypted.value?.content) {
      const content = decrypted.value.content;
      if (shelfContentLooksLikeUrl(content)) {
        const redgifs = redgifsShelfFromUrl(content);
        next = redgifs
          ? {
              ...next,
              type: "gif",
              source: "redgifs",
              sourceId: redgifs.sourceId,
              sourceUrl: redgifs.sourceUrl,
              embedUrl: next.embedUrl || redgifs.embedUrl,
              posterUrl: next.posterUrl || redgifs.posterUrl,
              videoHdUrl: next.videoHdUrl || redgifs.videoHdUrl,
              passageText: "",
              sourceLabel: "REDGIFS",
            }
          : {
              ...next,
              type: next.type === "encrypted" ? "story" : next.type,
              source: next.source || shelfSourceForUrl(content) || null,
              sourceUrl: content,
              passageText: "",
              sourceLabel: next.type === "encrypted" ? shelfSourceLabelForUrl(content) : next.sourceLabel || shelfSourceLabelForUrl(content),
            };
      } else {
        next = {
          ...next,
          type: next.type === "encrypted" ? "passage" : next.type,
          sourceUrl: "",
          passageText: content,
          sourceLabel: next.type === "encrypted" ? "Passage" : next.sourceLabel || "Passage",
        };
      }
    } else {
      locked = true;
    }
  }

  if (isRoomEncryptedBox(encryptedTitle)) {
    const decrypted = await tryDecryptRoomJson<EncryptedShelfTitlePayload>(
      workspaceId,
      SHELF_TITLE_PURPOSE,
      encryptedTitle,
    );
    if (decrypted.ok && decrypted.value) {
      next.title = decrypted.value.title || "";
    } else {
      next.title = ROOM_E2EE_LOCKED_LABEL;
      locked = true;
    }
  }

  return locked ? lockedShelfItem(next) : next;
}

async function decryptShelfItems(items: ShelfItem[] = [], workspaceId: string) {
  return Promise.all(items.map((item) => decryptShelfItem(item, workspaceId)));
}

export async function decryptShelfResponse<T extends ShelfResponse>(response: T, fallbackWorkspaceId = ""): Promise<T> {
  if (!response) return response;
  const workspaceId = response.workspaceId || fallbackWorkspaceId;
  const item = response.item;
  return {
    ...response,
    ...(item ? { item: await decryptShelfItem(item, workspaceId || item.id) } : {}),
    items: await decryptShelfItems(response.items || [], workspaceId),
  };
}

async function decryptAct(act: Act, workspaceId: string): Promise<Act> {
  const encryptedPayload = (act as unknown as JsonRecord).encryptedPayload;
  if (!isRoomEncryptedBox(encryptedPayload)) return act;
  const decrypted = await tryDecryptRoomJson<EncryptedActPayload>(
    workspaceId,
    ACT_PAYLOAD_PURPOSE,
    encryptedPayload,
  );
  if (decrypted.ok && decrypted.value?.label) {
    return {
      ...act,
      label: decrypted.value.label,
      tags: Array.isArray(decrypted.value.tags) ? decrypted.value.tags : [],
    };
  }
  return lockedAct(act);
}

async function decryptActList(acts: Act[] = [], workspaceId: string) {
  return Promise.all(acts.map((act) => decryptAct(act, workspaceId || act.workspaceId)));
}

export async function decryptActsResponse<T extends ActsResponse>(response: T): Promise<T> {
  if (!response) return response;
  const workspaceId = response.workspaceId || "";
  const act = (response as unknown as { act?: Act }).act;
  return {
    ...response,
    ...(act ? { act: await decryptAct(act, workspaceId || act.workspaceId) } : {}),
    acts: await decryptActList(response.acts, workspaceId),
  };
}

function encryptedLabelForToken(entries: PileEncryptedLabel[] = [], token: string) {
  return entries.find((entry) => entry.token === token) || null;
}

async function decryptPileLabelEntry(entry: PileEncryptedLabel, workspaceId: string): Promise<string> {
  if (!entry || !isRoomEncryptedBox(entry.encryptedLabel)) return ROOM_E2EE_LOCKED_LABEL;
  const decrypted = await tryDecryptRoomJson<EncryptedPileLabelPayload>(
    workspaceId,
    PILE_LABEL_PURPOSE,
    entry.encryptedLabel,
  );
  return decrypted.ok && decrypted.value?.label ? decrypted.value.label : ROOM_E2EE_LOCKED_LABEL;
}

async function decryptPileLabelEntries(entries: PileEncryptedLabel[] = [], workspaceId: string) {
  return Promise.all(entries.map((entry) => decryptPileLabelEntry(entry, workspaceId)));
}

async function decryptPileLabelTokens(
  tokens: string[] = [],
  entries: PileEncryptedLabel[] = [],
  workspaceId: string,
) {
  const labels: string[] = [];
  for (const token of tokens) {
    const entry = encryptedLabelForToken(entries, token);
    labels.push(entry ? await decryptPileLabelEntry(entry, workspaceId) : ROOM_E2EE_LOCKED_LABEL);
  }
  return labels;
}

async function decryptPileView(pile: PileView, workspaceId: string): Promise<PileView> {
  if (!pile) return pile;
  const encryptedMine = pile.encryptedMine || [];
  const encryptedPartnerLabels = pile.encryptedPartnerLabels || {};
  const encryptedPartnerEntries = Object.entries(encryptedPartnerLabels);
  const anyEncrypted = encryptedMine.length
    || encryptedPartnerEntries.length
    || (pile.encryptedOverlap || []).length
    || (pile.encryptedOnlyMine || []).length
    || (pile.encryptedOnlyTheirs || []).length;
  if (!anyEncrypted) return pile;

  const partnerLabels: Record<string, string[]> = {};
  for (const [email, entries] of encryptedPartnerEntries) {
    partnerLabels[email] = await decryptPileLabelEntries(entries, workspaceId);
  }

  return {
    ...pile,
    mine: await decryptPileLabelEntries(encryptedMine, workspaceId),
    partnerLabels: Object.keys(partnerLabels).length ? partnerLabels : pile.partnerLabels,
    overlap: pile.overlap
      ? await decryptPileLabelTokens(pile.overlap, pile.encryptedOverlap || encryptedMine, workspaceId)
      : pile.overlap,
    onlyMine: pile.onlyMine
      ? await decryptPileLabelTokens(pile.onlyMine, pile.encryptedOnlyMine || encryptedMine, workspaceId)
      : pile.onlyMine,
    onlyTheirs: pile.onlyTheirs
      ? await decryptPileLabelTokens(
        pile.onlyTheirs,
        pile.encryptedOnlyTheirs || encryptedPartnerEntries.flatMap(([, entries]) => entries),
        workspaceId,
      )
      : pile.onlyTheirs,
  };
}

async function decryptPileSession(session: PileSession, workspaceId: string): Promise<PileSession> {
  if (!session?.encryptedActs?.length && !session?.encryptedOverlap?.length) return session;
  return {
    ...session,
    acts: session.encryptedActs?.length
      ? await decryptPileLabelEntries(session.encryptedActs, workspaceId)
      : session.acts,
    overlap: session.encryptedOverlap?.length
      ? await decryptPileLabelEntries(session.encryptedOverlap, workspaceId)
      : session.overlap,
  };
}

export async function decryptPileResponse<T extends PileResponse>(response: T, fallbackWorkspaceId = ""): Promise<T> {
  if (!response) return response;
  const workspaceId = fallbackWorkspaceId || response.session?.workspaceId || "";
  return {
    ...response,
    pile: response.pile ? await decryptPileView(response.pile, workspaceId) : null,
    ...(response.session ? { session: await decryptPileSession(response.session, workspaceId) } : {}),
    ...(response.sessions ? {
      sessions: await Promise.all(response.sessions.map((session) => decryptPileSession(session, workspaceId || session.workspaceId))),
    } : {}),
  };
}

export async function decryptReviewTokenResolveResponse<T extends ReviewTokenResolveResponse>(response: T): Promise<T> {
  const workspaceId = response.workspace?.id || response.request?.workspaceId || "";
  return {
    ...response,
    request: await decryptRequestRecord(response.request as unknown as RequestRecord, workspaceId) as unknown as T["request"],
  };
}

export async function decryptReviewTokenSubmitResponse<T extends ReviewTokenSubmitResponse>(response: T, workspaceId = ""): Promise<T> {
  if (!response.request) return response;
  return {
    ...response,
    request: await decryptRequestRecord(response.request as unknown as RequestRecord, workspaceId || response.request.workspaceId) as unknown as T["request"],
  };
}

export async function decryptBootstrapResponse(response: BootstrapResponse): Promise<BootstrapResponse> {
  if (!response.bootstrap) return response;
  const workspaceId = response.bootstrap.workspaceId || response.activeWorkspaceId || "";
  return {
    ...response,
    bootstrap: {
      ...response.bootstrap,
      requests: await decryptRequestBoardResponse(response.bootstrap.requests),
      fantasy: response.bootstrap.fantasy
        ? await decryptFantasyBacklogResponse(response.bootstrap.fantasy)
        : response.bootstrap.fantasy,
      boundaries: await decryptBoundariesResponse({
        ...response.bootstrap.boundaries,
        workspaceId: response.bootstrap.boundaries?.workspaceId || workspaceId,
      }),
      acts: await decryptActsResponse({
        ...response.bootstrap.acts,
        workspaceId: response.bootstrap.acts?.workspaceId || workspaceId,
      }),
    },
  };
}

export async function decryptSexboardResponse(response: SexboardResponse): Promise<SexboardResponse> {
  if (!response.sexboard) return response;
  const workspaceId = response.sexboard.workspaceId || response.activeWorkspaceId || "";
  return {
    ...response,
    sexboard: {
      ...response.sexboard,
      board: await decryptRequestBoardResponse(response.sexboard.board),
      pile: response.sexboard.pile
        ? (await decryptPileResponse({ pile: response.sexboard.pile }, workspaceId)).pile
        : null,
      pileSessions: (await decryptPileResponse({ pile: null, sessions: response.sexboard.pileSessions }, workspaceId)).sessions || [],
      blindReveal: response.sexboard.blindReveal
        ? await decryptBlindReveal(response.sexboard.blindReveal, workspaceId)
        : null,
      blindReveals: await decryptBlindRevealList(response.sexboard.blindReveals, workspaceId),
      fantasy: await decryptFantasyBacklogResponse(response.sexboard.fantasy),
    },
  };
}
