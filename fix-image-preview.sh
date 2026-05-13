#!/bin/bash
# =============================================================================
# Fix Image Preview Script for VPS
# Fixes nginx configuration and verifies vps-assets directory
# =============================================================================

set -e

echo "============================================================================"
echo "  FIX IMAGE PREVIEW - VPS Deployment Script"
echo "============================================================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
NGINX_CONF="/etc/nginx/sites-enabled/render.abcx124.xyz"
NGINX_CONF_AVAILABLE="/etc/nginx/sites-available/render.abcx124.xyz"
HOST_ASSETS_DIR="/root/productgenerator/vps-assets"
APP_DIR="/root/productgenerator"
CONTAINER_NAME="product-studio-backend"

# Function to print status
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    print_error "Please run as root (use sudo)"
    exit 1
fi

# ============================================================================
# STEP 1: Find the correct vps-assets directory
# ============================================================================
echo ""
echo "STEP 1: Locating vps-assets directory..."
echo "----------------------------------------------------------------------------"

# Check if Docker container is running and has vps-assets inside
CONTAINER_ASSETS=""
if docker ps -q --filter name="$CONTAINER_NAME" 2>/dev/null | grep -q .; then
    print_status "Docker container '$CONTAINER_NAME' is running"
    # Check if vps-assets exists inside the container
    if docker exec "$CONTAINER_NAME" test -d /app/vps-assets 2>/dev/null; then
        CONTAINER_ASSETS="/app/vps-assets"
        FILE_COUNT=$(docker exec "$CONTAINER_NAME" find /app/vps-assets -type f 2>/dev/null | wc -l)
        print_status "Found vps-assets inside container with $FILE_COUNT files"
    fi
fi

# Check host path
if [ -d "$HOST_ASSETS_DIR" ]; then
    HOST_FILE_COUNT=$(find "$HOST_ASSETS_DIR" -type f 2>/dev/null | wc -l)
    print_status "Host path $HOST_ASSETS_DIR exists with $HOST_FILE_COUNT files"
    FOUND_DIR="$HOST_ASSETS_DIR"
elif [ -n "$CONTAINER_ASSETS" ]; then
    print_status "Creating host directory $HOST_ASSETS_DIR and copying from container..."
    mkdir -p "$HOST_ASSETS_DIR/renders"
    docker cp "$CONTAINER_NAME:/app/vps-assets/." "$HOST_ASSETS_DIR/"
    print_status "Copied container vps-assets to host"
    FOUND_DIR="$HOST_ASSETS_DIR"
else
    print_warning "vps-assets directory not found"
    print_status "Creating vps-assets directory at $HOST_ASSETS_DIR"
    mkdir -p "$HOST_ASSETS_DIR/renders"
    FOUND_DIR="$HOST_ASSETS_DIR"
fi

# Check if directory has content
if [ -d "$FOUND_DIR/renders" ]; then
    RENDER_COUNT=$(find "$FOUND_DIR/renders" -type f 2>/dev/null | wc -l)
    print_status "Found $RENDER_COUNT render files in $FOUND_DIR/renders"
else
    print_warning "No renders subdirectory found"
    mkdir -p "$FOUND_DIR/renders"
fi

# ============================================================================
# STEP 2: Fix permissions
# ============================================================================
echo ""
echo "STEP 2: Fixing permissions..."
echo "----------------------------------------------------------------------------"

# Make directory readable by nginx (www-data or nginx user)
chmod -R 755 "$FOUND_DIR"
print_status "Set permissions to 755 on $FOUND_DIR"

# Find nginx user
NGINX_USER=$(ps aux | grep nginx | grep -v grep | grep -v root | head -1 | awk '{print $1}')
if [ -z "$NGINX_USER" ]; then
    NGINX_USER="www-data"
fi
print_status "Nginx runs as user: $NGINX_USER"

# Change ownership to allow nginx access
chown -R "$NGINX_USER:$NGINX_USER" "$FOUND_DIR" 2>/dev/null || true
print_status "Ownership set to $NGINX_USER"

# ============================================================================
# STEP 3: Update Nginx Configuration
# ============================================================================
echo ""
echo "STEP 3: Updating Nginx Configuration..."
echo "----------------------------------------------------------------------------"

# Determine which config file to use
if [ -f "$NGINX_CONF" ]; then
    CONFIG_FILE="$NGINX_CONF"
elif [ -f "$NGINX_CONF_AVAILABLE" ]; then
    CONFIG_FILE="$NGINX_CONF_AVAILABLE"
else
    # Find any nginx config for this domain
    CONFIG_FILE=$(find /etc/nginx -name "*render.abcx124.xyz*" -type f 2>/dev/null | head -1)
    if [ -z "$CONFIG_FILE" ]; then
        CONFIG_FILE="/etc/nginx/sites-available/render.abcx124.xyz"
    fi
fi

print_status "Using config file: $CONFIG_FILE"

# Backup existing config
cp "$CONFIG_FILE" "${CONFIG_FILE}.backup.$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true

# Create new nginx config
cat > "$CONFIG_FILE" << 'EOF'
# Product Image Studio — render.abcx124.xyz
server {
    server_name render.abcx124.xyz;

    client_max_body_size 100m;

    # Serve static assets from VPS - FIXED LOCATION
    location /vps-assets/ {
        alias VPS_ASSETS_PATH/;
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
        access_log off;
        
        # Ensure proper MIME types for images
        include /etc/nginx/mime.types;
        
        # Handle CORS for images
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
        
        # Return proper 404 for missing files
        try_files $uri $uri/ =404;
    }

    # Proxy everything to Product Image Studio on port 3002 (Docker)
    location / {
        proxy_pass http://localhost:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        proxy_connect_timeout 300;
        proxy_send_timeout 300;
        proxy_read_timeout 300;
    }

    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/render.abcx124.xyz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/render.abcx124.xyz/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    if ($host = render.abcx124.xyz) {
        return 301 https://$host$request_uri;
    }

    server_name render.abcx124.xyz;

    client_max_body_size 100m;
    listen 80;
    return 404;
}
EOF

# Replace placeholder with actual host path (always use HOST_ASSETS_DIR for nginx)
sed -i "s|VPS_ASSETS_PATH|$HOST_ASSETS_DIR|g" "$CONFIG_FILE"

print_status "Nginx configuration updated (alias -> $HOST_ASSETS_DIR)"

# ============================================================================
# STEP 4: Test and reload nginx
# ============================================================================
echo ""
echo "STEP 4: Testing Nginx Configuration..."
echo "----------------------------------------------------------------------------"

if nginx -t; then
    print_status "Nginx configuration is valid"
    
    echo ""
    echo "Reloading Nginx..."
    systemctl reload nginx || service nginx reload
    print_status "Nginx reloaded successfully"
else
    print_error "Nginx configuration test failed!"
    print_status "Restoring backup..."
    cp "${CONFIG_FILE}.backup."* "$CONFIG_FILE" 2>/dev/null || true
    exit 1
fi

# ============================================================================
# STEP 5: Test image accessibility
# ============================================================================
echo ""
echo "STEP 5: Testing Image Accessibility..."
echo "----------------------------------------------------------------------------"

# Find a test image
TEST_IMAGE=$(find "$FOUND_DIR" -type f \( -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" \) 2>/dev/null | head -1)

if [ -n "$TEST_IMAGE" ]; then
    # Get relative path
    REL_PATH="${TEST_IMAGE#$FOUND_DIR}"
    TEST_URL="https://render.abcx124.xyz/vps-assets$REL_PATH"
    
    print_status "Testing URL: $TEST_URL"
    
    # Test with curl
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$TEST_URL" 2>/dev/null || echo "000")
    
    if [ "$HTTP_CODE" = "200" ]; then
        print_status "✅ Image is now accessible (HTTP 200)"
    else
        print_error "❌ Image returned HTTP $HTTP_CODE"
        print_status "Checking nginx error logs..."
        tail -20 /var/log/nginx/error.log 2>/dev/null || echo "Could not read error log"
    fi
else
    print_warning "No test images found to verify"
fi

# ============================================================================
# STEP 6: Summary
# ============================================================================
echo ""
echo "============================================================================"
echo "  FIX COMPLETE"
echo "============================================================================"
echo ""
echo "Summary:"
echo "  - vps-assets directory: $FOUND_DIR"
echo "  - Nginx config: $CONFIG_FILE"
echo "  - Permissions: 755 (nginx accessible)"
echo ""
echo "Next steps:"
echo "  1. Refresh your browser at https://render.abcx124.xyz/completebatch"
echo "  2. Check if images are now loading"
echo "  3. If still not working, check browser DevTools Network tab"
echo ""
echo "To verify manually:"
echo "  curl -I https://render.abcx124.xyz/vps-assets/renders/item-77/HA-801_img1_Front_view.png"
echo ""
echo "============================================================================"
