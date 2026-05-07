// ═══════════════════════════════════════════════════════════════════
//  POST /api/queue/submit — Express route handler
//  Starts render jobs for each product view.
//
//  VPS ADAPTATION:
//  - Removed waitUntil() — background worker handles processing
//  - Removed VERCEL_URL self-fetch — worker polls Supabase directly
//  - Removed @vercel/functions dependency
//  - Uses Express req/res instead of Vercel (req) => Response
//
//  PROVIDER SUPPORT: Supports 'openai' (default) and 'gemini'.
//  - openai: Uses OpenAI GPT Image 2 API (synchronous)
//  - gemini: Uses Google Gemini API (synchronous)
//  - fal: Deprecated on VPS — use openai or gemini instead
// ═══════════════════════════════════════════════════════════════════
import { supabase, QUEUE_TABLE, RESULTS_TABLE, BUCKET_NAME } from '../../lib/supabase.js';
import { VIEWS } from '../../lib/fal.js';

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!match) return null;
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64')
  };
}

function imageExtension(mimeType) {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  return 'jpg';
}

async function uploadSubmittedImage(itemId, imageData) {
  const parsed = parseDataUrl(imageData);
  if (!parsed) return '';

  const ext = imageExtension(parsed.mimeType);
  const fileName = `queue/${itemId}_${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(fileName, parsed.buffer, {
      contentType: parsed.mimeType,
      upsert: true
    });

  if (error) {
    throw new Error(`Failed to upload queued reference image: ${error.message}`);
  }

  const { data: { publicUrl } } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(fileName);

  return publicUrl;
}

async function upsertSubmittedItems(itemIds, submittedItems, activeProvider, resolution) {
  if (!Array.isArray(submittedItems) || submittedItems.length === 0) return;

  const wantedIds = new Set(itemIds.map(id => Number(id)));
  const now = new Date().toISOString();
  const rows = [];

  for (const submitted of submittedItems) {
    const id = Number(submitted?.id);
    if (!Number.isFinite(id) || !wantedIds.has(id)) continue;

    let imageUrl = submitted.imageUrl || '';
    if (!imageUrl && submitted.imageData) {
      imageUrl = await uploadSubmittedImage(id, submitted.imageData);
    }

    rows.push({
      id,
      name: submitted.name || `Item ${id}`,
      image_url: imageUrl,
      status: 'active',
      sub_text: `Queued for ${activeProvider === 'gemini' ? 'Gemini' : 'OpenAI'} processing...`,
      description: submitted.description || '',
      brand: submitted.brand || '',
      provider: activeProvider,
      resolution: resolution || '1K',
      drive_folder_name: submitted.driveFolderName || '',
      updated_at: now
    });
  }

  if (rows.length === 0) return;

  const { error } = await supabase
    .from(QUEUE_TABLE)
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: false });

  if (error) throw error;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const { itemIds, items: submittedItems, resolution, provider, brands } = body;

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: 'itemIds array is required' });
    }

    // Default to openai if no provider specified
    const activeProvider = provider || 'openai';

    // Validate provider — accept 'openai', 'openai-cheap', 'openai-mini', 'gemini',
    // 'stability', 'stability-cheap', 'stability-mini'
    const isValidProvider = activeProvider === 'gemini'
      || activeProvider === 'openai'
      || activeProvider.startsWith('openai-')
      || activeProvider === 'stability'
      || activeProvider.startsWith('stability-');
    if (!isValidProvider) {
      return res.status(400).json({
        error: `Unsupported provider: "${activeProvider}". Use "openai", "openai-cheap", "openai-mini", "gemini", "stability", "stability-cheap", or "stability-mini".`
      });
    }

    await upsertSubmittedItems(itemIds, submittedItems, activeProvider, resolution);

    const { data: items, error: fetchError } = await supabase
      .from(QUEUE_TABLE)
      .select('*')
      .in('id', itemIds);

    if (fetchError) throw fetchError;
    if (!items || items.length === 0) {
      return res.status(404).json({ error: 'No items found' });
    }

    const now = new Date().toISOString();

    // Mark items as active — the background worker in server.js
    // will pick them up on the next poll cycle
    const { error: updateError } = await supabase
      .from(QUEUE_TABLE)
      .update({
        status: 'active',
        sub_text: `Queued for ${activeProvider === 'gemini' ? 'Gemini' : 'OpenAI'} processing...`,
        provider: activeProvider,
        resolution: resolution || '1K',
        updated_at: now
      })
      .in('id', itemIds);

    if (updateError) throw updateError;

    // Save brand references for items that have them
    if (brands && typeof brands === 'object' && Object.keys(brands).length > 0) {
      for (const itemId of itemIds) {
        const brand = brands[itemId];
        if (brand && brand.trim()) {
          const { error: brandError } = await supabase
            .from(QUEUE_TABLE)
            .update({ brand: brand.trim(), updated_at: now })
            .eq('id', itemId);
          if (brandError) console.warn(`[SUBMIT] Failed to save brand for item ${itemId}:`, brandError.message);
        }
      }
    }

    // Create waiting render result rows for all 4 views
    const resultRows = [];
    for (const item of items) {
      for (const view of VIEWS) {
        resultRows.push({
          queue_item_id: item.id,
          view_id: view.id,
          status: 'waiting',
          image_url: '',
          error_message: '',
          request_id: '',
          response_url: '',
          status_url: '',
          started_at: null,
          completed_at: null,
          created_at: now,
          updated_at: now
        });
      }
    }

    const { error: upsertError } = await supabase
      .from(RESULTS_TABLE)
      .upsert(resultRows, { onConflict: 'queue_item_id,view_id' });

    if (upsertError) throw upsertError;

    console.log(`[SUBMIT] Queued ${items.length} item(s) for ${activeProvider} processing`);

    return res.json({
      success: true,
      message: `Queued ${items.length} item(s) for ${activeProvider} processing`,
      provider: activeProvider,
      items: items.map(item => ({ id: item.id, name: item.name }))
    });

  } catch (error) {
    console.error('[SUBMIT] Error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
