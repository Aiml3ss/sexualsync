// Same-device autosave for the long questionnaire runners (Sex Quiz, Green
// Lights). localStorage only — NO server writes: these decks run to 70–140
// cards, and Cloudflare KV is write-limited (the app's known scaling
// constraint), so persisting every answer server-side would hammer it. This
// lets you get interrupted and pick up where you left off on the same device;
// cleared on submit. Cross-device resume would be a later, write-throttled
// server draft.

const PREFIX = "ss:runnerdraft:";

function draftKey(feature: string, workspaceId: string): string {
  return `${PREFIX}${feature}:${workspaceId}`;
}

export function loadRunnerDraft<T>(feature: string, workspaceId: string): T | null {
  if (typeof window === "undefined" || !workspaceId) return null;
  try {
    const raw = window.localStorage.getItem(draftKey(feature, workspaceId));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveRunnerDraft(feature: string, workspaceId: string, value: unknown): void {
  if (typeof window === "undefined" || !workspaceId) return;
  try {
    window.localStorage.setItem(draftKey(feature, workspaceId), JSON.stringify(value));
  } catch {
    // Quota / private mode — autosave is best-effort.
  }
}

export function clearRunnerDraft(feature: string, workspaceId: string): void {
  if (typeof window === "undefined" || !workspaceId) return;
  try {
    window.localStorage.removeItem(draftKey(feature, workspaceId));
  } catch {
    // ignore
  }
}
