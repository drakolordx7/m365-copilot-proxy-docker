#!/bin/sh
# Validate required auth config before starting the Nitro proxy.
set -eu

CONFIG_DIR="${HOME:-/root}/.config/opencode-m365"
SECRETS_FILE="${M365_SECRETS_FILE:-$CONFIG_DIR/secrets.json}"

mkdir -p "$CONFIG_DIR"

if [ ! -f "$SECRETS_FILE" ]; then
  cat >&2 <<EOF
ERROR: Missing M365 secrets file: $SECRETS_FILE

Create it on the host (bind-mounted into the container) with:

  {
    "email": "you@company.com",
    "password": "your-password",
    "mfaSecret": "YOUR_TOTP_BASE32_SECRET"
  }

CasaOS path: /DATA/AppData/m365-copilot-proxy/config/secrets.json
Local compose path: ./config/secrets.json

TOTP MFA is required for headless login. Do not commit this file.
EOF
  exit 1
fi

# Basic sanity check — must be JSON with the three required keys.
if ! node -e "
const fs = require('fs');
const raw = fs.readFileSync(process.argv[1], 'utf8');
let data;
try { data = JSON.parse(raw); } catch (e) {
  console.error('ERROR: secrets.json is not valid JSON:', e.message);
  process.exit(1);
}
for (const key of ['email', 'password', 'mfaSecret']) {
  if (!data[key] || typeof data[key] !== 'string') {
    console.error('ERROR: secrets.json missing required string field:', key);
    process.exit(1);
  }
}
" "$SECRETS_FILE"; then
  exit 1
fi

exec node packages/proxy/bin/m365-proxy.mjs "${1:-${PORT:-4141}}"
