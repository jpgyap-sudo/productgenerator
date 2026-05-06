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

const VIEW_PROMPTS = [
  { id: 1, prompt: d => `Use the reference image as the product identity for this ${buildDesc(d)}. Create a clean front-facing studio catalog photo on a solid white background. Preserve the EXACT same product — same color, material, shape, texture, and all visible details. Do NOT change the product into a different object. Soft even lighting, centered composition.` },
  { id: 2, prompt: d => `Use the reference image as the product identity for this ${buildDesc(d)}. Create a clean side-profile studio catalog photo on a solid white background. Preserve the EXACT same product — same color, material, shape, texture, and all visible details. Do NOT change the product into a different object. Soft even lighting, centered composition.` },
  { id: 3, prompt: d => `Use the reference image as the product identity for this ${buildDesc(d)}. Create a clean 45-degree isometric studio catalog photo on a solid white background. Preserve the EXACT same product — same color, material, shape, texture, and all visible details. Do NOT change the product into a different object. Soft even lighting, centered composition.` },
  { id: 4, prompt: d => `Use the reference image as the product identity for this ${buildDesc(d)}. Create a clean rear-view studio catalog photo on a solid white background. Infer hidden rear details naturally from the visible design. Preserve the EXACT same product — same color, material, shape, texture. Do NOT change the product into a different object. Soft even lighting, centered composition.` },
  { id: 5, prompt: d => `Use the reference image as the product identity for this ${buildDesc(d)}. Place the EXACT same product in a refined modern dining interior with a round dark marble table, warm pendant light, light wood floor, large windows, and natural decor. Do NOT change the product into a different object. Photorealistic interior product photography.` }
];

/**
 * Attempt configurations for generating a view, tried in order.
 * Uses the correct fal.ai endpoint (no /edit suffix) with documented parameters.
 */
const ATTEMPTS = [
  {
    label: 'Nano Banana 2',
    url: 'https://queue.fal.run/fal-ai/nano-banana-2',
    body: (view, desc, imageUrl, resolution) => ({
      prompt: (VIEW_PROMPTS.find(v => v.id === view.id) || VIEW_PROMPTS[0]).prompt(desc),
      image_url: imageUrl,  // single image URL (not array)
      resolution: resolution || '1K',
      aspect_ratio: view.id === 5 ? '16:9' : '1:1',
      output_format: 'jpeg',
      num_images: 1,
      safety_tolerance: 4,  // default, number not string
      enable_safety_checker: true
    })
  },
  {
    label: 'Nano Banana 2 simple',
    url: 'https://queue.fal.run/fal-ai/nano-banana-2',
    body: (view, desc, imageUrl, resolution) => ({
      prompt: fallbackPrompt(view, desc),
      image_url: imageUrl,
      resolution: resolution || '1K',
      aspect_ratio: 'auto',
      output_format: 'jpeg',
      num_images: 1,
      safety_tolerance: 4,
      enable_safety_checker: true
    })
  },
  {
    label: 'Nano Banana classic',
    url: 'https://queue.fal.run/fal-ai/nano-banana',
    body: (view, desc, imageUrl, resolution) => ({
      prompt: fallbackPrompt(view, desc),
      image_url: imageUrl,
      aspect_ratio: view.id === 5 ? '16:9' : '1:1',
      output_format: 'jpeg',
      num_images: 1,
      safety_tolerance: 4,
      enable_safety_checker: true
    })
  },
  {
    label: 'GPT Image 2 medium',
    url: 'https://queue.fal.run/openai/gpt-image-2',
    body: (view, desc, imageUrl, resolution) => ({
      prompt: fallbackPrompt(view, desc),
      image_url: imageUrl,
      image_size: view.id === 5 ? 'landscape_16_9' : 'square_hd',
      quality: 'hd',
      num_images: 1,
      output_format: 'jpeg'
    })
  }
];

/**
 * Submit a generation job to fal.ai using their queue-based API.
 * Returns a { request_id, response_url, status_url } object for polling.
 * 
 * This is the RECOMMENDED approach for long-running generations.
 * Instead of waiting synchronously for the result, we submit the job
 * and poll the status_url until it completes.
 * 
 * @param {string} apiKey - fal.ai API key
 * @param {string} url - Model endpoint URL
 * @param {object} body - Request body parameters
 * @returns {Promise<{request_id: string, response_url: string, status_url: string}>}
 */
export function getAttemptCount() {
  return ATTEMPTS.length;
}

export function getViewById(viewId) {
  return VIEWS.find(view => view.id === Number(viewId)) || null;
}

async function submitToQueue(apiKey, url, body) {
  const queueUrl = `${url}`;
  const res = await fetch(queueUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Key ${apiKey}`,
      'Content-Type': 'application/json'
    },
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
  
  // fal.ai queue response contains request_id and response_url for polling.
  if (data.request_id && data.response_url) {
    return {
      request_id: data.request_id,
      response_url: data.response_url,
      status_url: data.status_url || data.response_url
    };
  }
  
  // If the response already contains images (sync mode), return directly
  if (data.images || data.output) {
    return data;
  }
  
  // Otherwise return the full response (may be the result directly)
  return data;
}

export async function submitViewJob(view, desc, imageUrl, resolution = '1K', attempt = 0) {
  const apiKey = FAL_API_KEY;
  if (!apiKey) throw new Error('FAL_API_KEY not configured');
  if (!view) throw new Error('Unknown view');

  const request = ATTEMPTS[Math.min(attempt, ATTEMPTS.length - 1)];
  const queueResponse = await submitToQueue(apiKey, request.url, request.body(view, desc, imageUrl, resolution));

  return {
    ...queueResponse,
    attempt,
    attempt_label: request.label
  };
}

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

  if (status && !['COMPLETED', 'SUCCESS', 'FAILED', 'ERROR'].includes(status)) {
    return { state: 'pending', status };
  }

  if (status === 'FAILED' || status === 'ERROR') {
    return { state: 'error', error: statusData.error || statusData.detail || 'Queue job failed' };
  }

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
 * @param {string} statusUrl - The URL to poll for status
 * @param {string} apiKey - fal.ai API key
 * @param {number} timeoutMs - Maximum time to wait in ms (default: 5 minutes)
 * @param {number} intervalMs - Polling interval in ms (default: 2000)
 * @returns {Promise<object>} - The completed result
 */
async function pollQueueResult(statusUrl, apiKey, timeoutMs = 120000, intervalMs = 2000) {
  const startTime = Date.now();
  
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
    
    // Check status
    if (data.status === 'COMPLETED' || data.status === 'completed' || data.status === 'SUCCESS') {
      return data;
    }
    
    if (data.status === 'FAILED' || data.status === 'failed' || data.status === 'ERROR') {
      throw new Error(data.error || data.detail || 'Queue job failed');
    }
    
    // Still processing — wait and retry
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

/**
 * Generate a single view using fal.ai queue-based API.
 * Tries multiple model configurations with fallback logic.
 * 
 * @param {object} view - View object { id, label }
 * @param {string} desc - Product description
 * @param {string} imageUrl - Public URL of the reference image (from Supabase storage)
 * @param {string} resolution - Resolution setting (e.g., '1K')
 * @param {number} attempt - Current attempt index (0-based)
 * @returns {Promise<{b64: string, label: string, dataUrl: string}>}
 */
export async function generateView(view, desc, imageUrl, resolution = '1K', attempt = 0) {
  const apiKey = FAL_API_KEY;
  if (!apiKey) throw new Error('FAL_API_KEY not configured');

  const request = ATTEMPTS[Math.min(attempt, ATTEMPTS.length - 1)];
  
  let result;
  try {
    // Step 1: Submit to queue
    const queueResponse = await submitToQueue(apiKey, request.url, request.body(view, desc, imageUrl, resolution));
    
    // Step 2: If we got a queue response with response_url, poll for result
    if (queueResponse.response_url) {
      result = await pollQueueResult(queueResponse.status_url || queueResponse.response_url, apiKey);
    } else {
      // Direct response (sync mode or already completed)
      result = queueResponse;
    }
  } catch (fetchErr) {
    console.error(`Attempt ${attempt} (${request.label}) failed:`, fetchErr.message);
    // If there are more attempts to try, recurse
    if (attempt < ATTEMPTS.length - 1) {
      const nextAttempt = attempt + 1;
      await new Promise(r => setTimeout(r, 1000));
      return generateView(view, desc, imageUrl, resolution, nextAttempt);
    }
    throw fetchErr;
  }

  // Extract image URL from response (handles various response formats)
  const imgUrl = extractImageUrl(result);
    
  if (!imgUrl) throw new Error('No image URL in response — ' + JSON.stringify(result).slice(0, 200));

  // Fetch image and convert to base64
  const imgRes = await fetch(imgUrl);
  if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
  const imgBlob = await imgRes.blob();
  const buffer = await imgBlob.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const src = `data:image/jpeg;base64,${base64}`;

  return { b64: base64, label: view.label, dataUrl: src };
}
