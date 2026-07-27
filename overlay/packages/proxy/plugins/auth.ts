import {
  effectiveAuthMode,
  getToken,
  getTokenSilent,
} from "@m365-copilot/core";

/**
 * Startup auth:
 * - secrets mode: require automated login (email/password/TOTP) before serving
 * - oauth mode: allow boot without a token; user signs in via /auth (passkeys OK)
 */
export default defineNitroPlugin(async () => {
  const mode = effectiveAuthMode();
  console.log(`Auth mode: ${mode}`);

  const silent = await getTokenSilent();
  if (silent) {
    console.log("Authenticated via cached MSAL token.");
    return;
  }

  if (mode === "secrets") {
    console.log("Authenticating with secrets.json (automated login)...");
    try {
      await getToken();
      console.log("Authenticated.");
    } catch (err: any) {
      console.error(`Auth failed: ${err.message}`);
      throw err;
    }
    return;
  }

  console.log(
    "Waiting for interactive OAuth. Open http://<host>:<port>/auth to sign in (passkeys supported).",
  );
});
