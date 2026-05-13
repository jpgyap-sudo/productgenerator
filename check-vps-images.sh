#!/bin/bash
# =============================================================================
# Check VPS Images - Verify images exist and are accessible
# =============================================================================

set -e

echo "============================================================================"
echo "  CHECK VPS IMAGES"
echo "============================================================================"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Find vps-assets directory
VPS_ASSETS_DIR=""
POSSIBLE_DIRS=(
    "/root/productgenerator/vps-assets"
    "/var/www/productgenerator/vps-assets"
    "/app/vps-assets"
    "./vps-assets"
)

for dir in "${POSSIBLE_DIRS[@]}"; do
    if [ -d "$dir" ]; then
        VPS_ASSETS_DIR="$dir"
        break
    fi
done

if [ -z "$VPS_ASSETS_DIR" ]; then
    VPS_ASSETS_DIR=$(find / -type d -name "vps-assets" 2>/dev/null | head -1)
fi

if [ -z "$VPS_ASSETS_DIR" ]; then
    echo -e "${RED}ERROR: vps-assets directory not found!${NC}"
    exit 1
fi

echo "Found vps-assets at: $VPS_ASSETS_DIR"
echo ""

# Check directory structure
echo "Directory Structure:"
echo "----------------------------------------------------------------------------"
ls -la "$VPS_ASSETS_DIR"
echo ""

# Count renders
if [ -d "$VPS_ASSETS_DIR/renders" ]; then
    RENDER_DIRS=$(find "$VPS_ASSETS_DIR/renders" -type d -name "item-*" | wc -l)
    RENDER_FILES=$(find "$VPS_ASSETS_DIR/renders" -type f \( -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" \) | wc -l)
    
    echo "Render Statistics:"
    echo "----------------------------------------------------------------------------"
    echo "  Item directories: $RENDER_DIRS"
    echo "  Image files: $RENDER_FILES"
    echo ""
    
    # Show sample images
    if [ "$RENDER_FILES" -gt 0 ]; then
        echo "Sample Images (first 10):"
        echo "----------------------------------------------------------------------------"
        find "$VPS_ASSETS_DIR/renders" -type f \( -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" \) | head -10 | while read -r file; do
            SIZE=$(du -h "$file" | cut -f1)
            echo "  $file ($SIZE)"
        done
        echo ""
    fi
else
    echo -e "${RED}WARNING: No renders directory found!${NC}"
fi

# Check permissions
echo "Permissions:"
echo "----------------------------------------------------------------------------"
echo -n "  Directory permissions: "
ls -ld "$VPS_ASSETS_DIR" | awk '{print $1, $3, $4}'

echo -n "  Nginx user: "
NGINX_USER=$(ps aux | grep "nginx:" | grep -v grep | grep -v root | head -1 | awk '{print $1}')
if [ -z "$NGINX_USER" ]; then
    echo -e "${YELLOW}not detected${NC}"
else
    echo "$NGINX_USER"
fi

# Test nginx config
echo ""
echo "Nginx Configuration:"
echo "----------------------------------------------------------------------------"
if nginx -t 2>&1 | grep -q "successful"; then
    echo -e "  ${GREEN}✓ Configuration valid${NC}"
else
    echo -e "  ${RED}✗ Configuration has errors${NC}"
    nginx -t
fi

# Check if vps-assets location exists in nginx config
echo ""
echo "Nginx vps-assets location:"
echo "----------------------------------------------------------------------------"
NGINX_CONF=$(find /etc/nginx -name "*render.abcx124.xyz*" -type f 2>/dev/null | head -1)
if [ -n "$NGINX_CONF" ]; then
    if grep -q "location /vps-assets/" "$NGINX_CONF" 2>/dev/null; then
        echo -e "  ${GREEN}✓ vps-assets location found in nginx config${NC}"
        grep -A5 "location /vps-assets/" "$NGINX_CONF" | head -6
    else
        echo -e "  ${RED}✗ vps-assets location NOT found in nginx config${NC}"
    fi
else
    echo -e "  ${RED}✗ Nginx config not found${NC}"
fi

# Test HTTP access
echo ""
echo "HTTP Accessibility Test:"
echo "----------------------------------------------------------------------------"
TEST_URL="https://render.abcx124.xyz/vps-assets/"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$TEST_URL" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "403" ]; then
    echo -e "  ${GREEN}✓ vps-assets directory is accessible (HTTP $HTTP_CODE)${NC}"
else
    echo -e "  ${RED}✗ vps-assets directory returned HTTP $HTTP_CODE${NC}"
fi

# Test a specific image if available
SAMPLE_IMAGE=$(find "$VPS_ASSETS_DIR" -type f \( -name "*.png" -o -name "*.jpg" \) 2>/dev/null | head -1)
if [ -n "$SAMPLE_IMAGE" ]; then
    REL_PATH="${SAMPLE_IMAGE#$VPS_ASSETS_DIR}"
    IMAGE_URL="https://render.abcx124.xyz/vps-assets$REL_PATH"
    
    echo ""
    echo "Sample Image Test:"
    echo "----------------------------------------------------------------------------"
    echo "  Local path: $SAMPLE_IMAGE"
    echo "  URL: $IMAGE_URL"
    
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$IMAGE_URL" 2>/dev/null || echo "000")
    CONTENT_TYPE=$(curl -s -o /dev/null -w "%{content_type}" "$IMAGE_URL" 2>/dev/null || echo "unknown")
    
    if [ "$HTTP_CODE" = "200" ]; then
        echo -e "  ${GREEN}✓ Image accessible (HTTP 200, $CONTENT_TYPE)${NC}"
    else
        echo -e "  ${RED}✗ Image returned HTTP $HTTP_CODE${NC}"
    fi
fi

echo ""
echo "============================================================================"
