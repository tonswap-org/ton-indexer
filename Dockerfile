# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY registry ./registry
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    INDEXER_MODE=production \
    TON_NETWORK=mainnet \
    TON_DATASOURCE=lite \
    LITESERVER_POOL_MAINNET=https://ton.org/global.config.json \
    HOST=0.0.0.0 \
    PORT=8787 \
    TRUST_PROXY=true \
    CORS_ENABLED=true \
    CORS_ALLOW_ORIGIN=* \
    RATE_LIMIT_ENABLED=true \
    RESPONSE_CACHE_ENABLED=true \
    INDEXER_ENABLE_WRITE_RPC=false \
    LOG_LEVEL=info
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/package-lock.json ./package-lock.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/registry ./registry
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8787') + '/api/indexer/v1/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"
CMD ["npm", "start"]
