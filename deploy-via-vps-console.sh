#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
#  deploy-via-vps-console.sh
#  SINGLE COPY-PASTE COMMAND for DigitalOcean web console
#
#  What this does:
#    1. Adds 2 new import lines to server.js
#    2. Adds 2 new route blocks to server.js
#    3. Creates save-matched-permanent.js
#    4. Creates matched-images-permanent.js
#    5. Restarts PM2 & Caddy
#    6. Verifies everything
#
#  Usage: copy-paste the ENTIRE script into DigitalOcean Droplet Console
# ═══════════════════════════════════════════════════════════════════════

set -e
TARGET="/root/productgenerator"
API_DIR="$TARGET/api/agent"

echo "═══════════════════════════════════════════════════════════════"
echo "  Deploying Product Image Studio updates"
echo "  Target: $TARGET"
echo "  Time: $(date)"
echo "═══════════════════════════════════════════════════════════════"

mkdir -p "$API_DIR"

# ═══════════════════════════════════════════════════════════════════
#  STEP 1: Add imports to server.js
# ═══════════════════════════════════════════════════════════════════
echo ""
echo "[1/5] Adding new imports to server.js..."

if grep -q "save-matched-permanent" "$TARGET/server.js" 2>/dev/null; then
  echo "  ✓ Imports already present, skipping"
else
  # Find the matched-images import line and add 2 new imports after it
  LINE=$(grep -n "matched-images.js" "$TARGET/server.js" | grep "import" | tail -1 | cut -d: -f1)
  if [ -n "$LINE" ]; then
    sed -i "${LINE}a\\
import agentSaveMatchedPermanentHandler from './api/agent/save-matched-permanent.js';\\
import agentMatchedImagesPermanentHandler from './api/agent/matched-images-permanent.js';" "$TARGET/server.js"
    echo "  ✓ Imports added after line $LINE"
  else
    echo "  ✗ Could not find import anchor line"
    exit 1
  fi
fi

# ═══════════════════════════════════════════════════════════════════
#  STEP 2: Add routes to server.js
# ═══════════════════════════════════════════════════════════════════
echo ""
echo "[2/5] Adding new routes to server.js..."

if grep -q "save-matched-permanent" "$TARGET/server.js" 2>/dev/null | grep -q "app.post" 2>/dev/null; then
  echo "  ✓ Routes already present, skipping"
else
  # Find the closing }); of the matched-images GET route
  # Pattern: app.get('/api/agent/matched-images'
  START_LINE=$(grep -n "app.get.*matched-images" "$TARGET/server.js" | grep -v "permanent" | head -1 | cut -d: -f1)
  if [ -n "$START_LINE" ]; then
    # Find the next }); after START_LINE (the closing of the route handler)
    # Read from START_LINE onwards, find first line matching ^});
    TAIL=$(tail -n +$START_LINE "$TARGET/server.js" | grep -n "^\s*});" | head -1 | cut -d: -f1)
    INSERT_AFTER=$((START_LINE + TAIL - 1))
    
    # Create a temp file with the new routes
    cat > /tmp/new_routes.txt << 'ROUTES'
// ── Permanent Canvas Routes ──
app.post('/api/agent/save-matched-permanent', async (req, res) => {
  try {
    const result = await agentSaveMatchedPermanentHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[SAVE-MATCHED-PERMANENT] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get('/api/agent/matched-images-permanent', async (req, res) => {
  try {
    const result = await agentMatchedImagesPermanentHandler(req, res);
    if (!res.headersSent) res.json(result);
  } catch (err) {
    console.error('[MATCHED-IMAGES-PERMANENT] Error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});
ROUTES
    
    # Insert the routes file after INSERT_AFTER
    sed -i "${INSERT_AFTER}r /tmp/new_routes.txt" "$TARGET/server.js"
    rm -f /tmp/new_routes.txt
    echo "  ✓ Routes added after line $INSERT_AFTER"
  else
    echo "  ✗ Could not find route anchor line"
    exit 1
  fi
fi

# ═══════════════════════════════════════════════════════════════════
#  STEP 3: Create save-matched-permanent.js
# ═══════════════════════════════════════════════════════════════════
echo ""
echo "[3/5] Creating save-matched-permanent.js..."
cat > "$API_DIR/save-matched-permanent.js" << 'SAVEPERM'
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config({ override: true });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function normalize(value = '') {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function buildDuplicateNotices(existingRows, payload, imageHash) {
  const notices = [];
  const productCode = normalize(payload.productCode);
  const imageName = normalize(payload.imageName);

  for (const row of existingRows || []) {
    if (productCode && normalize(row.product_code) === productCode) {
      notices.push({
        type: 'product-code',
        message: `Duplicate product code detected: ${payload.productCode} was already saved on ${row.saved_at}.`,
        matchedCanvasId: String(row.id),
        matchedAt: row.saved_at
      });
    }
    if (imageName && normalize(row.image_name) === imageName) {
      notices.push({
        type: 'image-filename',
        message: `Duplicate source image detected: ${payload.imageName} is already linked to ${row.product_code}.`,
        matchedCanvasId: String(row.id),
        matchedAt: row.saved_at
      });
    }
    if (imageHash && row.image_hash === imageHash) {
      notices.push({
        type: 'visual-hash',
        message: 'Replicate image detected: this image hash already exists in the Image Canvas.',
        matchedCanvasId: String(row.id),
        matchedAt: row.saved_at
      });
    }
  }
  return notices;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body;
    const now = new Date().toISOString();
    const imageHash = crypto
      .createHash('sha256')
      .update(`${payload.imageName}|${payload.imageWidth}|${payload.imageHeight}|${payload.imageSizeKb}|${payload.imageUrl || ''}`)
      .digest('hex');

    const { data: existingRows, error: lookupError } = await supabase
      .from('matched_images')
      .select('id, product_code, image_name, image_hash, saved_at')
      .or(`product_code.eq.${payload.productCode},image_name.eq.${payload.imageName},image_hash.eq.${imageHash}`);

    if (lookupError) throw lookupError;

    const duplicateNotices = buildDuplicateNotices(existingRows, payload, imageHash);
    const duplicateText = duplicateNotices.length
      ? `\n\n⚠ Duplicate / replicate notices:\n${duplicateNotices.map((n) => `- ${n.message}`).join('\n')}`
      : '';

    const row = {
      product_name: payload.productName,
      product_brand: payload.productBrand,
      product_code: payload.productCode,
      category: 'Dining Chair',
      description: `${payload.description || ''}${duplicateText}`,
      original_description: payload.description || '',
      image_url: payload.imageUrl,
      image_name: payload.imageName,
      image_width: payload.imageWidth || 0,
      image_height: payload.imageHeight || 0,
      image_size: payload.imageSizeKb || 0,
      image_hash: imageHash,
      match_score: payload.matchScore || 0,
      match_type: payload.matchType || '',
      source_batch: payload.sourceBatch || 'dining-chair-matching-ui',
      source_pdf: payload.sourcePdf || '',
      source_zip: payload.sourceZip || '',
      duplicate_notices: duplicateNotices,
      saved_at: now,
      updated_at: now
    };

    const { data, error } = await supabase.from('matched_images').insert(row).select('*').single();
    if (error) throw error;

    return res.status(200).json({ success: true, record: data, duplicateNotices });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to save permanent canvas record' });
  }
}
SAVEPERM
echo "  ✓ save-matched-permanent.js ($(wc -c < "$API_DIR/save-matched-permanent.js") bytes)"

# ═══════════════════════════════════════════════════════════════════
#  STEP 4: Create matched-images-permanent.js
# ═══════════════════════════════════════════════════════════════════
echo ""
echo "[4/5] Creating matched-images-permanent.js..."
cat > "$API_DIR/matched-images-permanent.js" << 'GETPERM'
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ override: true });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const limit = Number(req.query.limit || 100);
  const search = String(req.query.search || '').trim();

  let query = supabase
    .from('matched_images')
    .select('*')
    .eq('category', 'Dining Chair')
    .order('saved_at', { ascending: false })
    .limit(limit);

  if (search) {
    query = query.or(`product_name.ilike.%${search}%,product_code.ilike.%${search}%,product_brand.ilike.%${search}%,image_name.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ success: true, records: data });
}
GETPERM
echo "  ✓ matched-images-permanent.js ($(wc -c < "$API_DIR/matched-images-permanent.js") bytes)"

# ═══════════════════════════════════════════════════════════════════
#  STEP 5: Restart PM2
# ═══════════════════════════════════════════════════════════════════
echo ""
echo "[5/5] Restarting PM2..."
pm2 restart all 2>&1 || pm2 start ecosystem.config.cjs 2>&1 || pm2 start server.js --name product-image-studio 2>&1
sleep 3

# ═══════════════════════════════════════════════════════════════════
#  STEP 6: Ensure Caddy is running
# ═══════════════════════════════════════════════════════════════════
echo ""
echo "Ensuring Caddy is running..."
systemctl start caddy 2>/dev/null || caddy start 2>/dev/null || echo "  (Caddy start skipped - may need manual start)"
sleep 1

# ═══════════════════════════════════════════════════════════════════
#  VERIFICATION
# ═══════════════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Verification"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "PM2 status:"
pm2 list 2>&1
echo ""
echo "Health check:"
curl -s http://localhost:3000/health 2>&1 || echo "(server not responding yet - may need a moment)"
echo ""
echo "POST /api/agent/save-matched-permanent:"
curl -s -X POST http://localhost:3000/api/agent/save-matched-permanent \
  -H "Content-Type: application/json" \
  -d '{"test":true}' 2>&1 || echo "(server not responding)"
echo ""
echo "GET /api/agent/matched-images-permanent:"
curl -s "http://localhost:3000/api/agent/matched-images-permanent?limit=3" 2>&1 || echo "(server not responding)"
echo ""
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Deployment complete!"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Visit: https://render.abcx124.xyz"
echo "  Look for the 🪑 Chair Match button in the topbar"
echo ""
echo "  If Chair Match UI is missing, deploy index.html from your local machine:"
echo "    scp index.html root@104.248.225.250:/root/productgenerator/index.html"
echo "    ssh root@104.248.225.250 \"pm2 restart all\""
