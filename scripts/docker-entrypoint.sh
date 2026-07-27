#!/bin/sh
# Start the Nitro proxy. Supports:
#   M365_AUTH_MODE=oauth   → interactive browser/passkey login via /auth (no secrets.json)
#   M365_AUTH_MODE=secrets → require secrets.json (email/password/TOTP)
#   M365_AUTH_MODE=auto    → secrets.json if present, otherwise oauth (default)
set -eu

CONFIG_DIR="${HOME:-/root}/.config/opencode-m365"
SECRETS_FILE="${M365_SECRETS_FILE:-$CONFIG_DIR/secrets.json}"
AUTH_MODE="$(printf '%s' "${M365_AUTH_MODE:-auto}" | tr '[:upper:]' '[:lower:]')"

mkdir -p "$CONFIG_DIR"

has_secrets=0
if [ -f "$SECRETS_FILE" ]; then
  if node -e "
const fs = require('fs');
const raw = fs.readFileSync(process.argv[1], 'utf8');
let data;
try { data = JSON.parse(raw); } catch (e) {
  console.error('ERROR: secrets.json is not valid JSON:', e.message);
  process.exit(2);
}
for (const key of ['email', 'password', 'mfaSecret']) {
  if (!data[key] || typeof data[key] !== 'string') {
    console.error('ERROR: secrets.json missing required string field:', key);
    process.exit(2);
  }
}
" "$SECRETS_FILE"; then
    has_secrets=1
  else
    # Invalid secrets file: only fatal in secrets mode / when auto would pick it.
    if [ "$AUTH_MODE" = "secrets" ] || [ "$AUTH_MODE" = "auto" ]; then
      exit 1
    fi
  fi
fi

need_secrets=0
case "$AUTH_MODE" in
  secrets) need_secrets=1 ;;
  auto) [ "$has_secrets" = "1" ] && need_secrets=1 || need_secrets=0 ;;
  oauth) need_secrets=0 ;;
  *)
    echo "ERROR: M365_AUTH_MODE must be oauth, secrets, or auto (got: $AUTH_MODE)" >&2
    exit 1
    ;;
esac

if [ "$need_secrets" = "1" ] && [ "$has_secrets" != "1" ]; then
  cat >&2 <<EOF
ERROR: Missing M365 secrets file: $SECRETS_FILE

Create it on the host (bind-mounted into the container) with:

  {
    "email": "you@company.com",
    "password": "your-password",
    "mfaSecret": "YOUR_TOTP_BASE32_SECRET"
  }

Or switch to interactive OAuth / passkey login:

  M365_AUTH_MODE=oauth

Then open http://<host>:4141/auth after start.

CasaOS path: /DATA/AppData/m365-copilot-proxy/config/secrets.json
Local compose path: ./config/secrets.json
EOF
  exit 1
fi

if [ "$AUTH_MODE" = "oauth" ] || { [ "$AUTH_MODE" = "auto" ] && [ "$has_secrets" != "1" ]; }; then
  echo "Starting in OAuth mode — after boot, open /auth to sign in (passkeys supported)."
fi

exec node packages/proxy/bin/m365-proxy.mjs "${1:-${PORT:-4141}}"
