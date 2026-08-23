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

# Install runtime dependencies
RUN apk add --no-cache openssh-client

# Create non-root user
RUN addgroup -g 1001 -S rudder && \
    adduser -S rudder -u 1001 -G rudder

# Copy built application and dependencies
COPY --from=builder --chown=rudder:rudder /app/build ./build
COPY --from=builder --chown=rudder:rudder /app/node_modules ./node_modules
COPY --from=builder --chown=rudder:rudder /app/package.json ./
# The entry point: adapter-node's own build/index.js cannot serve WebSocket
# upgrades, so the container terminal and `kubectl exec` would hang. server.js
# is that handler plus one `upgrade` listener.
COPY --from=builder --chown=rudder:rudder /app/server.js ./

# drizzle/ is deliberately not copied.  Nothing calls drizzle's migrate() at
# runtime — src/lib/db/index.ts applies the schema itself on startup — and
# drizzle-kit is a devDependency that the production install above prunes, so
# the SQL files would be unusable inside the image.

# Create data directory for SQLite database
RUN mkdir -p /app/data && chown rudder:rudder /app/data

# ── Proxy-aware defaults ─────────────────────────────────────────────────────
# PROTOCOL_HEADER lets the node adapter learn the real scheme from an upstream
# HTTPS proxy, so `secure` session cookies are set correctly.
#
# HOST_HEADER is deliberately NOT set.  Trusting X-Forwarded-Host means the
# request origin — which SvelteKit's CSRF check and the OIDC redirect URL are
# both derived from — is attacker-controlled unless a proxy always overwrites
# that header.  Set ORIGIN to your external URL instead, e.g.
#   ORIGIN=https://rudder.example.com
# Only add HOST_HEADER=X-Forwarded-Host if you serve several hostnames AND a
# trusted proxy strips client-supplied values.
#
# ADDRESS_HEADER is not set here either, for the same reason: a client-supplied
# X-Forwarded-For would let an attacker pick their own rate-limit bucket. But
# because PROTOCOL_HEADER below declares this deployment proxied, every request
# appears to come from the proxy, so the login per-address limit cannot tell
# callers apart — the app detects that from these two variables (never from the
# request, which the caller controls), logs it once, and falls back to the
# per-username limit rather than locking out every user at once. Set
# ADDRESS_HEADER=X-Forwarded-For once your proxy is known to *overwrite* the
# header rather than append to whatever the client sent.
ENV PROTOCOL_HEADER=X-Forwarded-Proto

# The port EXPOSE advertises has to be the one the server actually binds.
# `server.js` reads PORT and falls back to 7244 — the dev-server port — so
# without this the image listened on 7244 while declaring 3000, and a plain
# `docker run -p 3000:3000` reached nothing. It worked only because
# docker-compose.yml sets PORT=3000 itself, which made the image depend on its
# own compose file to be correct.
ENV PORT=3000

# Switch to non-root user
USER rudder

# Expose port
EXPOSE 3000

# Start the application
CMD ["bun", "run", "server.js"]
