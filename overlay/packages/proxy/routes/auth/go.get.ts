import { startOAuthLogin } from "@m365-copilot/core";

/** Same-tab redirect to Microsoft login (no popup). Bookmark /auth first. */
export default defineEventHandler(async (event) => {
  const started = await startOAuthLogin();
  return sendRedirect(event, started.authUrl, 302);
});
