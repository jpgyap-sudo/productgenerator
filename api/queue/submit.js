// POST /api/queue/submit
// Starts durable fal.ai queue jobs for each product view and stores the
// request/status URLs in Supabase so renders can survive tab closes/reloads.
import { supabase, QUEUE_TABLE, RESULTS_TABLE } from '../../lib/supabase.js';
import { VIEWS, submitViewJob, getAttemptCount } from '../../lib/fal.js';
import { waitUntil } from '@vercel/functions';

export const config = {
  runtime: 'nodejs',
  maxDuration: 300
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = await req.json();
    const { itemIds, resolution } = body || {};

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return json({ error: 'itemIds array is required' }, 400);
    }

    const { data: items, error: fetchError } = await supabase
      .from(QUEUE_TABLE)
      .select('*')
      .in('id', itemIds);

    if (fetchError) throw fetchError;
    if (!items || items.length === 0) {
      return json({ error: 'No items found' }, 404);
    }

    const now = new Date().toISOString();
    const { error: updateError } = await supabase
      .from(QUEUE_TABLE)
      .update({ status: 'active', sub_text: 'Submitting durable render jobs...', updated_at: now })
      .in('id', itemIds);

    if (updateError) throw updateError;

    const resultRows = [];
    for (const item of items) {
      for (const view of VIEWS) {
        resultRows.push(waitingRow(item.id, view.id, now));
      }
    }

    const { error: upsertError } = await supabase
      .from(RESULTS_TABLE)
      .upsert(resultRows, { onConflict: 'queue_item_id,view_id' });

    if (upsertError) throw upsertError;

    waitUntil(submitDurableJobs(items, resolution || '1K'));

    return json({
      success: true,
      message: `Queued ${items.length} item(s) for durable render submission`,
      items: items.map(item => ({ id: item.id, name: item.name }))
    });
  } catch (error) {
    console.error('Queue submit error:', error);
    return json({ error: error.message || 'Internal server error' }, 500);
  }
}

async function submitDurableJobs(items, resolution) {
  for (const item of items) {
    const itemRows = [];
    const now = new Date().toISOString();

    if (!item.image_url) {
      for (const view of VIEWS) {
        itemRows.push(errorRow(item.id, view.id, 'No reference image', now));
      }
    } else {
      for (const view of VIEWS) {
        itemRows.push(await submitDurableViewRow(item, view, resolution, now));
      }
    }

    const { error: upsertError } = await supabase
      .from(RESULTS_TABLE)
      .upsert(itemRows, { onConflict: 'queue_item_id,view_id' });

    if (upsertError) {
      console.error(`Failed to save render rows for item ${item.id}:`, upsertError);
      await markItemError(item.id, upsertError.message || 'Failed to save render jobs');
      continue;
    }

    const everyViewFailed = itemRows.length > 0 && itemRows.every(row => row.status === 'error');
    await supabase
      .from(QUEUE_TABLE)
      .update({
        status: everyViewFailed ? 'error' : 'active',
        sub_text: everyViewFailed ? 'Failed to submit render jobs' : 'Render jobs submitted to fal.ai',
        updated_at: new Date().toISOString()
      })
      .eq('id', item.id);
  }
}

async function submitDurableViewRow(item, view, resolution, now) {
  let lastError = null;

  for (let attempt = 0; attempt < getAttemptCount(); attempt++) {
    try {
      const queued = await submitViewJob(view, item.description || '', item.image_url, resolution, attempt);
      return {
        queue_item_id: item.id,
        view_id: view.id,
        status: 'generating',
        request_id: queued.request_id || '',
        response_url: queued.response_url || '',
        status_url: queued.status_url || '',
        attempt_index: queued.attempt || 0,
        attempt_label: queued.attempt_label || '',
        error_message: '',
        started_at: now,
        completed_at: null,
        created_at: now,
        updated_at: now
      };
    } catch (error) {
      lastError = error;
    }
  }

  return errorRow(item.id, view.id, lastError?.message || 'Failed to submit fal queue job', now);
}

function waitingRow(itemId, viewId, now) {
  return {
    queue_item_id: itemId,
    view_id: viewId,
    status: 'waiting',
    error_message: '',
    image_url: '',
    request_id: '',
    response_url: '',
    status_url: '',
    started_at: null,
    completed_at: null,
    created_at: now,
    updated_at: now
  };
}

function errorRow(itemId, viewId, message, now) {
  return {
    queue_item_id: itemId,
    view_id: viewId,
    status: 'error',
    error_message: message,
    completed_at: now,
    created_at: now,
    updated_at: now
  };
}

async function markItemError(itemId, message) {
  await supabase
    .from(QUEUE_TABLE)
    .update({ status: 'error', sub_text: message, updated_at: new Date().toISOString() })
    .eq('id', itemId);
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
