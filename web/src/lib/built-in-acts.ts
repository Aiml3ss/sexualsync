import type { Act } from "./types";

export const BUILT_IN_ACT_LABELS = [
  "💆 Sensual massage",
  "👅 Tongue Lashing",
  "💋 Mutual oral",
  "🍆 Penetration",
  "🐢 Slow positions",
  "🔥 Active positions",
  "🤠 Cowgirl or reverse",
  "🍑 From behind",
  "🧍 Standing or wall",
  "👑 On Top",
  "🛋️ Couch",
  "🎁 Toys or accessories",
  "💬 Dirty talk",
  "🔗 Kink",
  "⛓️ Light restraint",
  "🤗 Cuddling",
  "✋ Mutual Masturbation",
  "🪑 Face Sitting",
  "🎭 Roleplay",
];

export function combineBuiltInAndSavedActs(savedActs: Act[], workspaceId: string) {
  const saved = savedActs.map((act) => ({ ...act, source: act.source || "custom" }));
  const savedLabels = new Set(saved.map((act) => act.label.toLowerCase()));
  const builtIns = BUILT_IN_ACT_LABELS
    .filter((label) => !savedLabels.has(label.toLowerCase()))
    .map((label, index) => builtInAct(label, index, workspaceId));

  return [...saved, ...builtIns];
}

function builtInAct(label: string, index: number, workspaceId: string): Act {
  return {
    id: `built-in-${index}-${slug(label)}`,
    workspaceId,
    label,
    icon: "",
    tags: ["soft"],
    comfort: {},
    source: "built_in",
    addedByEmail: "",
    addedByName: "Sexualsync",
    approvedByEmail: "",
    approvedByName: "",
    createdAt: "",
    updatedAt: "",
  };
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "act";
}
