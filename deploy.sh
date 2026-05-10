#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  deploy.sh — One-command deploy to VPS
#
#  Usage:
#    ./deploy.sh                    # Deploy to default VPS
#    ./deploy.sh user@host          # Deploy to custom VPS
#    ./deploy.sh user@host /path    # Deploy to custom path
#
#  Prerequisites:
#    - SSH key-based auth to VPS (no password prompt)
#    - rsync installed locally and on VPS
#    - PM2 installed on VPS
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Configuration ──
VPS_USER="${1:-root@104.248.225.250}"
VPS_HOST="${VPS_USER#*@}"
VPS_PATH="${2:-/root/productgenerator}"
SSH_OPTS="-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Product Image Studio — Deploy to VPS${NC}"
echo -e "${GREEN}  Target: ${VPS_USER}:${VPS_PATH}${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"

# ── Step 0: Build frontend locally ──
echo -e "\n${YELLOW}[0/5] Building frontend (furniture-render)...${NC}"
if [ -d "furniture-render/node_modules" ]; then
  (cd furniture-render && npx vite build 2>&1)
  echo -e "${GREEN}  ✓ Frontend built${NC}"
else
  echo -e "${YELLOW}  ⚠ furniture-render/node_modules not found, installing deps first...${NC}"
  (cd furniture-render && npm install && npx vite build 2>&1)
  echo -e "${GREEN}  ✓ Frontend built${NC}"
fi

# ── Step 1: Rsync files (exclude node_modules, logs, .env) ──
echo -e "\n${YELLOW}[1/5] Syncing files to VPS...${NC}"
rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='logs' \
  --exclude='.env' \
  --exclude='.git' \
  --exclude='*.log' \
  --exclude='furniture-render/node_modules' \
  --exclude='furniture-render/src' \
  --exclude='furniture-render/public' \
  -e "ssh ${SSH_OPTS}" \
  ./ "${VPS_USER}:${VPS_PATH}/"

echo -e "${GREEN}  ✓ Files synced${NC}"

# ── Step 2: Install dependencies on VPS ──
echo -e "\n${YELLOW}[2/5] Syncing environment and installing dependencies on VPS...${NC}"
if [ -f "vps-env.txt" ]; then
  scp ${SSH_OPTS} vps-env.txt "${VPS_USER}:${VPS_PATH}/.env" >/dev/null
  ssh ${SSH_OPTS} "${VPS_USER}" "chmod 600 ${VPS_PATH}/.env"
  echo -e "${GREEN}  Synced vps-env.txt to remote .env${NC}"
else
  echo -e "${YELLOW}  No vps-env.txt found; keeping existing remote .env${NC}"
fi
ssh ${SSH_OPTS} "${VPS_USER}" "cd ${VPS_PATH} && npm install --production 2>&1"
echo -e "${GREEN}  ✓ Dependencies installed${NC}"

# ── Step 3: Restart PM2 process ──
echo -e "\n${YELLOW}[3/5] Restarting PM2 process...${NC}"
ssh ${SSH_OPTS} "${VPS_USER}" "cd ${VPS_PATH} && pm2 startOrReload ecosystem.config.cjs --update-env 2>&1"
echo -e "${GREEN}  ✓ PM2 restarted${NC}"

# ── Step 4: Health check ──
echo -e "\n${YELLOW}[4/5] Running health check...${NC}"
sleep 3
HEALTH=$(ssh ${SSH_OPTS} "${VPS_USER}" "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health 2>&1" || echo "failed")

if [ "${HEALTH}" = "200" ]; then
  echo -e "${GREEN}  ✓ Health check passed (HTTP ${HEALTH})${NC}"
  echo -e "\n${GREEN}═══════════════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  Deployment successful!${NC}"
  echo -e "${GREEN}  App is running at https://yourdomain.com${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
else
  echo -e "${RED}  ✗ Health check failed (HTTP ${HEALTH})${NC}"
  echo -e "${YELLOW}  Check logs: ssh ${VPS_USER} 'pm2 logs product-image-studio --lines 20'${NC}"
  exit 1
fi
