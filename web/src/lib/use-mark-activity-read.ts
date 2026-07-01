"use client";

import { useEffect } from "react";
import { markActivityRead } from "@/lib/api";
import { publishActivitySummary } from "@/lib/activity";
import type { ActivityResource } from "@/lib/types";

export function useMarkActivityRead({
  workspaceId,
  resource,
  enabled = true,
}: {
  workspaceId: string;
  resource: ActivityResource;
  enabled?: boolean;
}) {
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    let cancelled = false;
    markActivityRead({ workspaceId, resource })
      .then((next) => {
        if (!cancelled) publishActivitySummary(next.unreadByResource || {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, resource, workspaceId]);
}
