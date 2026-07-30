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

### Cursor BYOK — did the request hit this proxy?

**Override OpenAI Base URL does not mean “GPT only”.** Cursor routes by provider and version; first-party models like **Grok** and **Composer** often use Cursor’s own infrastructure and may work even when the override points at your M365 proxy. That does **not** prove GPT is (or isn’t) using the proxy.

Our proxy also accepts **any** model name — unknown ids like `grok-4.5` fall back to Copilot **Auto**, so Grok can appear to “work” while actually returning M365 Copilot.

**Verify routing:**

1. **Broken-URL test** — set Override Base URL to `http://127.0.0.1:1/v1`, pick **GPT-5.5** or **GPT-5.4**, send a chat. It should fail immediately. Then pick **Grok** — if Grok still works, Grok is bypassing your override (expected for first-party Grok).
2. **Container logs** — while chatting, run `docker logs -f <container>`. Each request logs:
   `[m365-proxy] chat model=… tone=… source=…`
   If you see nothing when using GPT, Cursor isn’t sending GPT to your proxy yet.
3. **Response headers** — successful proxy responses include `X-M365-Resolved-Tone` and `X-M365-Route-Source`.
4. **Usage block** — proxy responses include `x_m365_conversation_messages` in the `usage` object. Native Grok/OpenAI responses won’t have that field.

Cursor setup: enable override, base URL `http://<host>:4141/v1`, API key any string, pick a **built-in GPT model** (e.g. GPT-5.6 Sol, GPT-5.5, GPT-5.4). No custom model names needed. Use Cursor **3.5.38+** for GPT-5.5 BYOK.

Upstream: https://github.com/cramt/m365-copilot-proxy
