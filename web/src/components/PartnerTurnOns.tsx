"use client";

/**
 * Self-contained "partner's top turn-ons" showcase. Fetches the Sex Quiz for a
 * workspace and renders the partner's pinned picks once the quiz is revealed.
 * Renders nothing otherwise, so it's safe to drop on any authenticated surface
 * (Sexboard, Sext header) without threading data through that page's loader.
 */

import { useEffect, useState } from "react";
import { getSexQuiz } from "@/lib/api";
import TopTurnOns from "./TopTurnOns";

export default function PartnerTurnOns({
  workspaceId,
  variant = "card",
}: {
  workspaceId: string;
  variant?: "card" | "strip";
}) {
  const [picks, setPicks] = useState<string[]>([]);
  const [name, setName] = useState("");

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    getSexQuiz(workspaceId)
      .then((res) => {
        if (cancelled || res.status !== "revealed") return;
        setPicks(res.partnerTopPicks || []);
        setName(res.partnerName || "");
      })
      .catch(() => { /* showcase is best-effort; never blocks the host page */ });
    return () => { cancelled = true; };
  }, [workspaceId]);

  if (!picks.length) return null;
  return <TopTurnOns name={name} cardIds={picks} variant={variant} />;
}
