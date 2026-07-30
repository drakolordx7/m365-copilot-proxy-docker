# Security

This proxy authenticates to Microsoft with **your** M365 Copilot account and exposes an OpenAI-compatible HTTP API. Treat the host like a credentials vault.

## Do not commit

- `config/` (runtime auth state)
- `secrets.json` / any real email, password, or TOTP seed
- `msal-cache.json` (refresh tokens)
- `browser-profile/`
- `.env` and other local API keys
- `*.log` / debug traces (may include prompts and tool I/O)

Use `secrets.json.example` and `.env.example` only as templates.

## Caller authentication

Set `M365_API_KEY` in the deployment environment. Clients must send:

```http
Authorization: Bearer <M365_API_KEY>
```

or:

```http
X-API-Key: <M365_API_KEY>
```

If `M365_API_KEY` is unset, the proxy accepts unauthenticated `/v1` calls for legacy LAN installs. That is convenient and unsafe on any shared or internet-exposed network.

## Network exposure

- Prefer binding to a private LAN or VPN.
- Put a reverse proxy with TLS + auth in front if the service must leave the LAN.
- Set `M365_CORS_ORIGIN` to explicit browser origins when browser clients are used.

## Logging

Keep `M365_DEBUG=0` and unset `M365_TRACE` unless you are actively diagnosing. Rotate or delete `debug.log` under the config volume afterward.

## Upstream

Report packaging/security issues for this Docker/CasaOS wrapper on this repository. Upstream proxy issues belong at [cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy).
