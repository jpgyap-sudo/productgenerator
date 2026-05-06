// ═══════════════════════════════════════════════════════════════════
//  Shared fal.ai API Logic — used by the background worker
//  Uses fal.ai queue-based API for reliable long-running generations.
//  Reference: https://fal.ai/docs
// ═══════════════════════════════════════════════════════════════════

const FAL_API_KEY = process.env.FAL_API_KEY;

if (!FAL_API_KEY) {
  console.error('Missing FAL_API_KEY environment variable');
}

/**
 * The 5 standard views for product photography.
 */
export const VIEWS = [
  { id: 1, label: 'Front view' },
  { id: 2, label: 'Side view' },
  { id: 3, label: 'Isometric view' },
  { id: 4, label: 'Back view' },
  { id: 5, label: 'Interior scene' }
];

function buildDesc(desc) {
  return (desc && desc.trim()) ? `the product from the reference image (${desc})` : 'the product from the reference image';
}

function fallbackPrompt(view, desc) {
  const d = buildDesc(desc);
  if (view.id === 1) return `Create a clean studio product photo of this ${d} from the reference image on a white background.`;
  if (view.id === 5) return `Create a photorealistic modern interior scene featuring this ${d} from the reference image.`;
  return `Create a clean ${view.label.toLowerCase()} product photo of this ${d} from the reference image on a white background.`;
}

function homeuPrompt(view, desc) {
  const d = buildDesc(desc);
  const fidelity = `Use ONLY the exact uploaded reference product image for ${d}. Maintain 100% product fidelity: do not redesign, reinterpret, replace, improve, recolor, resize disproportionately, add/remove cushions, change legs/base/frame, alter materials, or change structure. The product must remain the same object with the same proportions, color, material, silhouette, texture, and visible details.`;
  const productShot = `Generate one separate image only, not a collage or grid. White background, centered product photography, clean premium catalog lighting, soft realistic shadows, no extra furniture or decor.`;
  if (view.id === 1) return `${fidelity} ${productShot} Image 1: front view of the chair.`;
  if (view.id === 2) return `${fidelity} ${productShot} Image 2: side view of the chair.`;
  if (view.id === 3) return `${fidelity} ${productShot} Image 3: isometric 45-degree view of the chair.`;
  if (view.id === 4) return `${fidelity} ${productShot} Image 4: back view of the chair. Infer hidden rear details conservatively from the reference without changing the design.`;
  return `${fidelity} Generate one separate image only, not a collage or grid. Image 5: full luxury modern dining room interior scene using the EXACT same chair as the main furniture. Place it naturally in a high-end condominium or architect-designed luxury home setting with premium materials such as marble, travertine, wood veneer, brushed metal, linen or boucle textures, soft natural daylight, balanced exposure, realistic grounding shadows, correct scale and perspective, eye-level camera, and Homeu-style neutral luxury tones: beige, taupe, cream, warm gray, black accents, walnut or oak. Supporting decor such as rugs, pendant lights, wall art, curtains, vases, books, or trays is allowed only if it does not overpower the chair. The scene must look like a real photographed luxury property listing or interior design magazine image.`;
}

export const VIEW_PROMPTS = [
  { id: 1, prompt: d => homeuPrompt({ id: 1 }, d) },
  { id: 2, prompt: d => homeuPrompt({ id: 2 }, d) },
  { id: 3, prompt: d => homeuPrompt({ id: 3 }, d) },
  { id: 4, prompt: d => homeuPrompt({ id: 4 }, d) },
  { id: 5, prompt: d => homeuPrompt({ id: 5 }, d) }
];

/**
 * Attempt configurations for generating a view, tried in order.
 * Uses the correct fal.ai endpoint with documented parameters.
 *
 * IMPORTANT: Fal.ai's queue system already handles automatic retries
 * (up to 10x for 503/504/connection errors) and model fallbacks.
 * Our attempt fallback is only for switching between different models.
 */
const ATTEMPTS = [
  {
    label: 'Nano Banana 2 Edit',
    url: 'https://queue.fal.run/fal-ai/nano-banana-2/edit',
    body: (view, desc, imageUrl, resolution) => ({
      prompt: (VIEW_PROMPTS.find(v => v.id === view.id) || VIEW_PROMPTS[0]).prompt(desc),
      image_urls: [imageUrl],
      resolution: resolution || '1K',
      aspect_ratio: view.id === 5 ? '16:9' : '1:1',
      output_format: 'jpeg',
      num_images: 1,
      safety_tolerance: '4',
      limit_generations: true
    })
  },
  {
    label: 'GPT Image 2 Edit',
    url: 'https://queue.fal.run/openai/gpt-image-2/edit',
    body: (view, desc, imageUrl, resolution) => ({
      prompt: (VIEW_PROMPTS.find(v => v.id === view.id) || VIEW_PROMPTS[0]).prompt(desc),
      image_urls: [imageUrl],
      image_size: view.id === 5 ? 'landscape_16_9' : 'square_hd',
      quality: 'high',
      num_images: 1,
      output_format: 'jpeg'
    })
  }
];

export function getAttemptCount() {
  return ATTEMPTS.length;
}

export function getViewById(viewId) {
  return VIEWS.find(view => view.id === Number(viewId)) || null;
}

/**
 * Submit a generation job to fal.ai using their queue-based API.
 *
 * IMPROVEMENT: Now supports:
 * - webhook_url for server-side completion notification (eliminates polling)
 * - X-Fal-Request-Timeout header to cap total wait time
 * - Returns queue_position for progress visibility
 *
 * Fal.ai's queue guarantees:
 * - Requests are never dropped
 * - Automatic retries up to 10x for 503/504/connection errors
 * - No queue size limit
 * - Runners scale up/down automatically
 *
 * @param {string} apiKey - fal.ai API key
 * @param {string} url - Model endpoint URL
 * @param {object} body - Request body parameters
 * @param {object} options - Optional settings
 * @param {string} [options.webhookUrl] - URL for fal.ai to POST result to on completion
 * @param {number} [options.startTimeout] - Max seconds for fal.ai to retry before giving up
 * @returns {Promise<object>} Queue submission response
 */
async function submitToQueue(apiKey, url, body, options = {}) {
  const headers = {
    'Authorization': `Key ${apiKey}`,
    'Content-Type': 'application/json'
  };

  // ── Improvement: Set start timeout to cap total retry duration ──
  // Fal.ai retries up to 10 times for 503/504/connection errors.
  // This header limits the total time spent retrying.
  if (options.startTimeout) {
    headers['X-Fal-Request-Timeout'] = String(options.startTimeout);
  }

  const queueUrl = options.webhookUrl
    ? `${url}?fal_webhook=${encodeURIComponent(options.webhookUrl)}`
    : url;

  const res = await fetch(queueUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    let errorDetail;
    try { errorDetail = await res.json(); } catch (e2) { /* ignore */ }
    const msg = typeof errorDetail === 'object'
      ? (errorDetail.message || errorDetail.detail || errorDetail.error || JSON.stringify(errorDetail))
      : errorDetail;
    throw new Error(msg || `API error ${res.status}`);
  }

  const data = await res.json();

  // fal.ai queue response contains request_id, response_url, status_url, cancel_url, queue_position
  if (data.request_id && data.response_url) {
    return {
      request_id: data.request_id,
      response_url: data.response_url,
      status_url: data.status_url || data.response_url,
      cancel_url: data.cancel_url || null,
      queue_position: data.queue_position != null ? data.queue_position : null
    };
  }

  // If the response already contains images (sync mode), return directly
  if (data.images || data.output) {
    return data;
  }

  return data;
}

/**
 * Submit a view job to fal.ai queue.
 *
 * IMPROVEMENT: Now accepts webhookUrl for server-side completion.
 * Fal.ai's built-in retries (up to 10x) handle transient failures,
 * so our attempt fallback is only for model-level fallback.
 *
 * @param {object} view - View object
 * @param {string} desc - Product description
 * @param {string} imageUrl - Reference image URL
 * @param {string} resolution - Resolution setting
 * @param {number} attempt - Attempt index for model fallback
 * @param {object} options - Additional options
 * @param {string} [options.webhookUrl] - Webhook URL for completion notification
 * @returns {Promise<object>} Queue submission response
 */
export async function submitViewJob(view, desc, imageUrl, resolution = '1K', attempt = 0, options = {}) {
  const apiKey = FAL_API_KEY;
  if (!apiKey) throw new Error('FAL_API_KEY not configured');
  if (!view) throw new Error('Unknown view');

  const request = ATTEMPTS[Math.min(attempt, ATTEMPTS.length - 1)];
  const queueResponse = await submitToQueue(apiKey, request.url, request.body(view, desc, imageUrl, resolution), {
    webhookUrl: options.webhookUrl,
    // Cap total retry time at 120 seconds per fal.ai docs recommendation
    startTimeout: 120
  });

  return {
    ...queueResponse,
    attempt,
    attempt_label: request.label
  };
}

/**
 * Get the result of a completed fal.ai queue job.
 *
 * IMPROVEMENT: Uses the proper status endpoint and handles
 * all documented status values (IN_QUEUE, IN_PROGRESS, COMPLETED).
 * Also extracts queue_position for progress tracking.
 *
 * @param {object} row - Database row with response_url/status_url
 * @returns {Promise<{state: string, result?: object, error?: string, status?: string, queue_position?: number}>}
 */
export async function getQueuedResult(row) {
  const apiKey = FAL_API_KEY;
  if (!apiKey) throw new Error('FAL_API_KEY not configured');

  if (!row.response_url) {
    return { state: 'error', error: 'Missing fal response URL' };
  }

  const statusUrl = row.status_url || row.response_url;
  const statusRes = await fetch(statusUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Key ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!statusRes.ok) {
    let errorDetail;
    try { errorDetail = await statusRes.json(); } catch (e2) { /* ignore */ }
    const msg = typeof errorDetail === 'object'
      ? (errorDetail.message || errorDetail.detail || errorDetail.error || JSON.stringify(errorDetail))
      : errorDetail;
    return { state: 'error', error: msg || `Queue status error ${statusRes.status}` };
  }

  const statusData = await statusRes.json();
  const status = String(statusData.status || '').toUpperCase();

  // ── Improvement: Handle all documented queue states ──
  // IN_QUEUE, IN_PROGRESS = still processing
  // COMPLETED = done
  // FAILED/ERROR = failed
  if (status === 'IN_QUEUE' || status === 'IN_PROGRESS') {
    return {
      state: 'pending',
      status,
      queue_position: statusData.queue_position != null ? statusData.queue_position : undefined
    };
  }

  if (status === 'COMPLETED' || status === 'SUCCESS') {
    // Status endpoint may include the result directly, or we need to fetch response_url
    let result = statusData;
    if (!extractImageUrl(result)) {
      const responseRes = await fetch(row.response_url, {
        method: 'GET',
        headers: {
          'Authorization': `Key ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (!responseRes.ok) {
        let errorDetail;
        try { errorDetail = await responseRes.json(); } catch (e2) { /* ignore */ }
        const msg = typeof errorDetail === 'object'
          ? (errorDetail.message || errorDetail.detail || errorDetail.error || JSON.stringify(errorDetail))
          : errorDetail;
        return { state: 'error', error: msg || `Queue response error ${responseRes.status}` };
      }

      result = await responseRes.json();
    }

    return { state: 'done', result };
  }

  if (status === 'FAILED' || status === 'ERROR') {
    return {
      state: 'error',
      error: statusData.error || statusData.detail || 'Queue job failed',
      error_type: statusData.error_type || null
    };
  }

  // Unknown status — treat as pending
  return { state: 'pending', status };
}

/**
 * Extract image URL from fal.ai response, handling all documented response formats.
 *
 * IMPROVEMENT: Fal.ai CDN URLs (v3.fal.media) are publicly accessible and
 * subject to media expiration settings. We should use them directly rather
 * than downloading and re-uploading to Supabase, which adds latency.
 *
 * @param {object} result - fal.ai API response
 * @returns {string|null} Image URL or null
 */
export function extractImageUrl(result) {
  return result?.images?.[0]?.url
    || result?.output?.images?.[0]?.url
    || result?.data?.images?.[0]?.url
    || result?.image?.url
    || (typeof result?.image === 'string' ? result.image : null);
}

/**
 * Poll a fal.ai queue status URL until the job completes or times out.
 *
 * IMPROVEMENT: Uses exponential backoff for polling interval to reduce
 * API calls during long-running jobs. Starts at 1s, maxes at 5s.
 *
 * @param {string} statusUrl - The URL to poll for status
 * @param {string} apiKey - fal.ai API key
 * @param {number} timeoutMs - Maximum time to wait in ms (default: 5 minutes)
 * @param {number} intervalMs - Initial polling interval in ms (default: 1000)
 * @returns {Promise<object>} - The completed result
 */
async function pollQueueResult(statusUrl, apiKey, timeoutMs = 120000, intervalMs = 1000) {
  const startTime = Date.now();
  let currentInterval = intervalMs;

  while (true) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Queue polling timed out after ${timeoutMs}ms`);
    }

    const res = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Key ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      let errorDetail;
      try { errorDetail = await res.json(); } catch (e2) { /* ignore */ }
      const msg = typeof errorDetail === 'object'
        ? (errorDetail.message || errorDetail.detail || errorDetail.error || JSON.stringify(errorDetail))
        : errorDetail;
      throw new Error(`Queue status error ${res.status}: ${msg}`);
    }

    const data = await res.json();
    const status = String(data.status || '').toUpperCase();

    // Check status using the documented values
    if (status === 'COMPLETED' || status === 'SUCCESS') {
      return data;
    }

    if (status === 'FAILED' || status === 'ERROR') {
      throw new Error(data.error || data.detail || 'Queue job failed');
    }

    // Still processing — exponential backoff for polling interval
    // Start at 1s, increase up to 5s max to reduce API calls
    await new Promise(r => setTimeout(r, currentInterval));
    currentInterval = Math.min(currentInterval * 1.5, 5000);
  }
}

/**
 * Generate a single view using fal.ai queue-based API.
 * Tries multiple model configurations with fallback logic.
 *
 * IMPROVEMENT:
 * - Uses fal.ai CDN URL directly instead of downloading + re-uploading
 * - Relies on fal.ai's built-in retries (up to 10x) for transient failures
 * - Model fallback only switches between different models
 *
 * @param {object} view - View object { id, label }
 * @param {string} desc - Product description
 * @param {string} imageUrl - Public URL of the reference image (from Supabase storage)
 * @param {string} resolution - Resolution setting (e.g., '1K')
 * @param {number} attempt - Current attempt index (0-based)
 * @returns {Promise<{cdnUrl: string, label: string}>}
 */
export async function generateView(view, desc, imageUrl, resolution = '1K', attempt = 0) {
  const apiKey = FAL_API_KEY;
  if (!apiKey) throw new Error('FAL_API_KEY not configured');

  const request = ATTEMPTS[Math.min(attempt, ATTEMPTS.length - 1)];

  let result;
  try {
    // Step 1: Submit to queue with start timeout to cap retry duration
    const queueResponse = await submitToQueue(apiKey, request.url, request.body(view, desc, imageUrl, resolution), {
      startTimeout: 120
    });

    // Step 2: If we got a queue response with response_url, poll for result
    if (queueResponse.response_url) {
      result = await pollQueueResult(queueResponse.status_url || queueResponse.response_url, apiKey);
    } else {
      // Direct response (sync mode or already completed)
      result = queueResponse;
    }
  } catch (fetchErr) {
    console.error(`Attempt ${attempt} (${request.label}) failed:`, fetchErr.message);
    // If there are more attempts to try, recurse (model-level fallback)
    if (attempt < ATTEMPTS.length - 1) {
      const nextAttempt = attempt + 1;
      await new Promise(r => setTimeout(r, 1000));
      return generateView(view, desc, imageUrl, resolution, nextAttempt);
    }
    throw fetchErr;
  }

  // Extract image URL from response
  const imgUrl = extractImageUrl(result);

  if (!imgUrl) throw new Error('No image URL in response — ' + JSON.stringify(result).slice(0, 200));

  // ── Improvement: Return fal.ai CDN URL directly ──
  // Fal.ai serves results via their CDN (v3.fal.media).
  // These URLs are publicly accessible. Instead of downloading
  // and re-uploading to Supabase (which adds latency and cost),
  // we return the CDN URL directly. The status.js handler can
  // optionally mirror to Supabase storage for redundancy.
  return { cdnUrl: imgUrl, label: view.label };
}
