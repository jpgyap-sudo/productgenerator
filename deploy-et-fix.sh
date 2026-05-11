#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
#  deploy-et-fix.sh
#  Copy-paste into DigitalOcean Droplet Console to deploy .et fix
#
#  What this does:
#    1. Git pull latest changes (commit 8d54d79)
#    2. Install npm packages
#    3. Restart PM2
#    4. Verify health
# ═══════════════════════════════════════════════════════════════════════

set -e
TARGET="/root/productgenerator"

echo "═══════════════════════════════════════════════════════════════"
echo "  Deploying .et upload fix"
echo "  Target: $TARGET"
echo "  Time: $(date)"
echo "═══════════════════════════════════════════════════════════════"

# Step 1: Git pull
echo ""
echo "[1/4] Pulling latest code from GitHub..."
cd "$TARGET"
git pull origin main
echo "  ✓ Git pull complete"

# Step 2: Install dependencies
echo ""
echo "[2/4] Installing npm dependencies..."
npm install exceljs xlsx
echo "  ✓ npm install complete"

# Step 3: Restart PM2
echo ""
echo "[3/4] Restarting PM2..."
pm2 restart product-image-studio
echo "  ✓ PM2 restarted"

# Step 4: Verify
echo ""
echo "[4/4] Verifying health..."
sleep 3
curl -s http://localhost:3000/health
echo ""
echo "  ✓ Health check complete"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Deploy complete!"
echo "═══════════════════════════════════════════════════════════════"
