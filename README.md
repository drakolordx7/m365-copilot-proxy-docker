# M365 Copilot Proxy Docker

CasaOS/Docker packaging for [cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy).
It exposes Microsoft 365 Copilot through an OpenAI-compatible API.

## CasaOS deployment

Import `m365-copilot-proxy.yaml` as a custom app. The image is published for
`linux/amd64` and `linux/arm64`:

```text
ghcr.io/drakolordx7/m365-copilot-proxy-docker:latest
```

Before starting the app, create:

```text
/DATA/AppData/m365-copilot-proxy/config/secrets.json
```

with:

```json
{
  "email": "you@company.com",
  "password": "your-password",
  "mfaSecret": "YOUR_TOTP_BASE32_SECRET"
}
```

The file contains credentials and must not be committed or exposed. The
container persists the Microsoft token cache, browser profile, and Copilot
Studio agent ID in the same mounted directory.

## Client configuration

- Base URL: `http://<casaos-host>:4141/v1`
- API key: any value, such as `m365`
- Recommended model: `gpt-5.5-think-deeper`

The proxy itself does not authenticate incoming API requests. Keep port 4141
on your trusted LAN or place it behind an authenticated reverse proxy.

## Local development

```bash
docker compose up --build -d
```

The local compose file mounts `./config` for auth state and uses the same
multi-stage Dockerfile as the published image.
