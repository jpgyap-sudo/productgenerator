// ═══════════════════════════════════════════════════════════════════
//  Shared fal.ai API Logic — used by the background worker
// ═══════════════════════════════════════════════════════════════════

const FAL_API_KEY = process.env.FAL_API_KEY;

if (!FAL_API_KEY) {
  console.error('Missing FAL_API_KEY environment variable');
}

/**
 * Upload an image (from a URL) to fal.ai CDN for use as a reference image.
 * @param {string} imageUrl - Public URL of the image (e.g., from Supabase storage)
 * @returns {Promise<string>} - The fal.ai CDN URL
 */
export async function uploadToFal(imageUrl) {
  const apiKey = FAL_API_KEY;
  if (!apiKey) throw new Error('FAL_API_KEY not configured');

  // Step 1: Get storage auth token
  let tokenRes;
  try {
    tokenRes = await fetch('https://rest.alpha.fal.ai/storage/auth/token?storage_type=fal-cdn-v3', {
      method: 'POST',
      headers: { 'Authorization': `Key ${apiKey}`, 'Content-Type': 'application/json' },
      body: '{}'
    });
  } catch (e) {
    throw new Error(`Could not reach fal storage auth (${e.message})`);
  }
  if (!tokenRes.ok) throw new Error(`Storage auth failed: ${tokenRes.status} — check your fal.ai API key`);
  const { token, base_url } = await tokenRes.json();

  // Step 2: Fetch the image from the public URL
  let blob;
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`Fetch failed: ${imgRes.status}`);
    blob = await imgRes.blob();
  } catch (e) {
    throw new Error(`Could not fetch image from URL (${e.message})`);
  }

  // Step 3: Upload to fal CDN
  const form = new FormData();
  form.append('file', blob, 'product.jpg');
  let upRes;
  try {
    upRes = await fetch(`${base_url}/files/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: form
    });
  } catch (e) {
    throw new Error(`Could not upload to fal CDN (${e.message})`);
  }
  if (!upRes.ok) throw new Error(`CDN upload failed: ${upRes.status}`);
  const upData = await upRes.json();
  const url = upData.access_url || upData.url;
  if (!url) throw new Error('No URL in upload response');
  return url;
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
  return (desc && desc.trim()) ? desc : 'the product from the reference image';
}

function fallbackPrompt(view, desc) {
  const d = buildDesc(desc);
  if (view.id === 1) return `Create a clean studio product photo of this ${d} from the reference image on a white background.`;
  if (view.id === 5) return `Create a photorealistic modern interior scene featuring this ${d} from the reference image.`;
  return `Create a clean ${view.label.toLowerCase()} product photo of this ${d} from the reference image on a white background.`;
}

const VIEW_PROMPTS = [
  { id: 1, prompt: d => `Use the reference image as the product identity for this ${buildDesc(d)}. Create a clean front-facing studio catalog photo on a solid white background. Preserve the visible color, material, silhouette, and important details as closely as possible. Soft even lighting, centered composition.` },
  { id: 2, prompt: d => `Use the reference image as the product identity for this ${buildDesc(d)}. Create a clean side-profile studio catalog photo on a solid white background. Preserve the visible color, material, silhouette, and important details as closely as possible. Soft even lighting, centered composition.` },
  { id: 3, prompt: d => `Use the reference image as the product identity for this ${buildDesc(d)}. Create a clean 45-degree isometric studio catalog photo on a solid white background. Preserve the visible color, material, silhouette, and important details as closely as possible. Soft even lighting, centered composition.` },
  { id: 4, prompt: d => `Use the reference image as the product identity for this ${buildDesc(d)}. Create a clean rear-view studio catalog photo on a solid white background. Infer hidden rear details naturally from the visible design. Soft even lighting, centered composition.` },
  { id: 5, prompt: d => `Use the reference image as the product identity for this ${buildDesc(d)}. Place matching products in a refined modern dining interior with a round dark marble table, warm pendant light, light wood floor, large windows, and natural decor. Photorealistic interior product photography.` }
];

/**
 * Attempt configurations for generating a view, tried in order.
 */
const ATTEMPTS = [
  {
    label: 'Nano Banana 2',
    url: 'https://fal.run/fal-ai/nano-banana-2/edit',
    body: (view, desc, imageUrl, resolution) => ({
      prompt: (VIEW_PROMPTS.find(v => v.id === view.id) || VIEW_PROMPTS[0]).prompt(desc),
      image_urls: [imageUrl],
      resolution: resolution || '0.5K',
      aspect_ratio: view.id === 5 ? '16:9' : '1:1',
      output_format: 'jpeg',
      num_images: 1,
      limit_generations: true,
      safety_tolerance: '5'
    })
  },
  {
    label: 'Nano Banana 2 simple',
    url: 'https://fal.run/fal-ai/nano-banana-2/edit',
    body: (view, desc, imageUrl, resolution) => ({
      prompt: fallbackPrompt(view, desc),
      image_urls: [imageUrl],
      resolution: resolution || '0.5K',
      aspect_ratio: 'auto',
      output_format: 'jpeg',
      num_images: 1,
      limit_generations: true,
      safety_tolerance: '5'
    })
  },
  {
    label: 'Nano Banana classic',
    url: 'https://fal.run/fal-ai/nano-banana/edit',
    body: (view, desc, imageUrl, resolution) => ({
      prompt: fallbackPrompt(view, desc),
      image_urls: [imageUrl],
      aspect_ratio: view.id === 5 ? '16:9' : '1:1',
      output_format: 'jpeg',
      num_images: 1,
      limit_generations: false,
      safety_tolerance: '5'
    })
  },
  {
    label: 'GPT Image 2 medium',
    url: 'https://fal.run/openai/gpt-image-2/edit',
    body: (view, desc, imageUrl, resolution) => ({
      prompt: fallbackPrompt(view, desc),
      image_urls: [imageUrl],
      image_size: view.id === 5 ? 'landscape_16_9' : 'square',
      quality: 'medium',
      num_images: 1,
      output_format: 'jpeg'
    })
  }
];

/**
 * Call the fal.ai API to generate a single view.
 * Tries multiple model configurations with fallback logic.
 * @param {object} view - View object { id, label }
 * @param {string} desc - Product description
 * @param {string} imageUrl - fal.ai CDN URL of the reference image
 * @param {string} resolution - Resolution setting (e.g., '0.5K', '1K')
 * @param {number} attempt - Current attempt index (0-based)
 * @returns {Promise<{b64: string, label: string}>}
 */
export async function generateView(view, desc, imageUrl, resolution = '0.5K', attempt = 0) {
  const apiKey = FAL_API_KEY;
  if (!apiKey) throw new Error('FAL_API_KEY not configured');

  const request = ATTEMPTS[Math.min(attempt, ATTEMPTS.length - 1)];
  let result;
  try {
    result = await callFalEdit(apiKey, request.url, request.body(view, desc, imageUrl, resolution));
  } catch (fetchErr) {
    // If there are more attempts to try, recurse
    if (attempt < ATTEMPTS.length - 1) {
      const nextAttempt = attempt + 1;
      // Small delay before retry
      await new Promise(r => setTimeout(r, 1000));
      return generateView(view, desc, imageUrl, resolution, nextAttempt);
    }
    throw fetchErr;
  }

  const imgUrl = result.images?.[0]?.url || result.output?.images?.[0]?.url || result.data?.images?.[0]?.url;
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

/**
 * Low-level fal.ai API call.
 */
async function callFalEdit(apiKey, url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Key ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    let em = `API error ${res.status}`;
    try { em = await res.json(); } catch (e2) { /* ignore */ }
    const msg = typeof em === 'object' ? (em.message || em.detail || em.error || JSON.stringify(em)) : em;
    throw new Error(msg || `API error ${res.status}`);
  }

  return res.json();
}
