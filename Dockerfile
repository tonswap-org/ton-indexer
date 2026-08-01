# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY registry ./registry
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf AS runtime
ENV NODE_ENV=production \
    INDEXER_MODE=production \
    TON_NETWORK=mainnet \
    TON_DATASOURCE=lite \
    LITESERVER_POOL_MAINNET=https://ton.org/global.config.json \
    HOST=0.0.0.0 \
    PORT=8787 \
    TRUST_PROXY=false \
    CORS_ENABLED=true \
    CORS_ALLOW_ORIGIN=* \
    RATE_LIMIT_ENABLED=true \
    RATE_LIMIT_MAX_KEYS=20000 \
    RATE_LIMIT_GLOBAL_WINDOW_MS=60000 \
    RATE_LIMIT_GLOBAL_MAX=50000 \
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8787') + '/api/indexer/v1/health').then(async(response)=>{if(!response.ok)process.exit(1);const body=await response.json();if(body.serviceId!=='ti.soramitsu.io'||body.ecosystem!=='ton'||body.chainId!=='ton:mainnet'||body.network!=='mainnet')process.exit(1)}).catch(()=>process.exit(1))"
CMD ["npm", "start"]
