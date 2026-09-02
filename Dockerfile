FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN npm install -g pnpm@10.32.1

COPY . .

RUN pnpm install
RUN pnpm build

FROM node:22-bookworm-slim AS runner

WORKDIR /app

COPY --from=builder /app/packages/proxy/.output /app/.output
COPY entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh

ENV PORT=4141
ENV M365_NO_INTERACTIVE=1
EXPOSE 4141

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "/app/.output/server/index.mjs"]
