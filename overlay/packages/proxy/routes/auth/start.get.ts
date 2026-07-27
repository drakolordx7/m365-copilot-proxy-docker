import { getAuthStatus, startOAuthLogin } from "@m365-copilot/core";

export default defineEventHandler(async () => {
  const status = await getAuthStatus();
  if (status.authenticated) {
    return { alreadyAuthenticated: true, ...status };
  }
  const started = await startOAuthLogin();
  return { alreadyAuthenticated: false, ...started };
});
