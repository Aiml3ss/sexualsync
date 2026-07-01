import { startEmailSignIn } from "./_email_auth.js";

export async function onRequest(context) {
  return startEmailSignIn(context);
}
