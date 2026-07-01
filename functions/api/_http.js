// Generic HTTP helpers for Cloudflare Pages Functions.
//
// Web-standard only (no Cloudflare-specific globals) so the same handlers run
// on both the Cloudflare and Node self-host runtimes.

export function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
