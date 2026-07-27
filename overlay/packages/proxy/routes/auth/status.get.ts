import { getAuthStatus } from "@m365-copilot/core";

export default defineEventHandler(async () => {
  return getAuthStatus();
});
