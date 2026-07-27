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

# Override the upstream git ref at build time (branch or tag name).
ARG M365_REF=main
RUN git clone --depth 1 --branch "${M365_REF}" \
      https://github.com/cramt/m365-copilot-proxy.git /tmp/src \
  && cp -a /tmp/src/. /app/ \
  && rm -rf /tmp/src \
  && echo "Built from cramt/m365-copilot-proxy@${M365_REF}" \
  && (git -C /app rev-parse HEAD > /app/.upstream-sha || echo "${M365_REF}" > /app/.upstream-sha)

RUN pnpm install --frozen-lockfile \
  && pnpm build

# -----------------------------------------------------------------------------
# Runtime
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

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
    M365_SECRETS_FILE=/root/.config/opencode-m365/secrets.json \
    M365_CACHE_FILE=/root/.config/opencode-m365/msal-cache.json \
    M365_BROWSER_PROFILE=/root/.config/opencode-m365/browser-profile

WORKDIR /app

COPY --from=builder /app/packages/proxy/.output /app/packages/proxy/.output
COPY --from=builder /app/packages/proxy/bin /app/packages/proxy/bin
COPY --from=builder /app/.upstream-sha /app/.upstream-sha
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /root/.config/opencode-m365

EXPOSE 4141

# Persist auth under /root/.config/opencode-m365 (bind-mount from host)
VOLUME ["/root/.config/opencode-m365"]

# First boot runs Playwright login + MFA; allow plenty of time.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4141/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

STOPSIGNAL SIGTERM

LABEL org.opencontainers.image.title="M365 Copilot Proxy" \
      org.opencontainers.image.description="OpenAI-compatible HTTP proxy for Microsoft 365 Copilot" \
      org.opencontainers.image.source="https://github.com/drakolordx7/m365-copilot-proxy-docker" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="drakolordx7"

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["4141"]
