import { getTokenSilent } from "@m365-copilot/core";

/**
 * Gate OpenAI API routes until MSAL auth has completed.
 * /auth/*, /health, and static assets remain reachable for login UX.
 */
export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname;
  if (!path.startsWith("/v1")) return;

  const token = await getTokenSilent();
  if (token) return;

  throw createError({
    statusCode: 401,
    statusMessage: "Not authenticated",
    message:
      "Sign in first: open /auth in a browser (Microsoft OAuth / passkey), then retry.",
  });
});
