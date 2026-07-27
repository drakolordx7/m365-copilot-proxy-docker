# M365 Copilot Proxy Docker

CasaOS / Docker packaging for [cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy).
Exposes Microsoft 365 Copilot as an OpenAI-compatible HTTP API.

**Published image** (`linux/amd64` + `linux/arm64`):

```text
ghcr.io/drakolordx7/m365-copilot-proxy-docker:latest
```

Also tagged as `main` and `sha-<commit>`.

---

## CasaOS install

### 1. Create secrets (required before start)

SSH into your CasaOS host:

```bash
mkdir -p /DATA/AppData/m365-copilot-proxy/config
nano /DATA/AppData/m365-copilot-proxy/config/secrets.json
```

Paste (edit with your real values):

```json
{
  "email": "you@company.com",
  "password": "your-password",
  "mfaSecret": "YOUR_TOTP_BASE32_SECRET"
}
```

Then lock it down:

```bash
chmod 600 /DATA/AppData/m365-copilot-proxy/config/secrets.json
```

Requirements:

- M365 account with **Copilot** access
- **TOTP MFA** — `mfaSecret` is the base32 authenticator seed, not a 6-digit code
- Do not commit or share this file

### 2. Import the app YAML

1. Open CasaOS → **App Store** → **Custom Install** / **Import**
2. Paste the contents of [`m365-copilot-proxy.yaml`](./m365-copilot-proxy.yaml) from this repo
3. Confirm port `4141` and the volume
   `/DATA/AppData/m365-copilot-proxy/config` → `/root/.config/opencode-m365`
4. Install / start

First boot runs a headless Chromium login and can take **1–3 minutes**. After
that, tokens refresh from the MSAL cache in the same folder.

### 3. Point your client

| Setting | Value |
|---|---|
| Base URL | `http://<casaos-host>:4141/v1` |
| API key | any string, e.g. `m365` (not verified by the proxy) |
| Model | `gpt-5.5-think-deeper` (recommended) |

Health check: `http://<casaos-host>:4141/health` → `{"status":"ok"}`

---

## Docker Compose (local / non-CasaOS)

```bash
git clone https://github.com/drakolordx7/m365-copilot-proxy-docker.git
cd m365-copilot-proxy-docker
mkdir -p config
cp secrets.json.example config/secrets.json
# edit config/secrets.json
docker compose up --build -d
```

Or run the prebuilt image without building:

```bash
mkdir -p config
cp secrets.json.example config/secrets.json   # edit first
docker run -d --name m365-copilot-proxy \
  --restart unless-stopped \
  -p 4141:4141 \
  --shm-size=256m \
  -v "$PWD/config:/root/.config/opencode-m365" \
  ghcr.io/drakolordx7/m365-copilot-proxy-docker:latest
```

---

## What gets persisted

Bind-mounted under the config directory:

| File / dir | Purpose |
|---|---|
| `secrets.json` | Your credentials (you create) |
| `msal-cache.json` | OAuth tokens (auto) |
| `browser-profile/` | Chromium profile for quieter re-login (auto) |
| `agent-id.json` | Copilot Studio agent cache (auto) |

---

## Security

The proxy **does not authenticate** incoming API requests and spends your paid
M365 Copilot quota. Keep port `4141` on a trusted LAN, or put it behind an
authenticated reverse proxy / VPN.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Container exits immediately with missing secrets | Create `secrets.json` on the host path above |
| Auth failed / restart loop | Check email/password; confirm TOTP seed is base32; ensure Copilot is licensed |
| Slow first start | Normal — Playwright login + MFA can take a few minutes (`start_period` is 180s) |
| Empty / “Disengaged” replies | Use `gpt-5.5-think-deeper` and keep client toolsets lean |
| Need logs | Set `M365_DEBUG=1` (or `M365_TRACE=1`) in the container env |

Upstream project docs: https://github.com/cramt/m365-copilot-proxy
