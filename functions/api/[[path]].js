import { jsonResponse } from "./_auth.js";

export function onRequest() {
  return jsonResponse(404, { error: "API route not found." });
}
