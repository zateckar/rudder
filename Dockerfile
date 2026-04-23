# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Copy package files first for layer caching
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build the SvelteKit application
RUN npm run build

# Prune devDependencies after build
RUN npm prune --omit=dev

# ── Production stage ────────────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

# Install runtime dependencies for native modules
RUN apk add --no-cache libstdc++

# Create non-root user
RUN addgroup -g 1001 -S rudder && \
    adduser -S rudder -u 1001 -G rudder

# Copy built application and dependencies
COPY --from=builder --chown=rudder:rudder /app/build ./build
COPY --from=builder --chown=rudder:rudder /app/node_modules ./node_modules
COPY --from=builder --chown=rudder:rudder /app/package.json ./

# Create data directory for SQLite database
RUN mkdir -p /app/data && chown rudder:rudder /app/data

# Switch to non-root user
USER rudder

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start the application
CMD ["node", "build/index.js"]
