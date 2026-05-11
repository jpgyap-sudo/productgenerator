# ═══════════════════════════════════════════════════════════════════
#  Dockerfile — Product Image Studio Backend
#
#  Multi-stage build:
#    1. Install dependencies (cached layer)
#    2. Run with PM2 via tini (proper signal handling)
#
#  Resource limits are set in docker-compose.yml
# ═══════════════════════════════════════════════════════════════════

FROM node:20-slim AS deps

WORKDIR /app

# Copy only package files first for layer caching
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts

# ── Runtime stage ──
FROM node:20-slim AS runner

WORKDIR /app

# Install tini for proper signal handling (SIGTERM → Node.js)
# Install LibreOffice for .et (WPS Spreadsheet) to .xlsx conversion
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    tini \
    libreoffice-calc \
    libreoffice-common \
    && rm -rf /var/lib/apt/lists/*

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY package.json ecosystem.config.cjs ./
COPY lib/ ./lib/
COPY api/ ./api/
COPY workers/ ./workers/
COPY index.html ./
COPY server.js ./

# Create runtime directories
RUN mkdir -p logs vps-assets

# Use tini as init (reaps zombies, forwards signals)
ENTRYPOINT ["/usr/bin/tini", "--"]

# Run with PM2 in foreground mode (no daemon)
CMD ["npx", "pm2-runtime", "start", "ecosystem.config.cjs", "--env", "production"]
