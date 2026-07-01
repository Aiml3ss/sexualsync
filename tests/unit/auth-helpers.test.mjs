import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isMemberOfWorkspace,
  getActiveMember,
  getPartnerMember,
  normalizeEmail,
} from "../../functions/api/_auth.js";
import { sameOriginPath } from "../../functions/api/auth/google/_oauth.js";

const ws = {
  status: "active",
  members: [
    { email: "Alex@x.com", status: "active", displayName: "Alex" },
    { email: "kem@x.com", status: "invited", displayName: "Kem" },
  ],
};

test("active member recognized (case-insensitive); invited member is not a member", () => {
  assert.equal(isMemberOfWorkspace(ws, "ALEX@x.com"), true);
  assert.equal(isMemberOfWorkspace(ws, "kem@x.com"), false);
});

test("deleted workspace denies everyone", () => {
  assert.equal(isMemberOfWorkspace({ ...ws, status: "deleted" }, "alex@x.com"), false);
});

test("getActiveMember returns only active rows", () => {
  assert.equal(getActiveMember(ws, "alex@x.com")?.displayName, "Alex");
  assert.equal(getActiveMember(ws, "kem@x.com"), null);
});

test("getPartnerMember excludes self and inactive partners", () => {
  assert.equal(getPartnerMember(ws, "alex@x.com"), null); // partner is only 'invited'
});

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail("  Foo@Bar.COM "), "foo@bar.com");
});

test("sameOriginPath neutralizes open-redirect attempts", () => {
  for (const evil of ["https://evil.com", "//evil.com", "javascript:alert(1)", "https://evil.com/path"]) {
    const out = sameOriginPath(evil);
    assert.ok(out.startsWith("/"), `${evil} -> ${out}`);
    assert.ok(!out.toLowerCase().includes("evil"));
    assert.ok(!out.toLowerCase().startsWith("javascript"));
  }
});

test("sameOriginPath blocks /api/auth/* but keeps normal in-app paths", () => {
  assert.equal(sameOriginPath("/api/auth/google"), "/");
  assert.equal(sameOriginPath("/ask?x=1#y"), "/ask?x=1#y");
  assert.equal(sameOriginPath(""), "/");
});
