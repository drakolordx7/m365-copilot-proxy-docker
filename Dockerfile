# m365-copilot-proxy — OpenAI-compatible proxy for Microsoft 365 Copilot
# Upstream: https://github.com/cramt/m365-copilot-proxy
#
# Multi-stage build: compile the Nitro proxy from upstream, then ship a slim
# Chromium-enabled runtime image suitable for CasaOS / Docker Compose.

# -----------------------------------------------------------------------------
# Builder
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app

# Reviewed upstream commit. Override deliberately for an upstream update.
ARG M365_REF=92682ad05f82ec73f6e0ab57a9de4a9997a2a3a6
# Packaging-repo commit that produced this image (set by CI / local builds).
ARG SOURCE_COMMIT=unknown
RUN git init /tmp/src \
  && git -C /tmp/src remote add origin https://github.com/cramt/m365-copilot-proxy.git \
  && git -C /tmp/src fetch --depth 1 origin "${M365_REF}" \
  && git -C /tmp/src checkout --detach FETCH_HEAD \
  && cp -a /tmp/src/. /app/ \
  && echo "Built from cramt/m365-copilot-proxy@${M365_REF}" \
  && (git -C /app rev-parse HEAD > /app/.upstream-sha || echo "${M365_REF}" > /app/.upstream-sha) \
  && echo "${SOURCE_COMMIT}" > /app/.source-commit

# Packaging overlay: interactive OAuth / passkey login for CasaOS (no TOTP seed).
COPY overlay/ /tmp/overlay/
RUN cp -a /tmp/overlay/packages/. /app/packages/ \
  && expected="$(cat /tmp/overlay/UPSTREAM_BASE_SHA 2>/dev/null || true)" \
  && actual="$(git -C /tmp/src rev-parse HEAD)" \
  && if [ -n "$expected" ] && ! printf '%s\n' "$actual" | grep -q "^${expected}"; then \
       echo "Pinned upstream mismatch: expected ${expected}, got ${actual}" >&2; exit 1; \
     fi \
  && rm -rf /tmp/src \
  && rm -rf /tmp/overlay \
  && echo "Applied oauth overlay" >> /app/.upstream-sha

RUN pnpm install --frozen-lockfile \
  && pnpm build

# -----------------------------------------------------------------------------
# Runtime
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

ARG SOURCE_COMMIT=unknown

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    tini \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROMIUM_PATH=/usr/bin/chromium \
    HOST=0.0.0.0 \
    NITRO_HOST=0.0.0.0 \
    PORT=4141 \
    NITRO_PORT=4141 \
    HOME=/root \
    M365_AUTH_MODE=oauth \
    M365_SECRETS_FILE=/root/.config/opencode-m365/secrets.json \
    M365_CACHE_FILE=/root/.config/opencode-m365/msal-cache.json \
    M365_BROWSER_PROFILE=/root/.config/opencode-m365/browser-profile

WORKDIR /app

COPY --from=builder /app/packages/proxy/.output /app/packages/proxy/.output
COPY --from=builder /app/packages/proxy/bin /app/packages/proxy/bin
COPY --from=builder /app/.upstream-sha /app/.upstream-sha
COPY --from=builder /app/.source-commit /app/.source-commit
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /root/.config/opencode-m365

EXPOSE 4141

# Persist auth under /root/.config/opencode-m365 (bind-mount from host)
VOLUME ["/root/.config/opencode-m365"]

# First boot may wait for /auth OAuth, or Playwright+TOTP in secrets mode.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4141/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

STOPSIGNAL SIGTERM

LABEL org.opencontainers.image.title="M365 Copilot Proxy" \
      org.opencontainers.image.description="OpenAI-compatible HTTP proxy for Microsoft 365 Copilot" \
      org.opencontainers.image.source="https://github.com/drakolordx7/m365-copilot-proxy-docker" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="drakolordx7" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}"

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["4141"]
