/**
 * Top turn-ons — the curated showcase a partner pins in the Sex Quiz. Shown on
 * the quiz reveal, the Sexboard, and the Sext header as a flirty always-on
 * signal of what they most want. Renders nothing until there's something to
 * show (so it's safe to drop on any surface).
 */

import { QUIZ_CARD_BY_ID } from "@/lib/quiz-deck";

export default function TopTurnOns({
  name,
  cardIds,
  variant = "card",
  ranked = false,
  caption,
}: {
  name: string;
  cardIds: string[];
  variant?: "card" | "strip";
  ranked?: boolean;
  /** Optional warm line under the label — used on the quiz reveal to frame a
   *  partner's picks as desire directed at you ("…craves most — with you"). */
  caption?: string;
}) {
  const cards = (cardIds || []).map((id) => QUIZ_CARD_BY_ID[id]).filter(Boolean);
  if (!cards.length) return null;
  const label = `${name || "Their"} top turn-ons`;

  return (
    <section
      aria-label={label}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: variant === "strip" ? "10px 14px" : "14px 16px",
        background: variant === "strip" ? "rgb(var(--cream-rgb) / 0.04)" : "var(--surface-2)",
        borderRadius: variant === "strip" ? 16 : 18,
        boxShadow: "var(--ring-hairline)",
      }}
    >
      <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgb(var(--accent-rgb) / 0.8)" }}>
        {label}
      </span>
      {caption ? (
        <span style={{ fontSize: 13, color: "rgb(var(--cream-rgb) / 0.62)", lineHeight: 1.45, marginTop: -2 }}>
          {caption}
        </span>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {cards.map((c, i) => (
          <span
            key={c.id}
            style={{
              padding: "5px 11px",
              borderRadius: 999,
              fontSize: 13,
              background: "rgb(var(--cream-rgb) / 0.08)",
              color: "var(--cream)",
              boxShadow: "var(--ring-hairline)",
            }}
          >
            {ranked ? <strong style={{ marginRight: 4, color: "rgb(var(--accent-rgb) / 0.9)" }}>{i + 1}</strong> : null}{c.emoji} {c.label}
          </span>
        ))}
      </div>
    </section>
  );
}
