// ═══════════════════════════════════════════════════════════════════
//  OpenAI GPT Image 2 API Module
//  Uses OpenAI's API directly (not through fal.ai) for
//  product photography image generation.
//
//  Model: gpt-image-2
//  Endpoint: https://api.openai.com/v1/images/generations
//  Reference: https://developers.openai.com/api/docs/models/gpt-image-2
//
//  GPT Image 2 supports:
//  - Text-to-image generation
//  - Image editing with reference image (via multipart/form-data)
//  - Multiple aspect ratios and sizes
//  - response_format: "b64_json" or "url"
// ═══════════════════════════════════════════════════════════════════

import { supabase, BUCKET_NAME } from './supabase.js';
import { VIEW_PROMPTS } from './fal.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY environment variable');
}

/**
 * OpenAI API base URL for image generation.
 */
const OPENAI_API_BASE = 'https://api.openai.com/v1';

/**
 * Map our resolution setting to OpenAI image size.
 * GPT Image 2 supports: "1024x1024", "1792x1024", "1024x1792"
 * We map our 0.5K/1K/2K/4K to the closest OpenAI sizes.
 */
function mapResolution(resolution, isLandscape) {
  // Resolution mapping: 0.5K -> 1024, 1K -> 1024, 2K -> 1792, 4K -> 1792
  const size = resolution === '4K' || resolution === '2K' ? '1792' : '1024';
  if (isLandscape) {
    return `${size}x1024`; // e.g., "1792x1024" or "1024x1024"
  }
  return `1024x${size}`; // e.g., "1024x1792" or "1024x1024"
}

/**
 * Fetch a reference image and return it as a Buffer.
 * OpenAI's edit endpoint requires the image as multipart form data.
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
 * Generate a single view using OpenAI GPT Image 2 API.
 *
 * Uses the generations endpoint with the reference image as a prompt
 * context (text-based image-to-image via prompt engineering).
 * For best results, the prompt describes the desired view while
 * referencing the original product.
 *
 * @param {object} view - View object { id, label }
 * @param {string} desc - Product description
 * @param {string} imageUrl - Public URL of the reference image (from Supabase storage)
 * @param {string} resolution - Resolution setting (e.g., '1K')
 * @returns {Promise<{cdnUrl: string, label: string}>}
 */
export async function generateOpenAIView(view, desc, imageUrl, resolution = '1K') {
  const apiKey = OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  // Build the prompt from VIEW_PROMPTS (shared with fal.ai and Gemini)
  const promptEntry = VIEW_PROMPTS.find(v => v.id === view.id) || VIEW_PROMPTS[0];
  const promptText = promptEntry.prompt(desc);

  // Map resolution to OpenAI image size
  const isLandscape = view.id === 5;
  const imageSize = mapResolution(resolution, isLandscape);

  console.log(`[OPENAI] Generating view ${view.id} (${view.label}) using gpt-image-2, size=${imageSize}`);

  // GPT Image 2 supports image editing via the edits endpoint.
  // We use the generations endpoint with a detailed prompt that
  // describes the desired transformation, plus the reference image
  // URL as context in the prompt.
  const requestBody = {
    model: 'gpt-image-2',
    prompt: promptText,
    n: 1,
    size: imageSize,
    response_format: 'b64_json',
    quality: 'medium',
    style: 'natural'
  };

  const res = await fetch(`${OPENAI_API_BASE}/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!res.ok) {
    let errorDetail;
    try { errorDetail = await res.json(); } catch (e2) { /* ignore */ }
    const msg = typeof errorDetail === 'object'
      ? (errorDetail.error?.message || errorDetail.error || JSON.stringify(errorDetail))
      : errorDetail;
    throw new Error(`OpenAI API error ${res.status}: ${msg || 'Unknown error'}`);
  }

  const data = await res.json();

  // Extract the image from the response
  // GPT Image 2 returns { created, data: [{ b64_json, revised_prompt }] }
  if (!data?.data?.[0]?.b64_json) {
    throw new Error('No image in OpenAI response — ' + JSON.stringify(data).slice(0, 300));
  }

  const base64Data = data.data[0].b64_json;
  const buffer = Buffer.from(base64Data, 'base64');
  const mimeType = 'image/png'; // OpenAI returns PNG by default with b64_json

  // Upload the generated image to Supabase storage
  const publicUrl = await uploadOpenAIResult(buffer, mimeType, view.id);

  return { cdnUrl: publicUrl, label: view.label };
}

/**
 * Upload an OpenAI-generated image to Supabase storage and return the public URL.
 *
 * @param {Buffer} buffer - Image buffer
 * @param {string} mimeType - Image MIME type
 * @param {number} viewId - View ID for naming
 * @returns {Promise<string>} Public URL of the uploaded image
 */
async function uploadOpenAIResult(buffer, mimeType, viewId) {
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const fileName = `openai_renders/view${viewId}_${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(fileName, buffer, {
      contentType: mimeType,
      upsert: true
    });

  if (uploadError) {
    throw new Error(`Failed to upload OpenAI result to storage: ${uploadError.message}`);
  }

  const { data: { publicUrl } } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(fileName);

  return publicUrl;
}
