import { getTokenSilent } from "@m365-copilot/core";

/**
 * Gate OpenAI API routes until MSAL auth has completed.
 * GET /v1/models is exempt so Open WebUI / Cursor can list models before chat.
 */
export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname;
  if (!path.startsWith("/v1")) return;

  // Static model catalog — no M365 session needed to advertise IDs.
  if (event.method === "GET" && path === "/v1/models") return;

  const token = await getTokenSilent();
  if (token) return;

  throw createError({
    statusCode: 401,
    statusMessage: "Not authenticated",
    message:
      "Sign in first: open /auth in a browser (Microsoft OAuth / passkey), then retry.",
  });
});
