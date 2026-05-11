#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
#  deploy-et-fix.sh
#  Copy-paste into DigitalOcean Droplet Console to deploy productgenerator
#
#  What this does:
#    1. Git pull latest changes
#    2. Build Docker container (port 3001 — SuperRoo uses port 3000)
#    3. Verify health
#
#  NOTE: SuperRoo Cloud Dashboard is the primary project on port 3000.
#        Product Image Studio runs on port 3001 via Docker.
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail
# ── Configurable target — change if your VPS uses a different path ──
TARGET="${DEPLOY_TARGET:-/root/productgenerator}"

echo "═══════════════════════════════════════════════════════════════"
echo "  Deploying Product Image Studio (Docker, port 3001)"
echo "  Target: $TARGET"
echo "  Time: $(date)"
echo "═══════════════════════════════════════════════════════════════"

# Step 1: Git pull
echo ""
echo "[1/4] Pulling latest code from GitHub..."
cd "$TARGET"
git fetch origin main
git reset --hard origin/main
echo "  ✓ Git pull complete ($(git log --oneline -1))"

# Step 2: Build frontend (inside container)
echo ""
echo "[2/4] Building Docker image..."
docker compose -f "$TARGET/docker-compose.yml" build --no-cache
echo "  ✓ Docker image built"

# Step 3: Start container
echo ""
echo "[3/4] Starting Docker container..."
# Stop and remove old container if exists
docker stop product-studio-backend 2>/dev/null || true
docker rm product-studio-backend 2>/dev/null || true
docker compose -f "$TARGET/docker-compose.yml" up -d
echo "  ✓ Docker container started"

# Step 4: Verify
echo ""
echo "[4/4] Verifying health..."
sleep 5
curl -s http://localhost:3001/health
echo ""
echo "  ✓ Health check complete"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Deploy complete!"
echo "  App: https://render.abcx124.xyz/studio"
echo "═══════════════════════════════════════════════════════════════"
