#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
#  deploy-et-fix.sh
#  Copy-paste into DigitalOcean Droplet Console to deploy .et fix
#
#  What this does:
#    1. Git pull latest changes (commit 8cbe822 — dedicated .et DropZone)
#    2. Install npm packages (exceljs, xlsx)
#    3. Build frontend
#    4. Restart PM2
#    5. Verify health
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail
# ── Configurable target — change if your VPS uses a different path ──
TARGET="${DEPLOY_TARGET:-/root/productgenerator}"

echo "═══════════════════════════════════════════════════════════════"
echo "  Deploying .et upload fix (dedicated .et DropZone)"
echo "  Target: $TARGET"
echo "  Time: $(date)"
echo "═══════════════════════════════════════════════════════════════"

# Step 1: Git pull
echo ""
echo "[1/5] Pulling latest code from GitHub..."
cd "$TARGET"
git fetch origin main
git reset --hard origin/main
echo "  ✓ Git pull complete ($(git log --oneline -1))"

# Step 2: Install dependencies
echo ""
echo "[2/5] Installing npm dependencies..."
npm install --production exceljs xlsx
echo "  ✓ npm install complete"

# Step 3: Build frontend
echo ""
echo "[3/5] Building frontend..."
if [ -d "$TARGET/furniture-render/node_modules" ]; then
  cd "$TARGET/furniture-render"
  npx vite build
  cd "$TARGET"
  echo "  ✓ Frontend built"
else
  echo "  ⚠ furniture-render/node_modules not found, installing deps first..."
  cd "$TARGET/furniture-render"
  npm install && npx vite build
  cd "$TARGET"
  echo "  ✓ Frontend built (with fresh deps)"
fi

# Step 4: Restart PM2
echo ""
echo "[4/5] Restarting PM2..."
pm2 restart product-image-studio
echo "  ✓ PM2 restarted"

# Step 5: Verify
echo ""
echo "[5/5] Verifying health..."
sleep 3
curl -s http://localhost:3000/health
echo ""
echo "  ✓ Health check complete"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Deploy complete!"
echo "  App: https://render.abcx124.xyz"
echo "═══════════════════════════════════════════════════════════════"
