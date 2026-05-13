#!/bin/bash
# =============================================================================
# Deploy Fix Script - Uploads and executes fix on VPS
# =============================================================================

set -e

# Configuration - UPDATE THESE WITH YOUR VPS DETAILS
VPS_HOST="${VPS_HOST:-render.abcx124.xyz}"
VPS_USER="${VPS_USER:-root}"
SSH_KEY="${SSH_KEY:-~/.ssh/id_rsa}"
REMOTE_DIR="/root/productgenerator"

echo "============================================================================"
echo "  DEPLOY FIX TO VPS"
echo "============================================================================"
echo ""
echo "Configuration:"
echo "  VPS Host: $VPS_HOST"
echo "  VPS User: $VPS_USER"
echo "  Remote Dir: $REMOTE_DIR"
echo ""

# Check if SSH key exists
if [ ! -f "$SSH_KEY" ]; then
    echo "Warning: SSH key not found at $SSH_KEY"
    echo "Trying without key..."
    SSH_OPTS=""
else
    SSH_OPTS="-i $SSH_KEY"
fi

# Test SSH connection
echo "Testing SSH connection..."
if ! ssh $SSH_OPTS -o ConnectTimeout=10 -o StrictHostKeyChecking=no "$VPS_USER@$VPS_HOST" "echo 'SSH OK'" 2>/dev/null; then
    echo "ERROR: Cannot connect to VPS via SSH"
    echo ""
    echo "Please ensure:"
    echo "  1. VPS_HOST is correct in this script"
    echo "  2. You have SSH access to the VPS"
    echo "  3. Your SSH key is added to the VPS"
    echo ""
    echo "Or manually run the fix script on your VPS:"
    echo "  1. Upload fix-image-preview.sh to your VPS"
    echo "  2. Run: sudo bash fix-image-preview.sh"
    exit 1
fi

echo "✅ SSH connection successful"
echo ""

# Upload fix script
echo "Uploading fix script..."
scp $SSH_OPTS -o StrictHostKeyChecking=no fix-image-preview.sh "$VPS_USER@$VPS_HOST:$REMOTE_DIR/"
echo "✅ Upload complete"
echo ""

# Execute fix script on VPS
echo "Executing fix script on VPS..."
echo "----------------------------------------------------------------------------"
ssh $SSH_OPTS -o StrictHostKeyChecking=no "$VPS_USER@$VPS_HOST" "cd $REMOTE_DIR && sudo bash fix-image-preview.sh"

echo ""
echo "============================================================================"
echo "  DEPLOYMENT COMPLETE"
echo "============================================================================"
echo ""
echo "The fix has been applied to your VPS."
echo ""
echo "Please verify by visiting:"
echo "  https://render.abcx124.xyz/completebatch"
echo ""
