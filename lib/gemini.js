// ═══════════════════════════════════════════════════════════════════
//  Gemini API Image Generation Module (Gemini 3)
//  Uses Google's Gemini API directly (not through fal.ai) for
//  product photography image generation.
//
//  Model strategy (based on https://ai.google.dev/gemini-api/docs/gemini-3):
//  - Views 1-3 (standard product shots): gemini-3.1-flash-image-preview
//    (high-quality, high-efficiency image generation)
//  - View 4 (interior scene): gemini-3-pro-image-preview
//    (Premium model for complex scene generation)
//
//  Reference: https://ai.google.dev/gemini-api/docs/image-generation
// ═══════════════════════════════════════════════════════════════════

import { supabase, BUCKET_NAME } from './supabase.js';
import { VIEW_PROMPTS } from './fal.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_TIMEOUT = parseInt(process.env.GEMINI_TIMEOUT_MS || '180000', 10);
const GEMINI_INTERIOR_TIMEOUT = parseInt(process.env.GEMINI_INTERIOR_TIMEOUT_MS || '420000', 10);

if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY environment variable');
}

// Model priority list per view type.
// gemini-3.x models require allowlist access; gemini-2.5-flash-image is the
// stable GA fallback. On 503/429 the code tries the next model in the list.
const GEMINI_MODELS = {
  STANDARD: [
    'gemini-3.1-flash-image-preview', // allowlist: high-efficiency
    'gemini-2.5-flash-image'          // GA stable fallback
  ],
  PREMIUM: [
    'gemini-3-pro-image-preview',     // allowlist: professional quality
    'gemini-3.1-flash-image-preview', // intermediate fallback
    'gemini-2.5-flash-image'          // GA stable fallback
  ]
};

/**
 * Gemini API base URL for the generateContent endpoint.
 */
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Convert a public image URL to base64 inline data for Gemini API.
 * Gemini requires reference images as inlineData (base64) parts.
 *
 * @param {string} imageUrl - Public URL of the reference image
 * @returns {Promise<{mimeType: string, data: string}>}
 */
async function imageUrlToInlineData(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch reference image: ${res.status}`);
  }

  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await res.arrayBuffer());
  const base64Data = buffer.toString('base64');

  return {
    mimeType: contentType,
    data: base64Data
  };
}

/**
 * Generate a single view using Gemini 3 API.
 *
 * For views 1-3, uses gemini-3.1-flash-image-preview.
 * For view 4, uses gemini-3-pro-image-preview (premium model).
 *
 * Gemini returns images as inline base64 data in the response.
 * We upload the result to Supabase storage and return the public URL.
 *
 * @param {object} view - View object { id, label }
 * @param {string} desc - Product description
 * @param {string} imageUrl - Public URL of the reference image (from Supabase storage)
 * @param {string} resolution - Resolution setting (e.g., '1K')
 * @param {string} brand - Optional furniture brand reference for more accurate renders
 * @returns {Promise<{cdnUrl: string, label: string}>}
 */
export async function generateGeminiView(view, desc, imageUrl, resolution = '1K', brand = '', options = {}) {
  const apiKey = GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  // forceFlash: always use the STANDARD model list even for view 4
  const modelList = (view.id === 4 && !options.forceFlash) ? GEMINI_MODELS.PREMIUM : GEMINI_MODELS.STANDARD;

  // Build prompt once (shared across model attempts)
  const promptEntry = VIEW_PROMPTS.find(v => v.id === view.id) || VIEW_PROMPTS[0];
  let promptText = promptEntry.prompt(desc);
  if (brand && brand.trim()) {
    promptText += `\n\nIMPORTANT — Brand Reference: The product is from the brand "${brand.trim()}". Use this brand's known design philosophy, material choices, color palette, and aesthetic to make the render more authentic.`;
  }

  const inlineImage = await imageUrlToInlineData(imageUrl);
  const requestTimeout = view.id === 4 ? GEMINI_INTERIOR_TIMEOUT : GEMINI_TIMEOUT;

  const requestBody = {
    contents: [{
      role: 'user',
      parts: [
        { text: promptText },
        { inlineData: { mimeType: inlineImage.mimeType, data: inlineImage.data } }
      ]
    }],
    generationConfig: {
      responseModalities: ['Image', 'Text'],
      temperature: 0.4,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 8192
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
    ]
  };

  let lastError;

  // Try each model in priority order; retry transient errors within each model
  for (const modelName of modelList) {
    const apiUrl = `${GEMINI_API_BASE}/${modelName}:generateContent?key=${apiKey}`;
    console.log(`[GEMINI] View ${view.id} (${view.label}) — trying model ${modelName}`);

    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), requestTimeout);

      let res;
      try {
        res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        if (fetchErr.name === 'AbortError') {
          lastError = new Error(`Gemini timeout after ${Math.round(requestTimeout / 1000)} seconds (model ${modelName})`);
          break; // timeout — skip to next model
        }
        lastError = fetchErr;
        break;
      }
      clearTimeout(timeoutId);

      // Transient overload — wait and retry same model
      if (res.status === 503 || res.status === 429) {
        let errorDetail;
        try { errorDetail = await res.json(); } catch (_) {}
        const msg = errorDetail?.error?.message || `HTTP ${res.status}`;
        lastError = new Error(`Gemini API error ${res.status}: ${msg}`);
        if (attempt < MAX_RETRIES) {
          const delay = attempt * 8000; // 8s, 16s
          console.log(`[GEMINI] ${res.status} on ${modelName} attempt ${attempt} — retrying in ${delay / 1000}s`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        console.log(`[GEMINI] ${res.status} exhausted on ${modelName} — trying next model`);
        break; // move to next model
      }

      if (!res.ok) {
        let errorDetail;
        try { errorDetail = await res.json(); } catch (_) {}
        const msg = errorDetail?.error?.message || errorDetail?.error || JSON.stringify(errorDetail || '');
        lastError = new Error(`Gemini API error ${res.status}: ${msg || 'Unknown error'}`);
        break; // non-transient error — skip to next model
      }

      const data = await res.json();
      const imageData = extractGeminiImage(data);
      if (!imageData) {
        lastError = new Error('No image in Gemini response — ' + JSON.stringify(data).slice(0, 300));
        break;
      }

      const publicUrl = await uploadGeminiResult(imageData.buffer, imageData.mimeType, view.id);
      console.log(`[GEMINI] View ${view.id} succeeded with model ${modelName}`);
      return { cdnUrl: publicUrl, label: view.label };
    } // end retry loop
  } // end model loop

  throw lastError || new Error(`Gemini image generation failed for view ${view.id}`);
}

/**
 * Extract image data from Gemini API response.
 * Gemini returns images as inlineData parts in the response candidates.
 *
 * @param {object} response - Gemini API response object
 * @returns {{buffer: Buffer, mimeType: string}|null}
 */
function extractGeminiImage(response) {
  if (!response?.candidates?.[0]?.content?.parts) {
    return null;
  }

  for (const part of response.candidates[0].content.parts) {
    if (part.inlineData && part.inlineData.data) {
      const buffer = Buffer.from(part.inlineData.data, 'base64');
      const mimeType = part.inlineData.mimeType || 'image/jpeg';
      return { buffer, mimeType };
    }
  }

  return null;
}

/**
 * Upload a Gemini-generated image to Supabase storage and return the public URL.
 *
 * @param {Buffer} buffer - Image buffer
 * @param {string} mimeType - Image MIME type
 * @param {number} viewId - View ID for naming
 * @returns {Promise<string>} Public URL of the uploaded image
 */
async function uploadGeminiResult(buffer, mimeType, viewId) {
  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const fileName = `gemini_renders/view${viewId}_${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(fileName, buffer, {
      contentType: mimeType,
      upsert: true
    });

  if (uploadError) {
    throw new Error(`Failed to upload Gemini result to storage: ${uploadError.message}`);
  }

  const { data: { publicUrl } } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(fileName);

  return publicUrl;
}
