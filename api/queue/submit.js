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

function providerLabel(provider) {
  if (provider === 'gemini') return 'Gemini';
  if (String(provider || '').startsWith('stability')) return 'Stability AI';
  return 'OpenAI';
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

function getMissingSchemaColumn(error) {
  const message = String(error?.message || '');
  const match = message.match(/'([^']+)' column/i);
  return match ? match[1] : '';
}

function isSchemaCacheColumnError(error) {
  return error?.code === 'PGRST204' || /schema cache/i.test(String(error?.message || ''));
}

async function upsertQueueRows(rows) {
  let currentRows = rows;
  const strippedColumns = [];

  for (let attempt = 0; attempt < 6; attempt++) {
    const { error } = await supabase
      .from(QUEUE_TABLE)
      .upsert(currentRows, { onConflict: 'id', ignoreDuplicates: false });

    if (!error) {
      if (strippedColumns.length > 0) {
        console.warn(`[SUBMIT] Queued without optional columns missing from product_queue: ${strippedColumns.join(', ')}`);
      }
      return;
    }

    const missingColumn = getMissingSchemaColumn(error);
    if (!isSchemaCacheColumnError(error) || !missingColumn) throw error;

    strippedColumns.push(missingColumn);
    currentRows = currentRows.map(row => {
      const next = { ...row };
      delete next[missingColumn];
      return next;
    });
  }

  throw new Error('Could not upsert queue rows after removing missing schema-cache columns');
}

async function updateQueueItems(itemIds, values) {
  let currentValues = { ...values };
  const strippedColumns = [];

  for (let attempt = 0; attempt < 6; attempt++) {
    const { error } = await supabase
      .from(QUEUE_TABLE)
      .update(currentValues)
      .in('id', itemIds);

    if (!error) {
      if (strippedColumns.length > 0) {
        console.warn(`[SUBMIT] Updated queue without optional columns missing from product_queue: ${strippedColumns.join(', ')}`);
      }
      return;
    }

    const missingColumn = getMissingSchemaColumn(error);
    if (!isSchemaCacheColumnError(error) || !missingColumn) throw error;

    strippedColumns.push(missingColumn);
    delete currentValues[missingColumn];
  }

  throw new Error('Could not update queue rows after removing missing schema-cache columns');
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

    const row = {
      id,
      name: submitted.name || `Item ${id}`,
      status: 'active',
      sub_text: `Queued for ${providerLabel(activeProvider)} processing...`,
      description: submitted.description || '',
      brand: submitted.brand || '',
      provider: activeProvider,
      resolution: resolution || '1K',
      drive_folder_name: submitted.driveFolderName || '',
      updated_at: now
    };

    // Do not overwrite an existing queued image with an empty value. A missing
    // reference image is rejected after the upsert once existing DB rows are
    // loaded, so new bad submissions fail loudly instead of rendering 0/4.
    if (imageUrl) row.image_url = imageUrl;

    rows.push(row);
  }

  if (rows.length === 0) return;

  await upsertQueueRows(rows);
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

    // Default to the fixed render architecture: GPT-image-1-mini main render
    // with Gemini QA/fix fallback.
    const activeProvider = provider || 'openai-mini';

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

    const missingImages = items.filter(item => !item.image_url);
    if (missingImages.length > 0) {
      return res.status(400).json({
        error: `Cannot render without reference image: ${missingImages.map(item => item.name || `Item ${item.id}`).join(', ')}`
      });
    }

    const now = new Date().toISOString();

    // Mark items as active — the background worker in server.js
    // will pick them up on the next poll cycle
    await updateQueueItems(itemIds, {
      status: 'active',
      sub_text: `Queued for ${providerLabel(activeProvider)} processing...`,
      provider: activeProvider,
      resolution: resolution || '1K',
      updated_at: now
    });

    // Save brand references for items that have them
    if (brands && typeof brands === 'object' && Object.keys(brands).length > 0) {
      for (const itemId of itemIds) {
        const brand = brands[itemId];
        if (brand && brand.trim()) {
          const { error: brandError } = await supabase
            .from(QUEUE_TABLE)
            .update({ brand: brand.trim(), updated_at: now })
            .eq('id', itemId);
          if (brandError) {
            if (isSchemaCacheColumnError(brandError) && getMissingSchemaColumn(brandError) === 'brand') {
              console.warn(`[SUBMIT] Skipping brand for item ${itemId}; product_queue.brand is not in the schema cache yet`);
            } else {
              console.warn(`[SUBMIT] Failed to save brand for item ${itemId}:`, brandError.message);
            }
          }
        }
      }
    }

    const { data: existingResults, error: existingResultsError } = await supabase
      .from(RESULTS_TABLE)
      .select('queue_item_id, view_id, status, image_url')
      .in('queue_item_id', itemIds);

    if (existingResultsError) throw existingResultsError;

    const completedViews = new Set(
      (existingResults || [])
        .filter(row => row.status === 'done' && row.image_url)
        .map(row => `${row.queue_item_id}:${row.view_id}`)
    );

    // Create waiting render result rows only for views that still need work.
    // This keeps "Retry failed" from wiping successful images and regenerating
    // the whole batch.
    const resultRows = [];
    for (const item of items) {
      for (const view of VIEWS) {
        if (completedViews.has(`${item.id}:${view.id}`)) continue;
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

    if (resultRows.length > 0) {
      const { error: upsertError } = await supabase
        .from(RESULTS_TABLE)
        .upsert(resultRows, { onConflict: 'queue_item_id,view_id' });

      if (upsertError) throw upsertError;
    }

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
