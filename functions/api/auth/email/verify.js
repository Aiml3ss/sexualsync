import { verifyEmailSignIn } from "./_email_auth.js";

export async function onRequest(context) {
  return verifyEmailSignIn(context);
}
