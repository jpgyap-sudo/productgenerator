// ═══════════════════════════════════════════════════════════════════
//  Stability AI SDXL API Module
//  Uses Stability AI's API directly for product photography
//  image generation via SDXL models.
//
//  Models:
//    - sdxl-v1.0 (default) — Stable Diffusion XL base model
//    - sdxl-v1.0-turbo — Faster, lower-cost variant
//
//  Endpoint: https://api.stability.ai/v2beta/stable-image/generate/sdxl
//  Reference: https://platform.stability.ai/docs/api-reference
//
//  Pricing: https://platform.stability.ai/pricing
//    - SDXL 1.0: ~$0.01 per image (1024x1024)
//    - SDXL Turbo: ~$0.003 per image (cheap/mini option)
// ═══════════════════════════════════════════════════════════════════

import { supabase, BUCKET_NAME } from './supabase.js';
import { VIEW_PROMPTS } from './fal.js';

const STABILITY_API_KEY = process.env.STABILITY_API_KEY;
const STABILITY_SDXL_MODEL = process.env.STABILITY_SDXL_MODEL || 'sdxl-v1.0';
const STABILITY_SDXL_MODEL_CHEAP = process.env.STABILITY_SDXL_MODEL_CHEAP || 'sdxl-v1.0-turbo';

if (!STABILITY_API_KEY) {
  console.error('Missing STABILITY_API_KEY environment variable');
}

const STABILITY_API_BASE = 'https://api.stability.ai/v2beta/stable-image';

/**
 * Determine which Stability AI model to use based on the provider setting.
 * If the provider includes "cheap" or "mini", use the turbo model.
 * Otherwise, use the default SDXL model.
 *
 * @param {string} provider - Provider string (e.g., 'stability', 'stability-cheap', 'stability-mini')
 * @returns {string} Stability AI model name
 */
function resolveModel(provider = '') {
  const p = provider.toLowerCase();
  if (p.includes('cheap') || p.includes('mini')) {
    return STABILITY_SDXL_MODEL_CHEAP;
  }
  return STABILITY_SDXL_MODEL;
}

/**
 * Map our resolution setting to Stability AI dimensions.
 * SDXL supports: 1024x1024, 1152x896, 1216x832, 1344x768, 1536x640, 640x1536, 768x1344, 832x1216, 896x1152
 */
function mapDimensions(resolution, isLandscape) {
  if (resolution === '4K' || resolution === '2K') {
    return isLandscape ? '1536x640' : '640x1536';
  }
  // 1K / 0.5K
  return isLandscape ? '1216x832' : '832x1216';
}

/**
 * Fetch a reference image and return it as a Buffer.
 *
 * @param {string} imageUrl - Public URL of the reference image
 * @returns {Promise<{buffer: Buffer, mimeType: string}>}
 */
async function fetchImageBuffer(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch reference image: ${res.status}`);
  }
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType: contentType };
}

/**
 * Generate a single view using Stability AI SDXL API.
 *
 * Uses the image-to-image endpoint with the reference image as multipart
 * form data for controlled generation. This ensures the AI understands
 * the original product's appearance and generates consistent views.
 *
 * SDXL image-to-image endpoint accepts:
 *   - image: The reference product image
 *   - prompt: Text description of the desired view
 *   - mode: "image-to-image" for reference-based generation
 *   - strength: How much to transform the image (0.0-1.0)
 *   - output_format: "png" or "jpeg"
 *
 * @param {object} view - View object { id, label }
 * @param {string} desc - Product description
 * @param {string} imageUrl - Public URL of the reference image (from Supabase storage)
 * @param {string} resolution - Resolution setting (e.g., '1K')
 * @param {string} brand - Optional furniture brand reference for more accurate renders
 * @param {object} [options] - Optional settings
 * @param {string} [options.provider] - Provider string to select model (e.g., 'stability-cheap')
 * @returns {Promise<{cdnUrl: string, label: string}>}
 */
export async function generateStabilityView(view, desc, imageUrl, resolution = '1K', brand = '', options = {}) {
  const apiKey = STABILITY_API_KEY;
  if (!apiKey) throw new Error('STABILITY_API_KEY not configured');

  // Resolve which model to use
  const model = resolveModel(options?.provider || '');
  const isCheapModel = model === STABILITY_SDXL_MODEL_CHEAP;

  // Build the prompt from VIEW_PROMPTS (shared with fal.ai, OpenAI, Gemini)
  const promptEntry = VIEW_PROMPTS.find(v => v.id === view.id) || VIEW_PROMPTS[0];
  let promptText = promptEntry.prompt(desc);

  // Inject brand reference if provided
  if (brand && brand.trim()) {
    promptText += `\n\nIMPORTANT — Brand Reference: The product is from the brand "${brand.trim()}". Research this brand's style, design language, and aesthetic. Use the brand's known design philosophy, material choices, color palette, and overall aesthetic to make the render more authentic and aligned with the brand's identity.`;
  }

  // Map resolution to Stability AI dimensions
  const isLandscape = view.id === 4;
  const dimensions = mapDimensions(resolution, isLandscape);

  console.log(`[STABILITY] Generating view ${view.id} (${view.label}) using ${model}${isCheapModel ? ' (cheap/mini mode)' : ''}, dimensions=${dimensions}`);

  // ── Fetch the reference image for image-to-image ──
  const { buffer: imageBuffer, mimeType: imageMimeType } = await fetchImageBuffer(imageUrl);

  // Build multipart form data for the SDXL image-to-image endpoint
  const formData = new FormData();

  // Reference image
  const imageBlob = new Blob([imageBuffer], { type: imageMimeType });
  formData.append('image', imageBlob, `reference.${imageMimeType.includes('png') ? 'png' : 'jpg'}`);

  // Prompt and negative prompt
  formData.append('prompt', promptText);
  formData.append('negative_prompt', 'blurry, low quality, distorted, deformed, ugly, bad anatomy, watermark, text, signature');

  // Image-to-image settings
  formData.append('mode', 'image-to-image');
  formData.append('strength', '0.65'); // 0.65 balances reference fidelity with creative transformation

  // Output settings
  formData.append('output_format', 'png');
  formData.append('style_preset', 'photographic'); // photographic, digital-art, cinematic, etc.

  // Model override (SDXL endpoint defaults to SDXL 1.0, but we can specify)
  if (model !== 'sdxl-v1.0') {
    formData.append('model', model);
  }

  // ── Add timeout to prevent hanging ──
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  let res;
  try {
    res = await fetch(`${STABILITY_API_BASE}/generate/sdxl`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
        // Note: Do NOT set Content-Type for FormData — fetch sets it
        // automatically with the correct multipart boundary
      },
      body: formData,
      signal: controller.signal
    });
  } catch (fetchErr) {
    clearTimeout(timeoutId);
    if (fetchErr.name === 'AbortError') {
      throw new Error('Stability AI API request timed out after 60 seconds');
    }
    throw fetchErr;
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    let errorDetail;
    try { errorDetail = await res.json(); } catch (e2) { /* ignore */ }
    const msg = typeof errorDetail === 'object'
      ? (errorDetail.message || errorDetail.error || errorDetail.name || JSON.stringify(errorDetail))
      : errorDetail;
    throw new Error(`Stability AI API error ${res.status}: ${msg || 'Unknown error'}`);
  }

  const data = await res.json();

  // Extract the image from the response
  // Stability AI returns { artifacts: [{ base64, seed, finishReason }] }
  if (!data?.artifacts?.[0]?.base64) {
    throw new Error('No image in Stability AI response — ' + JSON.stringify(data).slice(0, 300));
  }

  const base64Data = data.artifacts[0].base64;
  const buffer = Buffer.from(base64Data, 'base64');
  const mimeType = 'image/png';

  // Upload the generated image to Supabase storage
  const publicUrl = await uploadStabilityResult(buffer, mimeType, view.id);

  return { cdnUrl: publicUrl, label: view.label };
}

/**
 * Upload a Stability AI-generated image to Supabase storage and return the public URL.
 *
 * @param {Buffer} buffer - Image buffer
 * @param {string} mimeType - Image MIME type
 * @param {number} viewId - View ID for naming
 * @returns {Promise<string>} Public URL of the uploaded image
 */
async function uploadStabilityResult(buffer, mimeType, viewId) {
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const fileName = `stability_renders/view${viewId}_${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(fileName, buffer, {
      contentType: mimeType,
      upsert: true
    });

  if (uploadError) {
    throw new Error(`Failed to upload Stability AI result to storage: ${uploadError.message}`);
  }

  const { data: { publicUrl } } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(fileName);

  return publicUrl;
}
