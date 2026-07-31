#!/usr/bin/env bash
# Build m365-copilot-proxy overlay on the CasaOS host and recreate the container.
# Run locally after install-cursor-ssh-key.sh, or on the server with SKIP_SSH=1.
set -euo pipefail

SSH_ALIAS="${CURSOR_SSH_ALIAS:-drakolord-cursor-wan}"
BRANCH="${DEPLOY_BRANCH:-cursor/simplify-cursor-writes-8f7d}"
REPO="${DEPLOY_REPO:-https://github.com/drakolordx7/m365-copilot-proxy-docker.git}"
BUILD_DIR="${DEPLOY_BUILD_DIR:-/tmp/m365-fix-build}"
TAG="${DEPLOY_TAG:-m365-copilot-proxy:cursor-writes-fix}"
COMPOSE_DIR="${DEPLOY_COMPOSE_DIR:-/var/lib/casaos/apps/m365-copilot-proxy}"

REMOTE_SCRIPT=$(cat <<EOF
set -euo pipefail
echo '--- host ---'
whoami
sudo -n id
sudo -n docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null | sed -n '1,6p'

echo '--- fetch + build ---'
sudo rm -rf ${BUILD_DIR}
git clone --depth 1 -b ${BRANCH} ${REPO} ${BUILD_DIR}
cd ${BUILD_DIR}
if command -v node >/dev/null 2>&1; then
  node scripts/verify-cursor-dispatch.mjs
  node scripts/verify-native-orchestration.mjs
else
  echo 'node not on host — skipping verify scripts (ran in CI/agent)'
fi
export DOCKER_CONFIG=/tmp/docker-cursor-build
mkdir -p "\$DOCKER_CONFIG"
sudo -E env DOCKER_CONFIG="\$DOCKER_CONFIG" docker build -t ${TAG} .
sudo docker tag ${TAG} ghcr.io/drakolordx7/m365-copilot-proxy-docker:latest

echo '--- recreate container ---'
cd ${COMPOSE_DIR}
if [ -f docker-compose.yml ]; then
  sudo docker compose up -d --no-deps --force-recreate
else
  cd /DATA/.casaos/apps/m365-copilot-proxy
  sudo docker compose up -d --no-deps --force-recreate
fi

sleep 3
curl -fsS http://127.0.0.1:4141/health
echo
sudo docker logs --tail 20 m365-copilot-proxy
EOF
)

if [[ "${SKIP_SSH:-0}" == "1" ]]; then
  bash -lc "$REMOTE_SCRIPT"
else
  ssh "$SSH_ALIAS" bash -s <<EOF
$REMOTE_SCRIPT
EOF
fi

echo "Deploy complete on ${SSH_ALIAS:-server}"
