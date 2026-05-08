// OpenAI GPT Image API module.
// Uses OpenAI directly for product photography image generation/editing.
//
// Default model: gpt-image-1-mini, overridable with OPENAI_IMAGE_MODEL.
// Default quality: medium, overridable with OPENAI_IMAGE_QUALITY.
// Endpoint: https://api.openai.com/v1/images/edits

import { supabase, BUCKET_NAME } from './supabase.js';
import { VIEW_PROMPTS } from './fal.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1-mini';
const OPENAI_IMAGE_MODEL_CHEAP = process.env.OPENAI_IMAGE_MODEL_CHEAP || 'gpt-image-1-mini';
const OPENAI_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'medium';

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY environment variable');
}

const OPENAI_API_BASE = 'https://api.openai.com/v1';

function mapResolution(resolution, isLandscape) {
  const size = resolution === '4K' || resolution === '2K' ? '1536' : '1024';
  if (isLandscape) return `${size}x1024`;
  return `1024x${size}`;
}

async function fetchImageBuffer(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch reference image: ${res.status}`);
  }
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType: contentType };
}

function resolveModel(provider = '') {
  const p = provider.toLowerCase();
  if (p.includes('cheap') || p.includes('mini')) {
    return OPENAI_IMAGE_MODEL_CHEAP;
  }
  return OPENAI_IMAGE_MODEL;
}

export async function generateOpenAIView(view, desc, imageUrl, resolution = '1K', brand = '', options = {}) {
  const apiKey = OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const model = resolveModel(options?.provider || '');
  const isCheapModel = model === OPENAI_IMAGE_MODEL_CHEAP;

  const promptEntry = VIEW_PROMPTS.find(v => v.id === view.id) || VIEW_PROMPTS[0];
  let promptText = promptEntry.prompt(desc);

  if (brand && brand.trim()) {
    promptText += `\n\nIMPORTANT - Brand Reference: The product is from the brand "${brand.trim()}". Research this brand's style, design language, and aesthetic. Use the brand's known design philosophy, material choices, color palette, and overall aesthetic to make the render more authentic and aligned with the brand's identity.`;
  }

  const isLandscape = view.id === 4;
  const imageSize = mapResolution(resolution, isLandscape);

  console.log(`[OPENAI] Generating view ${view.id} (${view.label}) using ${model}${isCheapModel ? ' (cheap/mini mode)' : ''}, size=${imageSize}, quality=${OPENAI_IMAGE_QUALITY}`);

  const { buffer: imageBuffer, mimeType: imageMimeType } = await fetchImageBuffer(imageUrl);
  const useLegacyDalle = model === 'dall-e-2';

  const formData = new FormData();
  const imageBlob = new Blob([imageBuffer], { type: imageMimeType });
  formData.append('image', imageBlob, `reference.${imageMimeType.includes('png') ? 'png' : 'jpg'}`);
  formData.append('prompt', promptText);
  formData.append('model', model);
  formData.append('n', '1');
  formData.append('size', imageSize);

  if (useLegacyDalle) {
    formData.append('quality', 'standard');
    formData.append('response_format', 'b64_json');
  } else {
    formData.append('quality', OPENAI_IMAGE_QUALITY);
    formData.append('output_format', 'png');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  let res;
  try {
    res = await fetch(`${OPENAI_API_BASE}/images/edits`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData,
      signal: controller.signal
    });
  } catch (fetchErr) {
    clearTimeout(timeoutId);
    if (fetchErr.name === 'AbortError') {
      throw new Error('OpenAI API request timed out after 60 seconds');
    }
    throw fetchErr;
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    let errorDetail;
    try { errorDetail = await res.json(); } catch (e2) { /* ignore */ }
    const msg = typeof errorDetail === 'object'
      ? (errorDetail.error?.message || errorDetail.error || JSON.stringify(errorDetail))
      : errorDetail;
    throw new Error(`OpenAI API error ${res.status}: ${msg || 'Unknown error'}`);
  }

  const data = await res.json();

  let imageBufferResult;
  let mimeTypeResult;

  if (data?.data?.[0]?.b64_json) {
    imageBufferResult = Buffer.from(data.data[0].b64_json, 'base64');
    mimeTypeResult = 'image/png';
  } else if (data?.data?.[0]?.url) {
    console.log(`[OPENAI] Got URL response, fetching image from: ${data.data[0].url}`);
    const imgRes = await fetch(data.data[0].url);
    if (!imgRes.ok) {
      throw new Error(`Failed to fetch generated image from URL: ${imgRes.status}`);
    }
    imageBufferResult = Buffer.from(await imgRes.arrayBuffer());
    mimeTypeResult = imgRes.headers.get('content-type') || 'image/png';
  } else {
    throw new Error('No image in OpenAI response - ' + JSON.stringify(data).slice(0, 300));
  }

  const publicUrl = await uploadOpenAIResult(imageBufferResult, mimeTypeResult, view.id);
  return { cdnUrl: publicUrl, label: view.label };
}

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
