// ═══════════════════════════════════════════════════════════════════
//  POST /api/queue/save-state
//  Called via navigator.sendBeacon() from the browser's beforeunload
//  handler. Accepts queue items with base64 image data and uploads
//  them to Supabase storage + upserts queue rows so images survive
//  a page reload.
// ═══════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const SUPA_QUEUE_TABLE = process.env.SUPA_QUEUE_TABLE || 'product_queue';
const SUPA_BUCKET = process.env.SUPA_BUCKET || 'product_images';

function dataUrlToBuffer(dataUrl) {
  const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!matches) throw new Error('Invalid data URL');
  return {
    mimeType: matches[1],
    buffer: Buffer.from(matches[2], 'base64')
  };
}

function imageExtension(mimeType) {
  const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' };
  return map[mimeType] || 'jpg';
}

export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse body — sendBeacon sends as text/plain or application/json
  let items;
  try {
    if (typeof req.body === 'string') {
      items = JSON.parse(req.body).items;
    } else if (req.body && Array.isArray(req.body.items)) {
      items = req.body.items;
    } else {
      return res.status(400).json({ error: 'Invalid payload: expected { items: [...] }' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!items || items.length === 0) {
    return res.json({ saved: 0 });
  }

  // Create Supabase client
  let supabase;
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  } catch (e) {
    console.error('[SAVE-STATE] Failed to create Supabase client:', e.message);
    return res.status(500).json({ error: 'Supabase client creation failed' });
  }

  let savedCount = 0;
  const errors = [];

  for (const item of items) {
    try {
      if (!item.dataUrl || !item.dataUrl.startsWith('data:')) {
        continue; // Skip items without base64 data
      }

      const parsed = dataUrlToBuffer(item.dataUrl);
      const ext = imageExtension(parsed.mimeType);
      const fileName = `queue/${item.id}_${Date.now()}.${ext}`;

      // Upload to Supabase storage
      const { error: uploadErr } = await supabase.storage
        .from(SUPA_BUCKET)
        .upload(fileName, parsed.buffer, {
          contentType: parsed.mimeType,
          upsert: true
        });

      if (uploadErr) {
        // Try creating bucket if missing
        if (uploadErr.message && uploadErr.message.includes('bucket')) {
          await supabase.storage.createBucket(SUPA_BUCKET, { public: true });
          const { error: retryErr } = await supabase.storage
            .from(SUPA_BUCKET)
            .upload(fileName, parsed.buffer, {
              contentType: parsed.mimeType,
              upsert: true
            });
          if (retryErr) throw retryErr;
        } else {
          throw uploadErr;
        }
      }

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from(SUPA_BUCKET)
        .getPublicUrl(fileName);

      // Upsert queue row with the image URL
      const { error: upsertErr } = await supabase
        .from(SUPA_QUEUE_TABLE)
        .upsert({
          id: item.id,
          name: item.name || 'Product',
          image_url: publicUrl,
          status: item.status || 'wait',
          description: item.description || '',
          brand: item.brand || '',
          provider: item.provider || 'openai',
          updated_at: new Date().toISOString()
        }, { onConflict: 'id' });

      if (upsertErr) {
        // If column doesn't exist, try without optional columns
        if (upsertErr.message && upsertErr.message.includes('column')) {
          const { error: fallbackErr } = await supabase
            .from(SUPA_QUEUE_TABLE)
            .upsert({
              id: item.id,
              name: item.name || 'Product',
              image_url: publicUrl,
              status: item.status || 'wait',
              updated_at: new Date().toISOString()
            }, { onConflict: 'id' });
          if (fallbackErr) throw fallbackErr;
        } else {
          throw upsertErr;
        }
      }

      savedCount++;
    } catch (err) {
      console.error(`[SAVE-STATE] Failed to save item ${item.id}:`, err.message);
      errors.push({ id: item.id, error: err.message });
    }
  }

  return res.json({
    saved: savedCount,
    total: items.length,
    errors: errors.length > 0 ? errors : undefined
  });
}
