# M365 Copilot Proxy Docker

CasaOS / Docker packaging for [cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy).
Exposes Microsoft 365 Copilot as an OpenAI-compatible HTTP API.

**Published image** (`linux/amd64` + `linux/arm64`):

```text
ghcr.io/drakolordx7/m365-copilot-proxy-docker:latest
```

---

## Auth modes

| `M365_AUTH_MODE` | When to use |
|---|---|
| `oauth` (default) | **Entra passkeys / Authenticator** — sign in at `/auth` in a browser |
| `secrets` | Headless TOTP — `secrets.json` with email/password/`mfaSecret` |
| `auto` | Use `secrets.json` if present, otherwise OAuth |

OAuth is what you want if your work tenant is **passkey-only** (no TOTP seed).

---

## CasaOS install (OAuth / passkey)

1. Import [`m365-copilot-proxy.yaml`](./m365-copilot-proxy.yaml) in CasaOS → App Store → Custom Install.
2. Start the app (no `secrets.json` required).
3. On your phone or laptop open:

   `http://<casaos-host>:4141/auth`

4. **Start Microsoft login** → complete normal work sign-in (passkey OK).
5. When the browser lands on a mostly blank Microsoft page, copy the **full URL**
   (contains `?code=`) and paste it into the form → **Complete sign-in**.
6. Point clients at:

| Setting | Value |
|---|---|
| Base URL | `http://<casaos-host>:4141/v1` |
| API key | any string, e.g. `m365` |
| Model | `think-deeper` or `gpt-5.6-think-deeper` |

Tokens persist under `/DATA/AppData/m365-copilot-proxy/config/` and refresh silently afterward.

---

## Docker Compose

```bash
git clone https://github.com/drakolordx7/m365-copilot-proxy-docker.git
cd m365-copilot-proxy-docker
mkdir -p config
docker compose up --build -d
# then open http://localhost:4141/auth
```

### Optional TOTP secrets mode

```bash
cp secrets.json.example config/secrets.json   # edit email/password/mfaSecret
# set M365_AUTH_MODE=secrets in compose or:
docker compose run -e M365_AUTH_MODE=secrets ...
```

---

## Security

The proxy **does not authenticate** API callers and spends your paid M365 Copilot
quota. Keep port `4141` on a trusted LAN or behind an authenticated reverse proxy / VPN.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/v1` returns 401 | Finish sign-in at `/auth` |
| Passkey-only work account | Use `M365_AUTH_MODE=oauth` (default) — do not use secrets mode |
| Device code button fails | Normal for some tenants — use the browser PKCE flow instead |
| Need logs | Set `M365_DEBUG=1` or `M365_TRACE=1` |

Upstream: https://github.com/cramt/m365-copilot-proxy
