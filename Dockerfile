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
# Install LibreOffice for .et (WPS Spreadsheet) to .xlsx/.pdf conversion
# Install Chromium + deps for Playwright PDF screenshotting
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    tini \
    libreoffice-calc \
    libreoffice-common \
    chromium \
    chromium-sandbox \
    fonts-liberation \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Set Playwright to use system Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

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
