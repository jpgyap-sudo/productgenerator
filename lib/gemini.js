// ═══════════════════════════════════════════════════════════════════
//  Gemini API Image Generation Module (Gemini 3)
//  Uses Google's Gemini API directly (not through fal.ai) for
//  product photography image generation.
//
//  Model strategy (based on https://ai.google.dev/gemini-api/docs/gemini-3):
//  - Views 1-4 (standard product shots): gemini-3.1-flash-image-preview
//    (Nano Banana 2 — high-quality, high-efficiency image generation)
//  - View 5 (interior scene): gemini-3-pro-image-preview
//    (Premium model for complex scene generation)
//
//  Reference: https://ai.google.dev/gemini-api/docs/image-generation
// ═══════════════════════════════════════════════════════════════════

import { supabase, BUCKET_NAME } from './supabase.js';
import { VIEW_PROMPTS } from './fal.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY environment variable');
}

/**
 * Gemini 3 model names for different view types.
 * Based on https://ai.google.dev/gemini-api/docs/gemini-3:
 *   - gemini-3.1-flash-image-preview (Nano Banana 2): views 1-4
 *     High-quality image generation with conversational editing
 *   - gemini-3-pro-image-preview: view 5 (premium interior scene)
 *     Premium model for complex scene generation
 */
const GEMINI_MODELS = {
  STANDARD: 'gemini-3.1-flash-image-preview', // Views 1-4 (Nano Banana 2)
  PREMIUM: 'gemini-3-pro-image-preview'       // View 5 (premium interior scene)
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
 * For views 1-4, uses gemini-3.1-flash-image-preview (Nano Banana 2).
 * For view 5, uses gemini-3-pro-image-preview (premium model).
 *
 * Gemini returns images as inline base64 data in the response.
 * We upload the result to Supabase storage and return the public URL.
 *
 * @param {object} view - View object { id, label }
 * @param {string} desc - Product description
 * @param {string} imageUrl - Public URL of the reference image (from Supabase storage)
 * @param {string} resolution - Resolution setting (e.g., '1K')
 * @returns {Promise<{cdnUrl: string, label: string}>}
 */
export async function generateGeminiView(view, desc, imageUrl, resolution = '1K') {
  const apiKey = GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  // Select Gemini 3 model based on view type
  // gemini-3.1-flash-image-preview (Nano Banana 2) for views 1-4,
  // gemini-3-pro-image-preview for view 5 (premium interior scene).
  const modelName = view.id === 5 ? GEMINI_MODELS.PREMIUM : GEMINI_MODELS.STANDARD;
  const apiUrl = `${GEMINI_API_BASE}/${modelName}:generateContent?key=${apiKey}`;

  // Build the prompt from VIEW_PROMPTS (shared with fal.ai)
  const promptEntry = VIEW_PROMPTS.find(v => v.id === view.id) || VIEW_PROMPTS[0];
  const promptText = promptEntry.prompt(desc);

  // Fetch reference image as base64 inline data
  const inlineImage = await imageUrlToInlineData(imageUrl);

  // Map resolution to Gemini's aspect ratio / generation config
  const isLandscape = view.id === 5;

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: promptText },
          {
            inlineData: {
              mimeType: inlineImage.mimeType,
              data: inlineImage.data
            }
          }
        ]
      }
    ],
    generationConfig: {
      // Request image output modality
      responseModalities: ['Image', 'Text'],
      // Aspect ratio guidance
      ...(isLandscape ? {} : {}),
      // Temperature for creative consistency
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

  console.log(`[GEMINI] Generating view ${view.id} (${view.label}) using model ${modelName}`);

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
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
    throw new Error(`Gemini API error ${res.status}: ${msg || 'Unknown error'}`);
  }

  const data = await res.json();

  // Extract the image from the response candidates
  const imageData = extractGeminiImage(data);
  if (!imageData) {
    throw new Error('No image in Gemini response — ' + JSON.stringify(data).slice(0, 300));
  }

  // Upload the generated image to Supabase storage
  const publicUrl = await uploadGeminiResult(imageData.buffer, imageData.mimeType, view.id);

  return { cdnUrl: publicUrl, label: view.label };
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
