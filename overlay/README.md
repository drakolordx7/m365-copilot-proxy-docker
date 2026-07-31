# Packaging overlay

Files under `packages/` are copied onto a pinned checkout of
[cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy) during the Docker build.

Pinned upstream commit: see [`UPSTREAM_BASE_SHA`](./UPSTREAM_BASE_SHA).

This overlay adds:

- Interactive OAuth / passkey login routes (`/auth`)
- OpenAI-compatible hardening (API key, CORS, schema/tool policy)
- Cursor compatibility + orchestration (near-native Ask / Plan / Agent)
  - Capability-aware writes (Shell/base64 when Cursor omits Write)
  - Single recovery policy in `proxy-lib/src/orchestration.ts`
  - Sandbox-path rewrite (`/mnt/data` → workspace-relative)
