#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  vps-setup.sh — One-command VPS backend setup (Docker edition)
#
#  Installs Docker + Docker Compose, creates the project directory,
#  and sets up the container with resource limits so the app is
#  isolated from other services on the same VPS.
#
#  Usage (as root or with sudo):
#    sudo bash vps-setup.sh
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Configuration ──
TEMP_USER="tempadmin"
TEMP_PASS="ProductGenerator123!"        # ← CHANGE THIS
VPS_IP="104.248.225.250"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Product Image Studio — VPS Backend Setup (Docker)${NC}"
echo -e "${GREEN}  Target: ${VPS_IP}${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"

# ── Step 1: System update ──
echo -e "\n${YELLOW}[1/8] Updating system packages...${NC}"
apt-get update -qq && apt-get upgrade -y -qq
echo -e "${GREEN}  ✓ System updated${NC}"

# ── Step 2: Install LibreOffice (for .et spreadsheet image extraction) ──
echo -e "\n${YELLOW}[2/8] Installing LibreOffice (for .et file conversion)...${NC}"
if command -v soffice &>/dev/null; then
  echo "  LibreOffice already installed: $(soffice --version | head -1)"
else
  apt-get install -y -qq --no-install-recommends libreoffice-calc libreoffice-common
  echo -e "${GREEN}  ✓ LibreOffice installed: $(soffice --version | head -1)${NC}"
fi

# ── Step 3: Install Docker ──
echo -e "\n${YELLOW}[3/8] Installing Docker...${NC}"
if command -v docker &>/dev/null; then
  echo "  Docker already installed: $(docker --version)"
else
  curl -fsSL https://get.docker.com | bash
  echo -e "${GREEN}  ✓ Docker installed: $(docker --version)${NC}"
fi

# ── Step 4: Install Docker Compose plugin ──
echo -e "\n${YELLOW}[4/8] Installing Docker Compose...${NC}"
if docker compose version &>/dev/null; then
  echo "  Docker Compose already installed: $(docker compose version)"
else
  apt-get install -y -qq docker-compose-plugin
  echo -e "${GREEN}  ✓ Docker Compose installed: $(docker compose version)${NC}"
fi

# ── Step 5: Create temp admin user ──
echo -e "\n${YELLOW}[5/8] Creating temporary admin user...${NC}"
if id "${TEMP_USER}" &>/dev/null; then
  echo "  User ${TEMP_USER} already exists"
else
  useradd -m -s /bin/bash "${TEMP_USER}"
  echo "${TEMP_USER}:${TEMP_PASS}" | chpasswd
  usermod -aG docker "${TEMP_USER}"
  usermod -aG sudo "${TEMP_USER}"
  echo -e "${GREEN}  ✓ Temp user '${TEMP_USER}' created (with docker group)${NC}"
  echo -e "${YELLOW}  ⚠  Password: ${TEMP_PASS}${NC}"
fi

# ── Step 6: Create project directory ──
echo -e "\n${YELLOW}[6/8] Creating project directory...${NC}"
mkdir -p /home/superroo/productgenerator
chmod 755 /home/superroo
echo -e "${GREEN}  ✓ Directory created at /home/superroo/productgenerator${NC}"

# ── Step 7: Open firewall port ──
echo -e "\n${YELLOW}[7/8] Opening port 3000 in firewall...${NC}"
if command -v ufw &>/dev/null; then
  ufw allow 3000/tcp 2>/dev/null && echo -e "${GREEN}  ✓ Port 3000 opened${NC}" || echo -e "  ${YELLOW}UFW not active, skipping${NC}"
else
  echo -e "  ${YELLOW}UFW not installed, skipping firewall config${NC}"
fi

# ── Step 8: Enable Docker on boot ──
echo -e "\n${YELLOW}[8/8] Enabling Docker on boot...${NC}"
systemctl enable docker 2>/dev/null || true
echo -e "${GREEN}  ✓ Docker auto-start enabled${NC}"

# ── Summary ──
echo -e "\n${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  VPS Setup Complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${YELLOW}Next steps (I will do these for you):${NC}"
echo -e "  1. SSH into this VPS as ${TEMP_USER}"
echo -e "  2. Copy project files to /home/superroo/productgenerator/"
echo -e "  3. Create .env file with your API keys"
echo -e "  4. Run: docker compose build"
echo -e "  5. Run: docker compose up -d"
echo ""
echo -e "  ${YELLOW}Container resource limits:${NC}"
echo -e "    CPU:    0.5 cores (50%)"
echo -e "    Memory: 512MB max / 384MB reserved"
echo -e "    Restart: unless-stopped"
echo ""
echo -e "  ${YELLOW}Temp user credentials:${NC}"
echo -e "    Username: ${TEMP_USER}"
echo -e "    Password: ${TEMP_PASS}"
echo -e "    IP:       ${VPS_IP}"
echo ""
echo -e "  ${RED}⚠  IMPORTANT: Delete the temp user after setup:${NC}"
echo -e "    sudo userdel -r ${TEMP_USER}"
echo ""
