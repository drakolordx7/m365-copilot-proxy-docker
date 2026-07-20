# m365-copilot-proxy — OpenAI-compatible proxy for Microsoft 365 Copilot
# Upstream: https://github.com/cramt/m365-copilot-proxy
FROM node:24-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app

ARG M365_REF=main
RUN git clone --depth 1 --branch "${M365_REF}" \
      https://github.com/cramt/m365-copilot-proxy.git /tmp/src \
  && cp -a /tmp/src/. /app/ \
  && rm -rf /tmp/src

RUN pnpm install --frozen-lockfile \
  && pnpm build

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
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROMIUM_PATH=/usr/bin/chromium \
    HOST=0.0.0.0 \
    NITRO_HOST=0.0.0.0 \
    PORT=4141 \
    HOME=/root

WORKDIR /app

COPY --from=builder /app/packages/proxy/.output /app/packages/proxy/.output
COPY --from=builder /app/packages/proxy/bin /app/packages/proxy/bin

EXPOSE 4141

# Persist auth under /root/.config/opencode-m365 (bind-mount from host)
VOLUME ["/root/.config/opencode-m365"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4141/v1/models').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "packages/proxy/bin/m365-proxy.mjs", "4141"]
