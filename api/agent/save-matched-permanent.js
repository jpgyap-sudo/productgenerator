import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config({ override: true });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket }
});

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
