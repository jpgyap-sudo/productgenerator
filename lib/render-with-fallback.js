// Hybrid render strategy: GPT-image-1-mini first, Gemini Flash fallback.
//
// Flow per view:
//   1. Generate with gpt-image-1-mini (cheap, fast)
//   2. If mini succeeds, run Gemini Flash vision QC — compares render against
//      the original reference image for color, material, and style fidelity
//   3. If QC passes → keep mini result
//   4. If mini failed OR QC failed → re-generate with Gemini Flash image gen

import { generateOpenAIView } from './openai.js';
import { generateGeminiView } from './gemini.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const QC_MODEL = 'gemini-2.5-flash';

async function fetchAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const mimeType = res.headers.get('content-type') || 'image/jpeg';
  const data = Buffer.from(await res.arrayBuffer()).toString('base64');
  return { mimeType, data };
}

// Compares the mini render against the original reference image.
// Checks that color, material, and overall style are consistent.
async function verifyRenderQuality(renderUrl, referenceUrl, productDesc, viewLabel) {
  if (!GEMINI_API_KEY) return { pass: true, reason: 'no api key' };

  let render, reference;
  try {
    [render, reference] = await Promise.all([
      fetchAsBase64(renderUrl),
      fetchAsBase64(referenceUrl)
    ]);
  } catch (e) {
    return { pass: true, reason: `fetch error: ${e.message}` };
  }

  const prompt = `You are a quality checker for AI-generated product renders used in a furniture e-commerce catalog.

I will show you TWO images:
- Image 1: the ORIGINAL reference product photo
- Image 2: an AI-generated render of that product from the "${viewLabel}" angle

Product description: ${productDesc.substring(0, 300)}

Check if the render (Image 2) faithfully represents the same product as the reference (Image 1).

PASS if:
- The render shows the same general product type (chair, sofa, table, etc.)
- Primary colors and materials are broadly consistent (e.g., dark wood stays dark, fabric color is similar)
- Product is clearly visible and not fragmented or corrupted

FAIL if:
- The color scheme is completely different (e.g., reference is burgundy velvet but render is brown leather)
- The frame material/finish is wrong (e.g., reference is black metal but render has gold legs)
- The product type changed entirely
- Severe AI artifacts, doubles, or blank image

Respond ONLY as JSON (no markdown): {"pass": true/false, "reason": "one sentence explaining the key match or mismatch"}`;

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 20000);

    const res = await fetch(`${GEMINI_API_BASE}/${QC_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text: prompt },
          { inlineData: { mimeType: reference.mimeType, data: reference.data } },
          { inlineData: { mimeType: render.mimeType, data: render.data } }
        ]}],
        generationConfig: { temperature: 0.1, maxOutputTokens: 150 }
      }),
      signal: controller.signal
    });
    clearTimeout(tid);

    if (!res.ok) return { pass: true, reason: `qc api ${res.status}` };

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { pass: true, reason: 'unparseable qc response' };

    const result = JSON.parse(match[0]);
    return { pass: result.pass !== false, reason: result.reason || '' };
  } catch (e) {
    return { pass: true, reason: `qc error: ${e.message}` };
  }
}

export async function generateWithFallback(view, desc, imageUrl, resolution = '1K', brand = '') {
  // View 4 (interior scene) skips mini entirely — too complex for mini to match faithfully
  if (view.id === 4) {
    console.log(`[FALLBACK] View 4 (interior) — using Gemini Flash directly`);
    const result = await generateGeminiView(view, desc, imageUrl, resolution, brand, { forceFlash: true });
    return { ...result, usedFallback: true, providerUsed: 'gemini-flash' };
  }

  // Views 1–3: Try mini first
  let miniResult = null;
  try {
    miniResult = await generateOpenAIView(view, desc, imageUrl, resolution, brand, { provider: 'mini' });
  } catch (e) {
    console.log(`[FALLBACK] View ${view.id} mini error: ${e.message} — falling back to Gemini Flash`);
  }

  // QC: compare render against reference image for color/material fidelity
  if (miniResult?.cdnUrl) {
    const { pass, reason } = await verifyRenderQuality(miniResult.cdnUrl, imageUrl, desc, view.label);
    if (pass) {
      console.log(`[FALLBACK] View ${view.id} mini passed QC (${reason})`);
      return { ...miniResult, usedFallback: false, providerUsed: 'gpt-image-1-mini' };
    }
    console.log(`[FALLBACK] View ${view.id} mini failed QC (${reason}) — falling back to Gemini Flash`);
  }

  // Gemini Flash fallback for views 1–3
  const result = await generateGeminiView(view, desc, imageUrl, resolution, brand, { forceFlash: true });
  return { ...result, usedFallback: true, providerUsed: 'gemini-flash' };
}
