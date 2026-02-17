# syntax=docker/dockerfile:1
# Minted Liquidation Bot — Multi-stage Dockerfile
#
# Services: liquidation bot, oracle keeper, fluid rebalancer, yield scanner
# Build: DOCKER_BUILDKIT=1 docker build -t minted-bot .
#
# INFRA-M-13: Secret handling:
# - NEVER use ARG/ENV for secrets (persist in Docker layer cache)
# - Use --mount=type=secret for build-time secrets
# - Runtime secrets via /run/secrets (Docker/K8s)

# ── Build stage ──────────────────────────────────────────────
# Pin to SHA256 digest for supply-chain security
FROM node:20-alpine@sha256:09e2b3d9726018aecf269bd35325f46bf75046a643a66d28360ec71132750ec8 AS builder

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json* ./

# Install all dependencies (including devDeps for tsc)
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    npm ci --legacy-peer-deps

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# ── Production stage ─────────────────────────────────────────
FROM node:20-alpine@sha256:09e2b3d9726018aecf269bd35325f46bf75046a643a66d28360ec71132750ec8 AS production

# Security: run as non-root
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Production dependencies only
COPY package.json package-lock.json* ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    npm ci --omit=dev --legacy-peer-deps && npm cache clean --force

# Copy built artifacts
COPY --from=builder /app/dist ./dist

# Switch to non-root user
USER appuser

# Health check — hits the bot's /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "const http = require('http'); const port = process.env.BOT_PORT || 8080; http.get('http://localhost:' + port + '/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

EXPOSE 8080

# Default: liquidation bot. Override in docker-compose / K8s for other services.
CMD ["node", "dist/index.js"]
