// ═══════════════════════════════════════════════════════════════════
//  GET /api/queue/status — Poll queue and render status
//  Returns the current state of all queue items and their render results.
//  The frontend polls this endpoint every 3-5 seconds.
// ═══════════════════════════════════════════════════════════════════
import { supabase, QUEUE_TABLE, RESULTS_TABLE } from '../../lib/supabase.js';

export const config = {
  runtime: 'edge'
};

export default async function handler(req) {
  // Only accept GET
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const url = new URL(req.url);
    const itemId = url.searchParams.get('itemId');

    // Fetch queue items
    let queueQuery = supabase
      .from(QUEUE_TABLE)
      .select('*')
      .order('id', { ascending: true });

    if (itemId) {
      queueQuery = queueQuery.eq('id', parseInt(itemId));
    }

    const { data: queueItems, error: queueError } = await queueQuery;
    if (queueError) throw queueError;

    if (!queueItems || queueItems.length === 0) {
      return new Response(JSON.stringify({
        queue: [],
        renderResults: {},
        hasActiveItems: false,
        hasPendingItems: false
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Fetch render results for all queue items
    const itemIds = queueItems.map(q => q.id);
    const { data: renderResults, error: resultsError } = await supabase
      .from(RESULTS_TABLE)
      .select('*')
      .in('queue_item_id', itemIds)
      .order('view_id', { ascending: true });

    if (resultsError) {
      console.error('Failed to fetch render results:', resultsError);
      // Non-fatal — return queue without results
    }

    // Group render results by queue_item_id
    const resultsByItem = {};
    if (renderResults) {
      for (const row of renderResults) {
        if (!resultsByItem[row.queue_item_id]) {
          resultsByItem[row.queue_item_id] = [];
        }
        resultsByItem[row.queue_item_id].push({
          viewId: row.view_id,
          status: row.status,
          imageUrl: row.image_url || null,
          errorMessage: row.error_message || null,
          startedAt: row.started_at,
          completedAt: row.completed_at
        });
      }
    }

    // Determine overall status
    const hasActiveItems = queueItems.some(q => q.status === 'active');
    const hasPendingItems = queueItems.some(q => q.status === 'wait');

    return new Response(JSON.stringify({
      queue: queueItems.map(q => ({
        id: q.id,
        name: q.name,
        imageUrl: q.image_url || '',
        status: q.status,
        description: q.description || '',
        updatedAt: q.updated_at
      })),
      renderResults: resultsByItem,
      hasActiveItems,
      hasPendingItems
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      }
    });

  } catch (error) {
    console.error('Queue status error:', error);
    return new Response(JSON.stringify({
      error: error.message || 'Internal server error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
