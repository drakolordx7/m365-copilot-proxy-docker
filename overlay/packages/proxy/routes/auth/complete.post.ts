import { completeOAuthLogin, getAuthStatus } from "@m365-copilot/core";

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({} as any));
  const redirectUrl =
    (typeof body?.redirectUrl === "string" && body.redirectUrl) ||
    (typeof body?.url === "string" && body.url) ||
    (typeof body?.code === "string" && body.code) ||
    "";

  if (!redirectUrl.trim()) {
    throw createError({
      statusCode: 400,
      statusMessage: "Missing redirectUrl",
      message: "POST JSON { \"redirectUrl\": \"https://login.microsoftonline.com/.../nativeclient?code=...\" }",
    });
  }

  try {
    const result = await completeOAuthLogin(redirectUrl);
    const status = await getAuthStatus();
    return { ok: true, ...result, ...status };
  } catch (err: any) {
    throw createError({
      statusCode: 400,
      statusMessage: "OAuth complete failed",
      message: err?.message || String(err),
    });
  }
});
