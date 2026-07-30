#!/usr/bin/env bash
# Compare this packaging-repo tip to the running host container + GitHub Actions tip.
# Usage:
#   M365_VERIFY_HOST=user@host scripts/verify-build-parity.sh
#   scripts/verify-build-parity.sh user@host
# Optional: M365_VERIFY_SSH_PORT (default 22)
set -euo pipefail
HOST="${1:-${M365_VERIFY_HOST:-}}"
if [[ -z "$HOST" ]]; then
  echo "Usage: scripts/verify-build-parity.sh user@host" >&2
  echo "   or: M365_VERIFY_HOST=user@host scripts/verify-build-parity.sh" >&2
  exit 2
fi
SSH_PORT="${M365_VERIFY_SSH_PORT:-22}"
SSH=(ssh -o StrictHostKeyChecking=no -p "$SSH_PORT" "$HOST")

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOCAL_COMMIT="$(git rev-parse HEAD)"
LOCAL_SHORT="$(git rev-parse --short HEAD)"

echo "=== local packaging repo ==="
echo "commit: $LOCAL_COMMIT"

echo
echo "=== GitHub Actions (branch tip) ==="
gh run list --branch "$(git branch --show-current)" --limit 3 --json databaseId,headSha,status,conclusion,url,createdAt \
  --jq '.[] | "\(.createdAt) \(.status)/\(.conclusion // "-") sha=\(.headSha[0:7]) \(.url)"'

LATEST_SHA="$(gh run list --branch "$(git branch --show-current)" --limit 1 --json headSha --jq '.[0].headSha // empty')"
if [[ -n "$LATEST_SHA" && "$LATEST_SHA" == "$LOCAL_COMMIT" ]]; then
  echo "OK: latest CI run is for the same commit as local ($LOCAL_SHORT)"
else
  echo "NOTE: latest CI headSha=${LATEST_SHA:-none} vs local=$LOCAL_SHORT (push may still be in flight)"
fi

echo
echo "=== note on GHCR ==="
echo "PR builds do not push to GHCR (workflow push=false on pull_request)."
echo "Host :latest is the locally-built branch image; GHCR :latest updates only after merge to main."

echo
echo "=== host running container ==="
"${SSH[@]}" "sudo docker exec m365-copilot-proxy sh -c '
  echo source_commit=\$(cat /app/.source-commit 2>/dev/null || echo missing)
  echo upstream_sha=\$(cat /app/.upstream-sha 2>/dev/null | tr \"\\n\" \" \" )
  echo nitro_framing_summary_spec=\$(grep -c summary_spec /app/packages/proxy/.output/server/chunks/nitro/nitro.mjs)
  echo nitro_framing_mode_agent=\$(grep -c \"MODE: Agent\" /app/packages/proxy/.output/server/chunks/nitro/nitro.mjs)
  echo nitro_sha256=\$(sha256sum /app/packages/proxy/.output/server/chunks/nitro/nitro.mjs | awk \"{print \\\$1}\")
'"

echo
echo "=== done ==="
