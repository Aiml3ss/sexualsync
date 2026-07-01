import { startGoogleOAuth } from "./_oauth.js";

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed." }), {
      status: 405,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
  return startGoogleOAuth(context);
}
