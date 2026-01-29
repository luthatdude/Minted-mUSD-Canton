# Minted Bridge - Dockerfile
# Multi-stage build for minimal production image
# FIX H-14: Missing Dockerfile referenced by docker-compose.yml

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json* ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source files
COPY *.ts ./
COPY tsconfig.json* ./

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

# Security: run as non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copy package files and install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist

# Security: switch to non-root user
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Default command (overridden by docker-compose)
CMD ["node", "dist/relay-service.js"]
