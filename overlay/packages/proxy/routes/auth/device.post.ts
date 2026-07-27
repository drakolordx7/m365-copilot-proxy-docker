import { getAuthStatus, loginWithDeviceCode } from "@m365-copilot/core";

type DevicePayload = {
  userCode: string;
  verificationUri: string;
  message: string;
};

/**
 * Starts device-code login and waits until the user finishes (or it fails).
 * Note: some tenants/clients disable device code for this public client — use
 * the browser PKCE flow at /auth if this returns an error.
 */
export default defineEventHandler(async (event) => {
  const status = await getAuthStatus();
  if (status.authenticated) {
    return { alreadyAuthenticated: true, ...status };
  }

  let first: DevicePayload | null = null;
  try {
    const result = await loginWithDeviceCode((msg) => {
      if (!first) first = msg;
      console.log(`[auth/device] ${msg.message}`);
    });
    return {
      ok: true,
      device: first,
      account: result.account,
      ...(await getAuthStatus()),
    };
  } catch (err: any) {
    throw createError({
      statusCode: 400,
      statusMessage: "Device code login failed",
      message:
        (err?.message || String(err)) +
        " — If your tenant blocks device code, use the browser login on /auth instead.",
    });
  }
});
