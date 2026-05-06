// ═══════════════════════════════════════════════════════════════════
//  POST /api/queue/submit — Start processing queue items
//  This endpoint accepts a list of item IDs to process, sets them
//  to ACTIVE, and kicks off background processing via waitUntil().
// ═══════════════════════════════════════════════════════════════════
import { supabase, QUEUE_TABLE, RESULTS_TABLE, BUCKET_NAME } from '../../lib/supabase.js';
import { waitUntil } from '@vercel/functions';

export const config = {
  runtime: 'nodejs',
  // Must match or exceed process-item.js maxDuration
  // waitUntil() keeps the function alive after response is sent
  maxDuration: 600
};

export default async function handler(req) {
  // Only accept POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await req.json();
    const { itemIds, resolution } = body || {};

    if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
      return new Response(JSON.stringify({ error: 'itemIds array is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Fetch the items from Supabase
    const { data: items, error: fetchError } = await supabase
      .from(QUEUE_TABLE)
      .select('*')
      .in('id', itemIds);

    if (fetchError) throw fetchError;
    if (!items || items.length === 0) {
      return new Response(JSON.stringify({ error: 'No items found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Set all items to ACTIVE status
    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from(QUEUE_TABLE)
      .update({ status: 'active', updated_at: now })
      .in('id', itemIds);

    if (updateError) throw updateError;

    // Create render_results rows for each item's 5 views
    const resultRows = [];
    for (const item of items) {
      for (let viewId = 1; viewId <= 5; viewId++) {
        resultRows.push({
          queue_item_id: item.id,
          view_id: viewId,
          status: 'waiting',
          created_at: now,
          updated_at: now
        });
      }
    }
    const { error: insertError } = await supabase
      .from(RESULTS_TABLE)
      .insert(resultRows);

    if (insertError) {
      console.error('Failed to insert render_results rows:', insertError);
      // Non-fatal — continue processing
    }

    // Kick off background processing using waitUntil
    // This keeps the function alive after the response is sent
    const processUrl = new URL('/api/process-item', req.url);
    processUrl.searchParams.set('ids', itemIds.join(','));
    if (resolution) processUrl.searchParams.set('res', resolution);

    waitUntil(
      fetch(processUrl.toString(), { method: 'POST' }).catch(e => {
        console.error('Background processing request failed:', e);
      })
    );

    return new Response(JSON.stringify({
      success: true,
      message: `Started processing ${items.length} item(s)`,
      items: items.map(i => ({ id: i.id, name: i.name }))
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Queue submit error:', error);
    return new Response(JSON.stringify({
      error: error.message || 'Internal server error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
