// quiz-deck data-integrity tests.
//
// quiz-deck.ts is mostly a large static deck of cards + a derived id map and two
// helpers. There's no runtime logic to flake, but the deck is hand-authored, so
// these guard against content-entry mistakes that would silently break the Sex
// Quiz: a duplicate card id (clobbers QUIZ_CARD_BY_ID), a card pointing at a
// category that doesn't exist (orphaned in the grouped reveal), or a malformed
// card. Plus the two helpers.
import { describe, expect, it } from "vitest";

import {
  QUIZ_CARD_BY_ID,
  QUIZ_CATEGORIES,
  QUIZ_DECK,
  categoryTitle,
  proposeHref,
} from "../quiz-deck";

describe("quiz-deck: data integrity", () => {
  it("has a non-trivial deck and category list", () => {
    expect(QUIZ_DECK.length).toBeGreaterThan(20);
    expect(QUIZ_CATEGORIES.length).toBeGreaterThan(0);
  });

  it("has unique card ids (a dup would clobber QUIZ_CARD_BY_ID)", () => {
    const ids = QUIZ_DECK.map((card) => card.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it("has unique category ids", () => {
    const ids = QUIZ_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every card belongs to a defined category", () => {
    const categoryIds = new Set(QUIZ_CATEGORIES.map((c) => c.id));
    const orphans = QUIZ_DECK.filter((card) => !categoryIds.has(card.category)).map(
      (card) => `${card.id}→${card.category}`,
    );
    expect(orphans).toEqual([]);
  });

  it("every card has the required non-empty fields and boolean flags", () => {
    const bad = QUIZ_DECK.filter((card) =>
      !card.id
      || !card.label
      || !card.emoji
      || !card.desc
      || typeof card.role !== "boolean"
      || typeof card.edge !== "boolean",
    ).map((card) => card.id || "(missing id)");
    expect(bad).toEqual([]);
  });

  it("QUIZ_CARD_BY_ID maps every card by id and nothing extra", () => {
    expect(Object.keys(QUIZ_CARD_BY_ID).length).toBe(QUIZ_DECK.length);
    for (const card of QUIZ_DECK) {
      expect(QUIZ_CARD_BY_ID[card.id]).toBe(card);
    }
  });
});

describe("quiz-deck: helpers", () => {
  it("categoryTitle resolves every category and falls back to '' for unknown ids", () => {
    for (const c of QUIZ_CATEGORIES) {
      expect(categoryTitle(c.id)).toBe(c.title);
    }
    expect(categoryTitle("does-not-exist")).toBe("");
    expect(categoryTitle("")).toBe("");
  });

  it("proposeHref builds an encoded /ask deep-link that round-trips the label", () => {
    const href = proposeHref("Oral & hands");
    expect(href.startsWith("/ask?note=")).toBe(true);
    // The label is percent-encoded (no raw space or ampersand in the query).
    expect(href).not.toContain(" ");
    expect(href.slice("/ask?note=".length)).not.toContain("&");
    const note = new URLSearchParams(href.split("?")[1]).get("note");
    expect(note).toBe("From our Sex Quiz: Oral & hands");
  });
});
