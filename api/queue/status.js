// GET /api/queue/status
// Polls Supabase and reconciles any durable fal.ai queue jobs that finished
// while the browser was closed or reloading.
import { supabase, QUEUE_TABLE, RESULTS_TABLE, BUCKET_NAME } from '../../lib/supabase.js';
import { getQueuedResult, extractImageUrl } from '../../lib/fal.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 300
};

export default async function handler(req) {
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const url = new URL(req.url);
    const itemId = url.searchParams.get('itemId');

    const { data: queueItems, error: queueError } = await fetchQueueItems(itemId);
    if (queueError) throw queueError;

    if (!queueItems || queueItems.length === 0) {
      return json({
        queue: [],
        renderResults: {},
        hasActiveItems: false,
        hasPendingItems: false
      });
    }

    const itemIds = queueItems.map(item => item.id);
    const { data: renderRows, error: resultsError } = await supabase
      .from(RESULTS_TABLE)
      .select('*')
      .in('queue_item_id', itemIds)
      .order('view_id', { ascending: true });

    if (resultsError) throw resultsError;

    const reconciledRows = await reconcileFalJobs(renderRows || []);
    await updateQueueStatuses(queueItems, reconciledRows);

    const { data: refreshedQueue, error: refreshedQueueError } = await fetchQueueItems(itemId);
    if (refreshedQueueError) throw refreshedQueueError;

    const { data: refreshedRows, error: refreshedRowsError } = await supabase
      .from(RESULTS_TABLE)
      .select('*')
      .in('queue_item_id', itemIds)
      .order('view_id', { ascending: true });

    if (refreshedRowsError) throw refreshedRowsError;

    const queue = refreshedQueue || queueItems;
    const rows = refreshedRows || reconciledRows;

    return json({
      queue: queue.map(item => ({
        id: item.id,
        name: item.name,
        imageUrl: item.image_url || '',
        status: item.status,
        description: item.description || '',
        updatedAt: item.updated_at
      })),
      renderResults: groupResults(rows),
      hasActiveItems: queue.some(item => item.status === 'active'),
      hasPendingItems: queue.some(item => item.status === 'wait')
    }, 200, {
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
  } catch (error) {
    console.error('Queue status error:', error);
    return json({ error: error.message || 'Internal server error' }, 500);
  }
}

function fetchQueueItems(itemId) {
  let query = supabase
    .from(QUEUE_TABLE)
    .select('*')
    .order('id', { ascending: true });

  if (itemId) query = query.eq('id', parseInt(itemId, 10));
  return query;
}

async function reconcileFalJobs(rows) {
  const nextRows = [];

  for (const row of rows) {
    if (row.status !== 'generating') {
      nextRows.push(row);
      continue;
    }

    try {
      const queued = await getQueuedResult(row);
      if (queued.state === 'pending') {
        nextRows.push(row);
        continue;
      }

      if (queued.state === 'error') {
        const updated = {
          ...row,
          status: 'error',
          error_message: queued.error || 'Render failed',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        await saveResultRow(updated);
        nextRows.push(updated);
        continue;
      }

      const imageUrl = extractImageUrl(queued.result);
      if (!imageUrl) {
        const updated = {
          ...row,
          status: 'error',
          error_message: 'No image URL in fal response',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        await saveResultRow(updated);
        nextRows.push(updated);
        continue;
      }

      const storedUrl = await copyImageToStorage(imageUrl, row.queue_item_id, row.view_id);
      const updated = {
        ...row,
        status: 'done',
        image_url: storedUrl || imageUrl,
        error_message: '',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      await saveResultRow(updated);
      nextRows.push(updated);
    } catch (error) {
      console.error(`Failed to reconcile item ${row.queue_item_id} view ${row.view_id}:`, error);
      nextRows.push(row);
    }
  }

  return nextRows;
}

async function copyImageToStorage(imageUrl, itemId, viewId) {
  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) throw new Error(`Image fetch failed: ${imageRes.status}`);

  const contentType = imageRes.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const buffer = Buffer.from(await imageRes.arrayBuffer());
  const fileName = `renders/${itemId}_view${viewId}_${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(fileName, buffer, {
      contentType,
      upsert: true
    });

  if (uploadError) throw uploadError;

  const { data: { publicUrl } } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(fileName);

  return publicUrl;
}

async function saveResultRow(row) {
  const { error } = await supabase
    .from(RESULTS_TABLE)
    .update({
      status: row.status,
      image_url: row.image_url || '',
      error_message: row.error_message || '',
      completed_at: row.completed_at || null,
      updated_at: row.updated_at || new Date().toISOString()
    })
    .eq('queue_item_id', row.queue_item_id)
    .eq('view_id', row.view_id);

  if (error) throw error;
}

async function updateQueueStatuses(queueItems, rows) {
  for (const item of queueItems) {
    if (item.status === 'stopped') continue;

    const itemRows = rows.filter(row => row.queue_item_id === item.id);
    if (itemRows.length === 0) continue;

    const doneCount = itemRows.filter(row => row.status === 'done').length;
    const errorCount = itemRows.filter(row => row.status === 'error').length;
    const activeCount = itemRows.filter(row => row.status === 'generating' || row.status === 'waiting').length;

    let status = item.status;
    let subText = item.sub_text || '';

    if (activeCount > 0) {
      status = 'active';
      subText = `${doneCount}/5 views completed`;
    } else if (doneCount === 5) {
      status = 'done';
      subText = 'All 5 views generated';
    } else if (doneCount > 0 || errorCount > 0) {
      status = 'error';
      subText = `${doneCount}/5 views generated`;
    }

    if (status !== item.status || subText !== item.sub_text) {
      await supabase
        .from(QUEUE_TABLE)
        .update({ status, sub_text: subText, updated_at: new Date().toISOString() })
        .eq('id', item.id);
    }
  }
}

function groupResults(rows) {
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.queue_item_id]) grouped[row.queue_item_id] = [];
    grouped[row.queue_item_id].push({
      viewId: row.view_id,
      status: row.status,
      imageUrl: row.image_url || null,
      errorMessage: row.error_message || null,
      startedAt: row.started_at,
      completedAt: row.completed_at
    });
  }
  return grouped;
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders
    }
  });
}
