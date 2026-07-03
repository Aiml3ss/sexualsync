import { test } from "node:test";
import assert from "node:assert/strict";
import { sendSignInCodeEmail } from "../../functions/api/_email.js";

test("sign-in code email renders a premium code block and discreet subject", async () => {
  const originalFetch = globalThis.fetch;
  let payload = null;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: "email-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await sendSignInCodeEmail({
      RESEND_API_KEY: "test",
      RESEND_FROM: "Notifications <hello@mail.sexualsync.io>",
    }, {
      to: "person@example.test",
      code: "123456",
    });

    assert.equal(result.ok, true);
    assert.equal(payload.subject, "You have a new notification");
    assert.equal(payload.to[0], "person@example.test");
    assert.match(payload.html, /Your private sign-in code/);
    assert.match(payload.html, /One-time sign-in code/);
    assert.match(payload.html, /123 456/);
    assert.match(payload.html, /border-radius:16px/);
    assert.match(payload.text, /One-time sign-in code: 123456/);
    assert.doesNotMatch(payload.text, /\[object Object\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
