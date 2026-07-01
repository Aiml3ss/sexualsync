/**
 * Shared types for the sexboard route. Extracted so the route shell
 * (`page.tsx`) and the body / handoff components (`_sexboard-body.tsx`)
 * can both refer to the same `LoadState` discriminated union and the
 * same `HandoffItem` / `HandoffSummary` shapes without a circular
 * import.
 */

import type {
  ActivityResponse,
  AuthInfo,
  BlindReveal,
  FantasyBacklogResponse,
  GameRoundStatus,
  KinkIdea,
  PendingInvite,
  PileSession,
  PileView,
  PresenceResponse,
  Profile,
  RequestBoardResponse,
  RequestRecord,
  Workspace,
} from "@/lib/types";

export type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "no-workspace"; auth: AuthInfo; pendingInvites: PendingInvite[] }
  | {
      kind: "ready";
      auth: AuthInfo;
      profile: Profile | null;
      workspace: Workspace;
      pendingInvites: PendingInvite[];
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

export type HandoffItem = {
  id: string;
  href: string;
  eyebrow: string;
  title: string;
  body: string;
  action: string;
  tags?: string[];
  tone?: "locked";
  glow?: boolean;
  actionGlow?: boolean;
  removeSessionId?: string;
  dismissOnViewSessionId?: string;
  dismissOnViewRevealId?: string;
};

export type HandoffSummary = {
  ranked: RequestRecord[];
  latestPile?: PileSession;
  latestBlindReveal?: BlindReveal;
  activeGamesCount: number;
  kinksNeedingMe: KinkIdea[];
  kinksWaitingOnPartner: KinkIdea[];
  handoffs: { needsYou: HandoffItem[]; waiting: HandoffItem[]; locked: HandoffItem[] };
  needsCount: number;
  waitingCount: number;
  partnerName: string;
};
