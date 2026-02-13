# Minted Bridge - Dockerfile
# Multi-stage build for minimal production image
# FIX H-14: Missing Dockerfile referenced by docker-compose.yml
#
# INFRA-H-05: Pin to SHA256 digest for supply-chain security
# To update, run:
#   docker pull node:20-alpine && docker inspect --format='{{index .RepoDigests 0}}' node:20-alpine
# Last verified: node:20-alpine = 20.19.2-alpine3.21

# Build stage
FROM node:20-alpine@sha256:2d07b7c085e1dcbee344e12f4e93a5dab2e85e567a4386edbe3ce24a06e3b96c AS builder

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json* ./

# Install all dependencies (including devDependencies for build)
RUN npm ci --legacy-peer-deps

# Copy source files
COPY *.ts ./
COPY tsconfig.json* ./

# Build TypeScript
RUN npm run build

# Production stage — same pinned digest as builder
FROM node:20-alpine@sha256:2d07b7c085e1dcbee344e12f4e93a5dab2e85e567a4386edbe3ce24a06e3b96c AS production

# Security: run as non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copy package files and install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist

# Security: switch to non-root user
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Default command (overridden by docker-compose)
CMD ["node", "dist/relay-service.js"]
