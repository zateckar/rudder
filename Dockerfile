# ── Build stage ──────────────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy package files first for layer caching
COPY package.json bun.lock ./

# Install all dependencies (including devDependencies for build)
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build the SvelteKit application
RUN bun run build

# Prune devDependencies after build
RUN bun install --production --frozen-lockfile

# ── Production stage ────────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS production

WORKDIR /app

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

# Start the application
CMD ["bun", "run", "build/index.js"]
