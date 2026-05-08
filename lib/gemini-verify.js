// ═══════════════════════════════════════════════════════════════════
//  lib/gemini-verify.js — Gemini visual verification for product-image matching
//
//  After pattern matching (Phase 2), Gemini visually verifies the
//  top candidate matches by looking at the actual product image.
//  This catches cases where filenames are misleading or multiple
//  products share similar codes.
//
//  Strategy:
//    1. For each product with a pattern-matched candidate, send the
//       product info (name, code, description) + the candidate image
//       to Gemini
//    2. Gemini responds with: isMatch (yes/no/unsure), confidence, reason
//    3. Low-confidence matches are flagged for manual review
//
//  Cost optimization: Only verify matches where score < 100 (non-exact)
//  or where multiple candidates have similar scores.
// ═══════════════════════════════════════════════════════════════════

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash'; // Fast, cheap, multimodal vision
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Verify a single product-image match using Gemini vision.
 *
 * @param {object} product - { name, brand, productCode, description, category }
 * @param {string} imageDataUrl - Base64 data URL of the candidate image
 * @returns {Promise<{isMatch: boolean, confidence: string, reason: string}>}
 */
export async function verifyMatch(product, imageDataUrl) {
  if (!GEMINI_API_KEY) {
    console.log('[GEMINI-VERIFY] No API key configured, skipping visual verification');
    return { isMatch: true, confidence: 'skipped', reason: 'Gemini not configured' };
  }

  const apiUrl = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  // Extract base64 data from data URL
  const matches = imageDataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!matches) {
    console.log('[GEMINI-VERIFY] Invalid image data URL, skipping');
    return { isMatch: true, confidence: 'skipped', reason: 'Invalid image data' };
  }

  const mimeType = matches[1];
  const base64Data = matches[2];

  const promptText = `You are a product verification assistant. I will give you a product description and an image. Determine if the image shows the product described.

Product Information:
- Name: ${product.name || 'Unknown'}
- Brand: ${product.brand || 'Unknown'}
- Product Code: ${product.productCode || 'N/A'}
- Category: ${product.category || 'N/A'}
- Description: ${(product.description || 'N/A').substring(0, 500)}

Task: Does this image show the product described above?

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "isMatch": true/false,
  "confidence": "high" or "medium" or "low",
  "reason": "Brief explanation of your decision"
}`;

  const requestBody = {
    contents: [{
      role: 'user',
      parts: [
        { text: promptText },
        {
          inlineData: {
            mimeType,
            data: base64Data
          }
        }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 256
    }
  };

  console.log(`[GEMINI-VERIFY] Verifying match for "${product.name}" (code: ${product.productCode})`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[GEMINI-VERIFY] API error ${res.status}: ${errText.substring(0, 200)}`);
      return { isMatch: true, confidence: 'skipped', reason: `API error: ${res.status}` };
    }

    const data = await res.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!content) {
      console.error('[GEMINI-VERIFY] Empty response');
      return { isMatch: true, confidence: 'skipped', reason: 'Empty Gemini response' };
    }

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[GEMINI-VERIFY] No JSON in response:', content.substring(0, 200));
      return { isMatch: true, confidence: 'low', reason: 'Could not parse Gemini response' };
    }

    const result = JSON.parse(jsonMatch[0]);
    console.log(`[GEMINI-VERIFY] Result: isMatch=${result.isMatch}, confidence=${result.confidence}, reason="${result.reason}"`);

    return {
      isMatch: result.isMatch !== false, // default to true unless explicitly false
      confidence: result.confidence || 'low',
      reason: result.reason || 'No reason given'
    };
  } catch (err) {
    console.error(`[GEMINI-VERIFY] Error: ${err.message}`);
    return { isMatch: true, confidence: 'skipped', reason: `Error: ${err.message}` };
  }
}

/**
 * Verify multiple product-image matches in parallel.
 * Only verifies matches where score < 100 (non-exact) to save API calls.
 *
 * @param {Array} matches - Array of match objects from matchProductsToImages()
 * @param {Array} images - Array of image objects with dataUrl
 * @returns {Promise<Array>} Matches with added verification field
 */
/**
 * Visual search fallback: when pattern matching fails (score < 40 or no match),
 * send the product description + ALL unmatched images to Gemini and ask it
 * to find the best visual match.
 *
 * Strategy: Batch up to 5 candidate images per request to minimize API calls.
 * If more than 5 candidates, run multiple rounds.
 *
 * @param {object} product - { name, brand, productCode, description, category }
 * @param {Array} candidateImages - Array of { name, dataUrl, imageIndex }
 * @returns {Promise<{matchedImage: object|null, score: number, matchType: string, verification: object}>}
 */
export async function visualSearchMatch(product, candidateImages) {
  if (!GEMINI_API_KEY) {
    console.log('[GEMINI-VISUAL] No API key configured, skipping visual search');
    return null;
  }

  if (!candidateImages || candidateImages.length === 0) {
    console.log('[GEMINI-VISUAL] No candidate images to search');
    return null;
  }

  // Limit candidates to prevent huge payloads
  const MAX_CANDIDATES = 10;
  const candidates = candidateImages.slice(0, MAX_CANDIDATES);

  console.log(`[GEMINI-VISUAL] Searching ${candidates.length} images for "${product.name}" (code: ${product.productCode || 'N/A'})`);

  const apiUrl = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  // Build prompt with product info
  const promptText = `You are a product matching assistant. I will give you a product description and several images. Your task is to find which image BEST matches the product.

Product Information:
- Name: ${product.name || 'Unknown'}
- Brand: ${product.brand || 'Unknown'}
- Product Code: ${product.productCode || 'N/A'}
- Category: ${product.category || 'N/A'}
- Description: ${(product.description || 'N/A').substring(0, 800)}

Below are ${candidates.length} candidate images labeled Image-0 through Image-${candidates.length - 1}.

For each image, determine if it shows the product described above. Consider:
1. The product type/class (e.g., chair, sofa, table) — this is most important
2. The style and design features described
3. The materials and colors mentioned
4. The product code or model number if visible in the image

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "bestImageIndex": <number or null>,
  "confidence": "high" or "medium" or "low" or "none",
  "reason": "Brief explanation of your choice",
  "allScores": [
    {"index": 0, "isMatch": true/false, "confidence": "high/medium/low"},
    {"index": 1, "isMatch": true/false, "confidence": "high/medium/low"}
  ]
}

If NONE of the images match the product, set bestImageIndex to null and confidence to "none".`;

  // Build parts array: text prompt + all candidate images
  const parts = [{ text: promptText }];

  for (let i = 0; i < candidates.length; i++) {
    const img = candidates[i];
    const matches = img.dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (matches) {
      parts.push({
        inlineData: {
          mimeType: matches[1],
          data: matches[2]
        }
      });
    }
  }

  const requestBody = {
    contents: [{
      role: 'user',
      parts
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024
    }
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout for multi-image

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[GEMINI-VISUAL] API error ${res.status}: ${errText.substring(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!content) {
      console.error('[GEMINI-VISUAL] Empty response');
      return null;
    }

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[GEMINI-VISUAL] No JSON in response:', content.substring(0, 300));
      return null;
    }

    const result = JSON.parse(jsonMatch[0]);
    console.log(`[GEMINI-VISUAL] Result: bestImageIndex=${result.bestImageIndex}, confidence=${result.confidence}, reason="${result.reason}"`);

    if (result.bestImageIndex === null || result.bestImageIndex === undefined) {
      return null;
    }

    const bestIdx = result.bestImageIndex;
    const bestCandidate = candidates[bestIdx];
    if (!bestCandidate) {
      return null;
    }

    // Map confidence to a score for the match grid
    let visualScore = 60; // default for "medium" confidence
    if (result.confidence === 'high') visualScore = 85;
    else if (result.confidence === 'low') visualScore = 45;
    else if (result.confidence === 'none') return null;

    return {
      matchedImage: {
        ...bestCandidate,
        score: visualScore,
        matchType: 'visual-search'
      },
      score: visualScore,
      matchType: 'visual-search',
      verification: {
        isMatch: true,
        confidence: result.confidence,
        reason: result.reason || 'Gemini visual search match',
        allScores: result.allScores || []
      }
    };

  } catch (err) {
    console.error(`[GEMINI-VISUAL] Error: ${err.message}`);
    return null;
  }
}

/**
 * Verify multiple product-image matches in parallel.
 * Only verifies matches where score < 100 (non-exact) to save API calls.
 *
 * @param {Array} matches - Array of match objects from matchProductsToImages()
 * @param {Array} images - Array of image objects with dataUrl
 * @returns {Promise<Array>} Matches with added verification field
 */
export async function verifyMatches(matches, images) {
  const verificationTasks = matches.map(async (match) => {
    // Skip exact matches (score 100) — no need to verify
    if (match.score === 100) {
      return {
        ...match,
        verification: { isMatch: true, confidence: 'high', reason: 'Exact filename match' }
      };
    }

    // Skip matches with no image
    if (!match.matchedImage) {
      return {
        ...match,
        verification: { isMatch: false, confidence: 'none', reason: 'No image matched' }
      };
    }

    // Find the image data
    const imageIndex = match.matchedImage.imageIndex;
    const image = images[imageIndex];
    if (!image || !image.dataUrl) {
      return {
        ...match,
        verification: { isMatch: true, confidence: 'skipped', reason: 'No image data available' }
      };
    }

    // Verify with Gemini
    const verification = await verifyMatch(match.product, image.dataUrl);
    return { ...match, verification };
  });

  return Promise.all(verificationTasks);
}
