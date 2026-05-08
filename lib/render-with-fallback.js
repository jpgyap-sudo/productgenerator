// Hybrid render strategy: GPT-image-1-mini first, Gemini Flash fallback.
//
// Flow per view:
//   1. Generate with gpt-image-1-mini (cheap, fast)
//   2. If mini succeeds, run Gemini Flash vision quality check
//   3. If QC passes → keep mini result
//   4. If mini failed OR QC failed → re-generate with Gemini Flash image gen

import { generateOpenAIView } from './openai.js';
import { generateGeminiView } from './gemini.js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const QC_MODEL = 'gemini-2.5-flash';

async function verifyRenderQuality(imageUrl, productDesc, viewLabel) {
  if (!GEMINI_API_KEY) return { pass: true, reason: 'no api key' };

  let base64Data, mimeType;
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return { pass: true, reason: `fetch ${res.status}` };
    mimeType = res.headers.get('content-type') || 'image/jpeg';
    base64Data = Buffer.from(await res.arrayBuffer()).toString('base64');
  } catch (e) {
    return { pass: true, reason: 'fetch error' };
  }

  const prompt = `You are a quality checker for AI-generated furniture product renders.

Check if this image is an acceptable "${viewLabel}" view of: ${productDesc.substring(0, 200)}

PASS if the image shows:
- A recognizable furniture product (chair, sofa, table, lamp, etc.)
- Product occupies most of the frame and is clearly visible
- No severe AI artifacts, doubles, or melting/fragmentation

FAIL if:
- Product is missing, fragmented, or completely unrecognizable
- Multiple distinct products where one was expected
- Severe rendering corruption or blankness

Respond ONLY as JSON (no markdown): {"pass": true/false, "reason": "one sentence"}`;

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(`${GEMINI_API_BASE}/${QC_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text: prompt },
          { inlineData: { mimeType, data: base64Data } }
        ]}],
        generationConfig: { temperature: 0.1, maxOutputTokens: 128 }
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
  // View 4 (interior scene) skips mini entirely — Gemini Flash handles it well
  // and is cheaper than Pro. Interior compositions are too complex for mini.
  if (view.id === 4) {
    console.log(`[FALLBACK] View 4 (interior) — using Gemini Flash directly`);
    const result = await generateGeminiView(view, desc, imageUrl, resolution, brand, { forceFlash: true });
    return { ...result, usedFallback: true };
  }

  // Views 1–3: Try mini first
  let miniResult = null;
  try {
    miniResult = await generateOpenAIView(view, desc, imageUrl, resolution, brand, { provider: 'mini' });
  } catch (e) {
    console.log(`[FALLBACK] View ${view.id} mini error: ${e.message} — falling back to Gemini Flash`);
  }

  // Quality check if mini succeeded
  if (miniResult?.cdnUrl) {
    const { pass, reason } = await verifyRenderQuality(miniResult.cdnUrl, desc, view.label);
    if (pass) {
      console.log(`[FALLBACK] View ${view.id} mini OK (${reason})`);
      return { ...miniResult, usedFallback: false };
    }
    console.log(`[FALLBACK] View ${view.id} mini QC fail (${reason}) — falling back to Gemini Flash`);
  }

  // Gemini Flash fallback for views 1–3
  const result = await generateGeminiView(view, desc, imageUrl, resolution, brand, { forceFlash: true });
  return { ...result, usedFallback: true };
}
