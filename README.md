# M365 Copilot Proxy (Docker / CasaOS)

Turn your **Microsoft 365 Copilot** work account into an **OpenAI-compatible API**, then use it from Cursor, Open WebUI, or any client that speaks the OpenAI HTTP API.

This packaging repo wraps [cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy) with:

1. **Browser OAuth / passkey sign-in** (no TOTP seed required for Entra)
2. **OpenAI-compatible `/v1`** (`/v1/models`, `/v1/chat/completions`)
3. **Cursor compatibility layer** so Ask / Plan / Agent feel near-native when you point Cursor BYOK at this proxy

**Image** (`linux/amd64` + `linux/arm64`):

```text
ghcr.io/drakolordx7/m365-copilot-proxy-docker:latest
```

---

## What you get

| Surface | Purpose |
|---|---|
| `http://<host>:4141/auth` | Sign in with your work M365 Copilot account (passkeys OK) |
| `http://<host>:4141/v1` | OpenAI-compatible base URL for any client |
| Cursor BYOK | Same `/v1` URL — tool calls, framing, and mode policy adapted for Cursor |

Auth tokens stay on the host under the config volume (`msal-cache.json`). They are never published in this repo.

---

## Quick start (CasaOS)

1. Import [`m365-copilot-proxy.yaml`](./m365-copilot-proxy.yaml) → CasaOS → App Store → Custom Install.
2. Set **`M365_API_KEY`** to a long random secret (recommended before exposing the port).
3. Start the app.
4. Open `http://<casaos-host>:4141/auth` → **Start Microsoft login** → finish work sign-in.
5. When Microsoft lands on a mostly blank page, copy the **full URL** (contains `?code=`) and paste it into the form → **Complete sign-in**.
6. Point clients at:

| Setting | Value |
|---|---|
| Base URL | `http://<casaos-host>:4141/v1` |
| API key | the `M365_API_KEY` you set |
| Model | `think-deeper` / `gpt-5.6-think-deeper` (or whatever `/v1/models` lists) |

---

## Quick start (Docker Compose)

```bash
git clone https://github.com/drakolordx7/m365-copilot-proxy-docker.git
cd m365-copilot-proxy-docker
cp .env.example .env          # set M365_API_KEY
mkdir -p config
docker compose up --build -d
# open http://localhost:4141/auth and complete browser sign-in
```

Optional headless TOTP mode (only if your tenant still allows password + authenticator seed):

```bash
cp secrets.json.example config/secrets.json   # edit locally — never commit
M365_AUTH_MODE=secrets docker compose up --build -d
```

---

## Use with Cursor

1. Cursor Settings → Models → **OpenAI API Key** / BYOK.
2. **Override OpenAI Base URL** → `http://<host>:4141/v1`
3. API key → your `M365_API_KEY`
4. Pick a listed model (GPT-class Copilot models work best for Agent).

The Cursor compatibility layer (on by default):

- Detects Cursor tool payloads and applies Cursor-oriented framing
- Maps fence aliases (`ReadFile`→`Read`, `rg`→`Grep`, etc.)
- Keeps Plan / Ask read-only (no Write / Delete synthesis)
- Serializes turns per conversation and preserves tool-call identity
- Leaves non-Cursor clients on the default shell-first path

Disable with `M365_CURSOR_COMPAT=0` if you only want raw OpenAI compatibility.

---

## Auth modes

| `M365_AUTH_MODE` | When to use |
|---|---|
| `oauth` (default) | Browser / passkey sign-in at `/auth` |
| `secrets` | Headless email/password/`mfaSecret` via `secrets.json` |
| `auto` | Prefer `secrets.json` when present, else OAuth |

For passkey-only work tenants, stay on `oauth`.

---

## Security & privacy

- **Set `M365_API_KEY`.** Without it, any client that can reach port `4141` can spend your Copilot quota.
- Keep `4141` on LAN / VPN, or put it behind an authenticated reverse proxy.
- Restrict browser CORS with `M365_CORS_ORIGIN` (defaults restrictive).
- Never commit `config/`, `secrets.json`, `msal-cache.json`, `.env`, or debug logs.
- Prefer `M365_DEBUG=0` in production; debug logs can contain prompt/tool traffic.

See [SECURITY.md](./SECURITY.md).

---

## Environment cheatsheet

| Variable | Default | Notes |
|---|---|---|
| `M365_AUTH_MODE` | `oauth` | `oauth` / `secrets` / `auto` |
| `M365_API_KEY` | unset | Caller auth via `Authorization: Bearer` or `X-API-Key` |
| `M365_CORS_ORIGIN` | restrictive | Comma-separated origins, or leave unset |
| `M365_CURSOR_COMPAT` | on | Set `0` to disable Cursor adaptations |
| `M365_DEBUG` | `0` | Truncated debug logging under the config volume |
| `M365_TRACE` | unset | Full protocol trace (implies debug) |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/v1` returns 401 from Microsoft session | Finish sign-in at `/auth` |
| `/v1` returns 401 with API key configured | Send the same `M365_API_KEY` as Bearer or `X-API-Key` |
| Passkey-only work account | Use `M365_AUTH_MODE=oauth` — do not use secrets mode |
| Device-code button fails | Use the browser PKCE flow on `/auth` instead |
| Cursor feels “dumb” / shell-only | Confirm Cursor BYOK base URL ends with `/v1` and compat is not disabled |

---

## Development notes

Packaging overlay lives in [`overlay/`](./overlay/). Upstream pin is [`overlay/UPSTREAM_BASE_SHA`](./overlay/UPSTREAM_BASE_SHA).

```bash
node scripts/verify-cursor-dispatch.mjs
node scripts/verify-native-orchestration.mjs
```

Upstream project: https://github.com/cramt/m365-copilot-proxy
