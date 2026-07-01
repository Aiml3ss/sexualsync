import {
  getActs,
  getBlindReveal,
  getBoundaries,
  getE2eeStatus,
  getFantasyBacklog,
  getPile,
  getRequestBoard,
  getShelf,
  reencryptE2eeSurface,
} from "./api";
import {
  prepareActPayload,
  prepareBoundaryPayload,
  prepareCreateBlindRevealPayload,
  prepareCreateRequestPayload,
  prepareKinkCommentPayload,
  prepareKinkReactionPayload,
  prepareKinkTextPayload,
  preparePileDropPayload,
  prepareReplyPayload,
  prepareShelfItemPayload,
  prepareShelfTitlePayload,
  prepareSubmitBlindRevealPayload,
} from "./room-record-crypto";
import {
  ROOM_E2EE_LOCKED_LABEL,
  ROOM_E2EE_PLACEHOLDER,
  hasUnlockedRoomE2eeKey,
  isRoomEncryptedBox,
} from "./room-crypto";
import type {
  BlindReveal,
  DecisionItem,
  E2eeMigrationSurface,
  E2eeStatusResponse,
  KinkIdea,
  PileEncryptedLabel,
  RequestRecord,
  RoomEncryptedBox,
  ShelfItem,
} from "./types";

export interface ReencryptProgress {
  phase: string;
  migrated: number;
  remaining?: number;
}

export interface ReencryptResult {
  migrated: number;
  remaining: number;
  skipped: string[];
  status: E2eeStatusResponse;
}

interface RunOptions {
  workspaceId: string;
  actorEmail: string;
  activeMemberEmails: string[];
  onProgress?: (progress: ReencryptProgress) => void;
}

const PLACEHOLDERS = new Set([
  ROOM_E2EE_PLACEHOLDER,
  ROOM_E2EE_LOCKED_LABEL,
  "Encrypted content",
  "Encrypted ask",
  "Encrypted answer",
  "Encrypted prompt",
  "Encrypted act",
  "Encrypted comment",
  "Encrypted kink",
  "Encrypted limit",
  "Encrypted pile match",
  "Encrypted shelf item",
  "Encrypted title",
]);

function normalizeEmail(value: string) {
  return String(value || "").trim().toLowerCase();
}

function meaningfulText(value: unknown) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return Boolean(text && !PLACEHOLDERS.has(text));
}

function meaningfulList(value: unknown) {
  return Array.isArray(value) && value.some((entry) => meaningfulText(entry));
}

function encrypted(value: unknown): value is RoomEncryptedBox {
  return isRoomEncryptedBox(value);
}

function hasReplyPlaintext(request: RequestRecord) {
  if (request.decisions?.length) return true;
  if (request.counters?.length) return true;
  return meaningfulText(request.feedback) || meaningfulText(request.matchNarration) || meaningfulText(request.reviewSummary);
}

function decisionList(request: RequestRecord): Array<Partial<DecisionItem>> {
  const decisions = request.decisions?.length ? request.decisions : request.counters || [];
  return decisions.map((item) => ({
    label: meaningfulText(item.label) ? item.label : "",
    decision: item.decision || "",
    counter: meaningfulText(item.counter) ? item.counter : "",
    counterActId: item.counterActId || "",
    note: meaningfulText(item.note) ? item.note : "",
    targetType: item.targetType || "act",
    actId: item.actId || "",
  }));
}

async function flush(surface: E2eeMigrationSurface, workspaceId: string, patches: unknown[]) {
  let changed = 0;
  for (let index = 0; index < patches.length; index += 25) {
    const chunk = patches.slice(index, index + 25);
    if (!chunk.length) continue;
    const response = await reencryptE2eeSurface({ workspaceId, surface, patches: chunk });
    changed += response.changed || 0;
  }
  return changed;
}

async function migrateRequests(workspaceId: string) {
  const board = await getRequestBoard(workspaceId);
  const patches = [];
  for (const request of board.requests || []) {
    const patch: Record<string, unknown> = { id: request.id };
    if (!encrypted(request.encryptedPayload) && (
      meaningfulList(request.categories)
      || meaningfulList(request.boundaryConflicts)
      || meaningfulText(request.note)
    )) {
      const body = await prepareCreateRequestPayload({
        workspaceId,
        categories: (request.categories || []).filter(meaningfulText),
        timing: request.timing || "Tonight",
        filming: request.filming || "No",
        note: meaningfulText(request.note) ? request.note : "",
        boundaryConflicts: (request.boundaryConflicts || []).filter(meaningfulText),
      });
      if (body.encryptedPayload) patch.encryptedPayload = body.encryptedPayload;
    }
    if (!encrypted(request.encryptedReply) && hasReplyPlaintext(request)) {
      const body = await prepareReplyPayload({
        workspaceId,
        decisions: decisionList(request),
        note: meaningfulText(request.feedback) ? request.feedback : "",
      });
      if (body.encryptedReply) patch.encryptedReply = body.encryptedReply;
    }
    if (patch.encryptedPayload || patch.encryptedReply) patches.push(patch);
  }
  return flush("request-board", workspaceId, patches);
}

async function migrateBoundaries(workspaceId: string) {
  const response = await getBoundaries(workspaceId);
  const patches = [];
  for (const boundary of response.boundaries || []) {
    if (encrypted(boundary.encryptedText) || !meaningfulText(boundary.text)) continue;
    const body = await prepareBoundaryPayload({
      workspaceId,
      text: boundary.text,
      type: boundary.type,
    });
    if (body.encryptedText) patches.push({ id: boundary.id, encryptedText: body.encryptedText });
  }
  return flush("boundaries", workspaceId, patches);
}

async function migrateActs(workspaceId: string) {
  const response = await getActs(workspaceId);
  const patches = [];
  for (const act of response.acts || []) {
    if (encrypted(act.encryptedPayload) || !meaningfulText(act.label)) continue;
    const body = await prepareActPayload({
      workspaceId,
      label: act.label,
      tags: act.tags || [],
    });
    if (body.encryptedPayload) patches.push({ id: act.id, encryptedPayload: body.encryptedPayload });
  }
  return flush("approved-acts", workspaceId, patches);
}

async function kinkPatch(workspaceId: string, idea: KinkIdea) {
  const patch: Record<string, unknown> = { id: idea.id };
  if (!encrypted(idea.encryptedText) && meaningfulText(idea.text)) {
    const body = await prepareKinkTextPayload({
      workspaceId,
      text: idea.text,
      tags: idea.tags || [],
    });
    if (body.encryptedText) patch.encryptedText = body.encryptedText;
  }
  const comments = [];
  for (let index = 0; index < (idea.comments || []).length; index += 1) {
    const comment = idea.comments[index];
    if (encrypted(comment.encryptedText) || !meaningfulText(comment.text)) continue;
    const body = await prepareKinkCommentPayload({ workspaceId, comment: comment.text });
    if (body.encryptedComment) {
      comments.push({ id: comment.id, index, encryptedText: body.encryptedComment });
    }
  }
  if (comments.length) patch.comments = comments;

  const reactions = [];
  for (let index = 0; index < (idea.reactions || []).length; index += 1) {
    const reaction = idea.reactions[index];
    if (encrypted(reaction.encryptedNote) || !meaningfulText(reaction.note)) continue;
    const body = await prepareKinkReactionPayload({ workspaceId, note: reaction.note });
    if (body.encryptedNote) {
      reactions.push({
        index,
        by: reaction.by,
        createdAt: reaction.createdAt,
        encryptedNote: body.encryptedNote,
      });
    }
  }
  if (reactions.length) patch.reactions = reactions;
  return patch.encryptedText || comments.length || reactions.length ? patch : null;
}

async function migrateFantasy(workspaceId: string) {
  const response = await getFantasyBacklog(workspaceId);
  const patches = [];
  for (const idea of [...(response.ideas || []), ...(response.graveyard || [])]) {
    const patch = await kinkPatch(workspaceId, idea);
    if (patch) patches.push(patch);
  }
  return flush("fantasy-backlog", workspaceId, patches);
}

function uniqueReveals(reveals: Array<BlindReveal | null | undefined>) {
  const map = new Map<string, BlindReveal>();
  reveals.forEach((reveal) => {
    if (reveal?.id) map.set(reveal.id, reveal);
  });
  return [...map.values()];
}

async function migrateBlindReveals(workspaceId: string) {
  const response = await getBlindReveal(workspaceId);
  const patches = [];
  for (const reveal of uniqueReveals([response.activeReveal, response.reveal, ...(response.reveals || [])])) {
    const patch: Record<string, unknown> = { id: reveal.id };
    if (!encrypted(reveal.encryptedPrompt) && meaningfulText(reveal.prompt)) {
      const body = await prepareCreateBlindRevealPayload({ workspaceId, prompt: reveal.prompt });
      if (body.encryptedPrompt) patch.encryptedPrompt = body.encryptedPrompt;
    }
    const entries = [];
    const visibleEntries = [...(reveal.entries || [])];
    if (reveal.myEntry && !visibleEntries.some((entry) => normalizeEmail(entry.email) === normalizeEmail(reveal.myEntry?.email || ""))) {
      visibleEntries.push(reveal.myEntry);
    }
    for (const entry of visibleEntries) {
      if (encrypted(entry.encryptedText) || !meaningfulText(entry.text)) continue;
      const body = await prepareSubmitBlindRevealPayload({ workspaceId, text: entry.text });
      if (body.encryptedText) entries.push({ email: entry.email, encryptedText: body.encryptedText });
    }
    if (entries.length) patch.entries = entries;
    if (patch.encryptedPrompt || entries.length) patches.push(patch);
  }
  return flush("blind-reveals", workspaceId, patches);
}

function shelfContent(item: ShelfItem) {
  if (meaningfulText(item.passageText)) return item.passageText;
  if (meaningfulText(item.sourceUrl)) return item.sourceUrl;
  if (meaningfulText(item.embedUrl)) return item.embedUrl;
  return "";
}

async function migrateShelf(workspaceId: string) {
  const response = await getShelf(workspaceId);
  const patches = [];
  for (const item of response.items || []) {
    const patch: Record<string, unknown> = { id: item.id };
    const content = shelfContent(item);
    if (!encrypted(item.encryptedContent) && meaningfulText(content)) {
      const body = await prepareShelfItemPayload({
        workspaceId,
        content,
        title: "",
      });
      if (body.encryptedContent) patch.encryptedContent = body.encryptedContent;
    }
    if (!encrypted(item.encryptedTitle) && meaningfulText(item.title)) {
      const body = await prepareShelfTitlePayload({ workspaceId, title: item.title });
      if (body.encryptedTitle) patch.encryptedTitle = body.encryptedTitle;
    }
    if (patch.encryptedContent || patch.encryptedTitle) patches.push(patch);
  }
  return flush("shelf", workspaceId, patches);
}

async function encryptedPileEntries(workspaceId: string, labels: string[]) {
  const entries: PileEncryptedLabel[] = [];
  for (const label of labels.filter(meaningfulText)) {
    const body = await preparePileDropPayload({ workspaceId, label });
    if (body.labelToken && body.encryptedLabel) {
      entries.push({ token: body.labelToken, encryptedLabel: body.encryptedLabel });
    }
  }
  return entries;
}

async function migratePile(workspaceId: string, actorEmail: string, activeMemberEmails: string[]) {
  const response = await getPile(workspaceId);
  const skipped: string[] = [];
  let changed = 0;

  if (response.sessions?.length) {
    const patches = [];
    for (const session of response.sessions) {
      if (session.encryptedActs?.length || !meaningfulList(session.acts)) continue;
      const encryptedActs = await encryptedPileEntries(workspaceId, session.acts || []);
      const overlapLabels = session.overlap?.length ? session.overlap : session.acts || [];
      const encryptedOverlap = await encryptedPileEntries(workspaceId, overlapLabels);
      if (encryptedActs.length || encryptedOverlap.length) {
        patches.push({ id: session.id, encryptedActs, encryptedOverlap });
      }
    }
    changed += await flush("pile-sessions", workspaceId, patches);
  }

  const pile = response.pile;
  if (!pile) return { changed, skipped };

  if (!pile.isRevealed) {
    if (meaningfulList(pile.mine)) skipped.push("Active Pile finishes after reveal or both partners migrate.");
    return { changed, skipped };
  }

  const encryptedContributions: Record<string, PileEncryptedLabel[]> = {};
  const actor = normalizeEmail(actorEmail);
  if (actor && meaningfulList(pile.mine)) {
    encryptedContributions[actor] = await encryptedPileEntries(workspaceId, pile.mine);
  }
  for (const [email, labels] of Object.entries(pile.partnerLabels || {})) {
    if (meaningfulList(labels)) encryptedContributions[normalizeEmail(email)] = await encryptedPileEntries(workspaceId, labels);
  }
  const knownEmails = new Set(Object.keys(encryptedContributions));
  const requiredEmails = activeMemberEmails.map(normalizeEmail).filter(Boolean);
  const hasAllVisible = requiredEmails.length === 0 || requiredEmails.every((email) => knownEmails.has(email));
  if (!hasAllVisible) {
    skipped.push("Active Pile has hidden partner labels.");
    return { changed, skipped };
  }
  if (Object.keys(encryptedContributions).length) {
    changed += await flush("pile-active", workspaceId, [{ encryptedContributions }]);
  }
  return { changed, skipped };
}

export async function runRoomReencryptMigration(options: RunOptions): Promise<ReencryptResult> {
  const workspaceId = options.workspaceId;
  if (!workspaceId) throw new Error("Choose a room first.");
  if (!hasUnlockedRoomE2eeKey(workspaceId)) throw new Error("Unlock Room Encryption first.");

  const skipped: string[] = [];
  let migrated = 0;
  const report = (phase: string) => options.onProgress?.({ phase, migrated });

  report("Checking");
  await getE2eeStatus(workspaceId);

  const steps: Array<[string, () => Promise<number>]> = [
    ["Asks", () => migrateRequests(workspaceId)],
    ["Limits", () => migrateBoundaries(workspaceId)],
    ["Acts", () => migrateActs(workspaceId)],
    ["Kinks", () => migrateFantasy(workspaceId)],
    ["Blind Reveal", () => migrateBlindReveals(workspaceId)],
    ["Shelf", () => migrateShelf(workspaceId)],
  ];

  for (const [phase, run] of steps) {
    report(phase);
    migrated += await run();
  }

  report("Pile");
  const pileResult = await migratePile(workspaceId, options.actorEmail, options.activeMemberEmails);
  migrated += pileResult.changed;
  skipped.push(...pileResult.skipped);

  report("Verifying");
  const status = await getE2eeStatus(workspaceId);
  options.onProgress?.({ phase: "Done", migrated, remaining: status.legacyPlaintext.total });
  return {
    migrated,
    remaining: status.legacyPlaintext.total,
    skipped,
    status,
  };
}
