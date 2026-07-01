import {
  getActs,
  getBoundaries,
  getFantasyBacklog,
  getProfile,
  getRequestBoard,
  getShelf,
  getVault,
} from "@/lib/api";
import { loadPrivateNotes, type PrivateNote } from "@/lib/private-notes";
import type { ProfileResponse, Workspace } from "@/lib/types";

export async function buildWorkspaceExport(profile: ProfileResponse, workspace: Workspace) {
  const workspaceId = workspace.id;
  const [board, boundaries, acts, backlog, shelf, vault] = await Promise.all([
    getRequestBoard(workspaceId),
    getBoundaries(workspaceId),
    getActs(workspaceId),
    getFantasyBacklog(workspaceId),
    getShelf(workspaceId),
    getVault(workspaceId),
  ]);
  // Private notes are encrypted at rest; loadPrivateNotes() decrypts them,
  // folds in any legacy plaintext, and returns [] while the app lock is
  // engaged (so a locked export omits them by design).
  let privateNotes: PrivateNote[] = [];
  try {
    privateNotes = await loadPrivateNotes();
  } catch {}

  return {
    exportedAt: new Date().toISOString(),
    profile: profile.profile,
    workspace,
    requestBoard: board,
    limits: boundaries,
    acts,
    inspiration: backlog,
    shelf,
    vault,
    privateNotes,
  };
}

export function downloadJsonExport(payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `sexualsync-export-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function downloadWorkspaceData(profile: ProfileResponse, workspace: Workspace) {
  const payload = await buildWorkspaceExport(profile, workspace);
  downloadJsonExport(payload);
}

export async function downloadCurrentWorkspaceData() {
  const profile = await getProfile();
  if (!profile.activeWorkspace) {
    throw new Error("No shared space is attached to this account.");
  }
  await downloadWorkspaceData(profile, profile.activeWorkspace);
}
