# Minted Bridge - Dockerfile
# Multi-stage build for minimal production image
# FIX H-14: Missing Dockerfile referenced by docker-compose.yml
#
# FIX IF-H01: Images now pinned to SHA256 digests for supply chain security
# To update, run: docker pull node:20-alpine && docker inspect --format='{{index .RepoDigests 0}}' node:20-alpine

# Build stage
# FIX IF-H01: Pinned to SHA256 digest
FROM node:20-alpine@sha256:c5c1515721ff771df0b4f04e802e90f9c70aa179858b4eb0f4b18bb97ab54bc3 AS builder

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

# Production stage
# FIX IF-H01: Pinned to SHA256 digest
FROM node:20-alpine@sha256:c5c1515721ff771df0b4f04e802e90f9c70aa179858b4eb0f4b18bb97ab54bc3 AS production

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
