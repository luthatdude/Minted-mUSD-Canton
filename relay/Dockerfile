# syntax=docker/dockerfile:1
# INFRA-M-13: BuildKit syntax directive required for --mount=type=secret support.
# Build with: DOCKER_BUILDKIT=1 docker build ...
# or: docker buildx build ...
#
# Minted Bridge - Dockerfile
# Multi-stage build for minimal production image
# FIX H-14: Missing Dockerfile referenced by docker-compose.yml
#
# INFRA-H-05: Pin to SHA256 digest for supply-chain security
# To update, run:
#   docker pull node:20-alpine && docker inspect --format='{{index .RepoDigests 0}}' node:20-alpine
# Last verified: node:20-alpine = 20.20-alpine3.23
#
# INFRA-M-13: Secret handling policy:
# - NEVER use ARG or ENV for secrets (they persist in Docker layer cache).
# - Use --mount=type=secret for build-time secrets (e.g., private npm registry tokens).
# - Example: RUN --mount=type=secret,id=npm_token,target=/root/.npmrc npm ci
# - Pass secrets at build time: docker build --secret id=npm_token,src=.npmrc .

# Build stage
FROM node:20-alpine@sha256:09e2b3d9726018aecf269bd35325f46bf75046a643a66d28360ec71132750ec8 AS builder

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json* ./

# Install all dependencies (including devDependencies for build)
# INFRA-M-13: If using a private npm registry, pass the .npmrc as a BuildKit secret:
#   docker build --secret id=npmrc,src=$HOME/.npmrc .
# The secret is only available during this RUN step and never persisted in image layers.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    npm ci --legacy-peer-deps

# Copy source files
COPY *.ts ./
COPY tsconfig.json* ./

# Build TypeScript
RUN npm run build

# Production stage — same pinned digest as builder
FROM node:20-alpine@sha256:09e2b3d9726018aecf269bd35325f46bf75046a643a66d28360ec71132750ec8 AS production

# Security: run as non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copy package files and install production dependencies only
COPY package.json package-lock.json* ./
# INFRA-M-13: Use BuildKit secret mount for private registry auth (if applicable)
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    npm ci --omit=dev --legacy-peer-deps && npm cache clean --force

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist

# Security: switch to non-root user
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

EXPOSE 8080

# Default command (overridden by docker-compose)
CMD ["node", "dist/relay-service.js"]
