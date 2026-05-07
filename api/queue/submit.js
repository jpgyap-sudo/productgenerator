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
import { supabase, QUEUE_TABLE, RESULTS_TABLE } from '../../lib/supabase.js';
import { VIEWS } from '../../lib/fal.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const { itemIds, resolution, provider, brands } = body;

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: 'itemIds array is required' });
    }

    // Default to openai if no provider specified
    const activeProvider = provider || 'openai';

    // Validate provider
    if (activeProvider !== 'openai' && activeProvider !== 'gemini') {
      return res.status(400).json({
        error: `Unsupported provider: "${activeProvider}". Use "openai" or "gemini".`
      });
    }

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
