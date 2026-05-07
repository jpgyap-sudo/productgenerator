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
import { createCanvas, loadImage } from '@napi-rs/canvas';

const STABILITY_SDXL_ENGINE = process.env.STABILITY_SDXL_ENGINE || 'stable-diffusion-xl-1024-v1-0';

const STABILITY_API_BASE = 'https://api.stability.ai/v1/generation';

function getStabilityApiKey() {
  return process.env.STABILITY_API_KEY || '';
}

function targetDimensionsForView(viewId) {
  return viewId === 4
    ? { width: 1216, height: 832 }
    : { width: 832, height: 1216 };
}

async function normalizeInitImage(buffer, viewId) {
  const target = targetDimensionsForView(viewId);
  const image = await loadImage(buffer);
  const canvas = createCanvas(target.width, target.height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, target.width, target.height);

  const padding = Math.round(Math.min(target.width, target.height) * 0.08);
  const maxWidth = target.width - padding * 2;
  const maxHeight = target.height - padding * 2;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  const drawWidth = Math.round(image.width * scale);
  const drawHeight = Math.round(image.height * scale);
  const drawX = Math.round((target.width - drawWidth) / 2);
  const drawY = Math.round((target.height - drawHeight) / 2);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);

  return {
    buffer: await canvas.encode('png'),
    mimeType: 'image/png',
    width: target.width,
    height: target.height
  };
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
  const apiKey = getStabilityApiKey();
  if (!apiKey) throw new Error('STABILITY_API_KEY not configured');

  // Build the prompt from VIEW_PROMPTS (shared with fal.ai, OpenAI, Gemini)
  const promptEntry = VIEW_PROMPTS.find(v => v.id === view.id) || VIEW_PROMPTS[0];
  let promptText = promptEntry.prompt(desc);

  // Inject brand reference if provided
  if (brand && brand.trim()) {
    promptText += `\n\nIMPORTANT — Brand Reference: The product is from the brand "${brand.trim()}". Research this brand's style, design language, and aesthetic. Use the brand's known design philosophy, material choices, color palette, and overall aesthetic to make the render more authentic and aligned with the brand's identity.`;
  }

  console.log(`[STABILITY] Generating view ${view.id} (${view.label}) using ${STABILITY_SDXL_ENGINE}`);

  // ── Fetch the reference image for image-to-image ──
  const { buffer: imageBuffer } = await fetchImageBuffer(imageUrl);
  const initImage = await normalizeInitImage(imageBuffer, view.id);
  console.log(`[STABILITY] Normalized reference image for view ${view.id} to ${initImage.width}x${initImage.height}`);

  // Build multipart form data for the SDXL v1 image-to-image endpoint
  const formData = new FormData();

  // Reference image
  const imageBlob = new Blob([initImage.buffer], { type: initImage.mimeType });
  formData.append('init_image', imageBlob, 'reference.png');

  // Prompt and negative prompt
  formData.append('text_prompts[0][text]', promptText);
  formData.append('text_prompts[0][weight]', '1');
  formData.append('text_prompts[1][text]', 'blurry, low quality, distorted, deformed, ugly, bad anatomy, watermark, text, signature');
  formData.append('text_prompts[1][weight]', '-1');

  // Image-to-image settings
  formData.append('init_image_mode', 'IMAGE_STRENGTH');
  formData.append('image_strength', '0.35');
  formData.append('cfg_scale', '7');
  formData.append('samples', '1');
  formData.append('steps', options?.provider?.includes('cheap') || options?.provider?.includes('mini') ? '20' : '30');

  // Output settings
  formData.append('style_preset', 'photographic'); // photographic, digital-art, cinematic, etc.

  // ── Add timeout to prevent hanging ──
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  let res;
  try {
    res = await fetch(`${STABILITY_API_BASE}/${STABILITY_SDXL_ENGINE}/image-to-image`, {
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
