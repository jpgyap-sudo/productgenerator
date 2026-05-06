// POST /api/queue/submit
// Starts durable render jobs for each product view and stores the
// request/status URLs in Supabase so renders can survive tab closes/reloads.
//
// IMPROVEMENT: Now passes a webhook URL to fal.ai so results are delivered
// server-side when complete, eliminating the need for client-side polling.
// Fal.ai's queue guarantees: no dropped requests, auto-retry up to 10x,
// automatic runner scaling, and model fallbacks.
//
// PROVIDER SUPPORT: Supports both 'fal' (default) and 'gemini' providers.
// - fal: Uses fal.ai queue-based API with webhook support
// - gemini: Uses Google Gemini API directly (synchronous, no queue/webhook)
import { supabase, QUEUE_TABLE, RESULTS_TABLE } from '../../lib/supabase.js';
import { VIEWS, submitViewJob, getAttemptCount } from '../../lib/fal.js';
import { waitUntil } from '@vercel/functions';

export const config = {
  runtime: 'nodejs',
  maxDuration: 300
};

// ── Improvement: Derive webhook URL from the request's own origin ──
// This ensures the webhook points back to this same deployment.
// Fal.ai will POST the result to this URL when processing completes,
// so we don't need to poll from the client.
function getWebhookUrl(req) {
  const origin = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    // BUGFIX: In Vercel serverless, req.url is a relative path (e.g. '/api/queue/submit')
    // new URL() requires a full URL, so provide the host header as base
    : new URL(req.url, `https://${req.headers.get('host') || 'localhost'}`).origin;
  return `${origin}/api/fal-webhook`;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = await req.json();
    const { itemIds, resolution, provider } = body || {};

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
        resultRows.push(waitingRow(item.id, view.id, now, resolution || '1K'));
      }
    }

    const { error: upsertError } = await supabase
      .from(RESULTS_TABLE)
      .upsert(resultRows, { onConflict: 'queue_item_id,view_id' });

    if (upsertError) throw upsertError;

    // ── Improvement: Pass webhook URL so fal.ai notifies us on completion ──
    // This eliminates the need for client-side polling. The webhook endpoint
    // (/api/fal-webhook) will receive the result and update Supabase directly.
    // For Gemini provider, no webhook is needed (synchronous generation).
    const activeProvider = provider || 'fal';
    const webhookUrl = activeProvider === 'fal' ? getWebhookUrl(req) : undefined;
    waitUntil(submitDurableJobs(items, resolution || '1K', webhookUrl, activeProvider));

    return json({
      success: true,
      message: `Queued ${items.length} item(s) for durable render submission (provider: ${activeProvider})`,
      provider: activeProvider,
      items: items.map(item => ({ id: item.id, name: item.name }))
    });
  } catch (error) {
    console.error('Queue submit error:', error);
    return json({ error: error.message || 'Internal server error' }, 500);
  }
}

async function submitDurableJobs(items, resolution, webhookUrl, provider = 'fal') {
  // Submit all views for all items in parallel
  const allPromises = [];

  for (const item of items) {
    const now = new Date().toISOString();

    if (!item.image_url) {
      // No image — mark all views as error immediately
      const errorRows = VIEWS.map(view => errorRow(item.id, view.id, 'No reference image', now));
      allPromises.push(
        supabase
          .from(RESULTS_TABLE)
          .upsert(errorRows, { onConflict: 'queue_item_id,view_id' })
          .then(() => markItemError(item.id, 'No reference image'))
      );
      continue;
    }

    if (provider === 'gemini') {
      // ── Gemini provider: synchronous generation via background worker ──
      // Gemini API is synchronous (no queue), so we trigger the background
      // worker directly. The worker calls generateGeminiView() for each view.
      const viewRows = VIEWS.map(view => waitingRow(item.id, view.id, now, resolution || '1K'));
      allPromises.push(
        supabase
          .from(RESULTS_TABLE)
          .upsert(viewRows, { onConflict: 'queue_item_id,view_id' })
          .then(async () => {
            // Save provider on the queue item so status.js reconciliation
            // can identify Gemini rows and skip fal.ai queue polling
            await supabase
              .from(QUEUE_TABLE)
              .update({
                status: 'active',
                sub_text: 'Generating with Gemini...',
                provider: 'gemini',
                updated_at: new Date().toISOString()
              })
              .eq('id', item.id);

            // Trigger background worker for Gemini generation
            const workerUrl = process.env.VERCEL_URL
              ? `https://${process.env.VERCEL_URL}/api/process-item?ids=${item.id}&res=${resolution || '1K'}&provider=gemini`
              : undefined;

            if (workerUrl) {
              // Fire-and-forget: trigger the worker asynchronously
              fetch(workerUrl, { method: 'POST' }).catch(err => {
                console.error(`Failed to trigger Gemini worker for item ${item.id}:`, err.message);
              });
            }
          })
      );
    } else {
      // ── Fal.ai provider: queue-based submission with webhook ──
      // Submit all 5 views in parallel with webhook URL
      const viewPromises = VIEWS.map(view =>
        submitDurableViewRow(item, view, resolution, now, webhookUrl)
      );

      allPromises.push(
        Promise.all(viewPromises).then(async (itemRows) => {
          const { error: upsertError } = await supabase
            .from(RESULTS_TABLE)
            .upsert(itemRows, { onConflict: 'queue_item_id,view_id' });

          if (upsertError) {
            console.error(`Failed to save render rows for item ${item.id}:`, upsertError);
            await markItemError(item.id, upsertError.message || 'Failed to save render jobs');
            return;
          }

          const everyViewFailed = itemRows.length > 0 && itemRows.every(row => row.status === 'error');
          await supabase
            .from(QUEUE_TABLE)
            .update({
              status: everyViewFailed ? 'error' : 'active',
              sub_text: everyViewFailed ? 'Failed to submit render jobs' : 'Render jobs submitted to fal.ai',
              provider: 'fal',
              updated_at: new Date().toISOString()
            })
            .eq('id', item.id);
        })
      );
    }
  }

  // Wait for all items to finish submitting
  await Promise.all(allPromises);
}

async function submitDurableViewRow(item, view, resolution, now, webhookUrl) {
  let lastError = null;

  for (let attempt = 0; attempt < getAttemptCount(); attempt++) {
    try {
      // ── Improvement: Pass webhookUrl so fal.ai notifies us on completion ──
      // Fal.ai will POST the result to our webhook endpoint when done.
      // This eliminates the need for client-side polling.
      const queued = await submitViewJob(
        view,
        item.description || '',
        item.image_url,
        resolution,
        attempt,
        { webhookUrl }
      );
      return {
        queue_item_id: item.id,
        view_id: view.id,
        status: 'generating',
        request_id: queued.request_id || '',
        response_url: queued.response_url || '',
        status_url: queued.status_url || '',
        cancel_url: queued.cancel_url || '',
        queue_position: queued.queue_position != null ? queued.queue_position : null,
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

function waitingRow(itemId, viewId, now, resolution = '1K') {
  return {
    queue_item_id: itemId,
    view_id: viewId,
    status: 'waiting',
    error_message: '',
    image_url: '',
    request_id: '',
    response_url: '',
    status_url: '',
    cancel_url: '',
    queue_position: null,
    resolution: resolution,
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
