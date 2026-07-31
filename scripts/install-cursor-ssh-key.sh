#!/usr/bin/env bash
# Install Cursor agent SSH key + ~/.ssh/config alias for the CasaOS host.
#
# Required:
#   CURSOR_SSH_KEY_B64   base64-encoded private key (OpenSSH)
#   CURSOR_SSH_PUB_B64   base64-encoded public key line
#
# Optional:
#   CURSOR_SSH_HOST      default 98.240.242.148
#   CURSOR_SSH_PORT      default 22222
#   CURSOR_SSH_USER      default cursor
#   CURSOR_SSH_ALIAS     default drakolord-cursor-wan
set -euo pipefail

: "${CURSOR_SSH_KEY_B64:?Set CURSOR_SSH_KEY_B64}"
: "${CURSOR_SSH_PUB_B64:?Set CURSOR_SSH_PUB_B64}"

HOST="${CURSOR_SSH_HOST:-98.240.242.148}"
PORT="${CURSOR_SSH_PORT:-22222}"
USER="${CURSOR_SSH_USER:-cursor}"
ALIAS="${CURSOR_SSH_ALIAS:-drakolord-cursor-wan}"
KEY="$HOME/.ssh/cursor_drakolord"
CONFIG="$HOME/.ssh/config"

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

umask 077
printf '%s' "$CURSOR_SSH_KEY_B64" | base64 -d > "$KEY"
printf '%s\n' "$CURSOR_SSH_PUB_B64" | base64 -d > "${KEY}.pub"
chmod 600 "$KEY"
chmod 644 "${KEY}.pub"

touch "$CONFIG"
chmod 600 "$CONFIG"

# Replace or append Host block for ALIAS
python3 - "$CONFIG" "$ALIAS" "$HOST" "$PORT" "$USER" "$KEY" <<'PY'
import sys
from pathlib import Path

config_path, alias, host, port, user, key = sys.argv[1:7]
block = f"""
Host {alias}
  HostName {host}
  Port {port}
  User {user}
  IdentityFile {key}
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
""".strip() + "\n"

path = Path(config_path)
text = path.read_text() if path.exists() else ""
marker = f"Host {alias}\n"
if marker in text:
    parts = text.split(marker, 1)
    head = parts[0]
    tail = parts[1]
    # Drop old block until next Host or EOF
    if "\nHost " in tail:
        tail = tail.split("\nHost ", 1)[1]
        text = head + "Host " + tail
    else:
        text = head
path.write_text(text.rstrip() + "\n\n" + block)
PY

echo "Installed SSH key → $KEY"
echo "Configured alias → ssh $ALIAS"
