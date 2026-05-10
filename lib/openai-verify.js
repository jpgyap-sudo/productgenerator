// ═══════════════════════════════════════════════════════════════════
//  lib/openai-verify.js — OpenAI Vision Verification (Strict JSON)
//
//  After fast candidate filtering (Step 3), this module sends the
//  top candidates to OpenAI Vision for final verification. It asks
//  "Does this image match this product?" and returns a strict JSON
//  response with confidence score and visible attributes.
//
//  Architecture:
//    1. Receive product info + candidate image(s) + optional PDF crop
//    2. Send to OpenAI Vision with strict verification prompt
//    3. Parse JSON response with confidence, reason, visible attributes
//    4. Apply confidence rules: ≥90% auto-accept, 70-89% review, <70% reject
//
//  Key rules:
//    - NEVER auto-accept on API failure
//    - NEVER use sequential fallback
//    - Return "retry_needed" on 429/timeout/parse errors
//    - Use gpt-4.1-mini (cheap) or gpt-4o (accurate) based on env var
// ═══════════════════════════════════════════════════════════════════

import { withRetry } from './retry-manager.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERIFY_MODEL = process.env.OPENAI_VERIFY_MODEL || 'gpt-4.1-mini';
const OPENAI_API_BASE = 'https://api.openai.com/v1';

const AUTO_ACCEPT_THRESHOLD = parseInt(process.env.MATCH_AUTO_ACCEPT || '90', 10);
const REVIEW_THRESHOLD = parseInt(process.env.MATCH_REVIEW_THRESHOLD || '70', 10);

/**
 * Verify a single product against a single candidate image using OpenAI Vision.
 *
 * @param {object} product - Product info { name, productCode, description, category, material, color, dimensions }
 * @param {string} imageDataUrl - Base64 data URL of the candidate image
 * @param {string|null} [pdfImageDataUrl] - Optional PDF page image for visual reference
 * @returns {Promise<object>} Verification result
 */
export async function verifyMatch(product, imageDataUrl, pdfImageDataUrl = null) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  const productInfo = JSON.stringify({
    name: product.name || '',
    code: product.productCode || product.generatedCode || '',
    description: product.description || '',
    category: product.category || '',
    material: product.material || '',
    color: product.color || '',
    dimensions: product.dimensions || ''
  });

  const prompt = `You are a product verification assistant. Determine if the image shows the product described below.

PRODUCT INFORMATION:
${productInfo}

TASK:
Look at the image provided and determine if it visually matches the product described above.

Return STRICT JSON ONLY with this exact structure:
{
  "match": true,
  "confidence": 94,
  "reason": "Rounded upholstered brown chair with black tapered legs matches the product description.",
  "visible_attributes": {
    "type": "chair",
    "color": "brown",
    "material": "fabric",
    "style": "modern",
    "has_arms": true,
    "leg_type": "tapered",
    "leg_color": "black"
  }
}

RULES:
- "match" must be true or false
- "confidence" must be an integer 0-100
- Auto-accept if confidence >= ${AUTO_ACCEPT_THRESHOLD}
- Needs review if confidence >= ${REVIEW_THRESHOLD} and < ${AUTO_ACCEPT_THRESHOLD}
- Reject if confidence < ${REVIEW_THRESHOLD}
- "reason" should explain WHY it matches or doesn't match
- "visible_attributes" should describe what you actually see in the image
- Return ONLY valid JSON, no markdown, no code fences`;

  // Build message content with images
  const content = [{ type: 'text', text: prompt }];

  // Add PDF reference image first if available (for visual comparison context)
  if (pdfImageDataUrl) {
    content.push({
      type: 'image_url',
      image_url: {
        url: pdfImageDataUrl,
        detail: 'high' // High detail for the reference image
      }
    });
  }

  // Add the candidate image
  content.push({
    type: 'image_url',
    image_url: {
      url: imageDataUrl,
      detail: 'high' // High detail for verification
    }
  });

  const requestBody = {
    model: VERIFY_MODEL,
    messages: [
      {
        role: 'user',
        content
      }
    ],
    max_tokens: 500,
    temperature: 0.1,
    response_format: { type: 'json_object' }
  };

  const executeVerify = async () => {
    const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(45000) // 45 second timeout
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const err = new Error(`OpenAI API error (${res.status}): ${errText || res.statusText}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    // Parse JSON response
    let result;
    try {
      result = JSON.parse(content);
    } catch (parseErr) {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error(`Failed to parse verification JSON: ${parseErr.message}`);
      }
    }

    // Validate required fields
    if (result.match === undefined) {
      throw new Error('Verification response missing "match" field');
    }

    // Ensure confidence is a number
    result.confidence = parseInt(result.confidence, 10);
    if (isNaN(result.confidence)) {
      result.confidence = 0;
    }

    // Determine status based on confidence
    let status;
    if (result.confidence >= AUTO_ACCEPT_THRESHOLD) {
      status = 'auto_accepted';
    } else if (result.confidence >= REVIEW_THRESHOLD) {
      status = 'needs_review';
    } else {
      status = 'rejected';
    }

    return {
      isMatch: result.match,
      confidence: result.confidence,
      reason: result.reason || '',
      visibleAttributes: result.visible_attributes || {},
      status,
      model: VERIFY_MODEL
    };
  };

  return withRetry(executeVerify, {
    maxRetries: 3,
    delays: [15000, 45000, 90000],
    onRetry: (attempt, delay, err) => {
      console.log(`[OPENAI-VERIFY] Retry ${attempt}/3 in ${(delay / 1000).toFixed(0)}s: ${err.message}`);
    }
  });
}

/**
 * Verify a product against multiple candidate images.
 * Returns the best matching candidate with confidence.
 *
 * @param {object} product - Product info
 * @param {Array<{imageIndex: number, imageName: string, dataUrl: string, score: number}>} candidates - Ranked candidates
 * @param {string|null} pdfImageDataUrl - Optional PDF page image
 * @returns {Promise<object>} Best match result
 */
export async function verifyCandidates(product, candidates, pdfImageDataUrl = null) {
  if (!candidates || candidates.length === 0) {
    return {
      bestMatch: null,
      allResults: [],
      status: 'no_candidates',
      reason: 'No candidate images available for verification'
    };
  }

  console.log(`[OPENAI-VERIFY] Verifying "${product.name || product.productCode}" against ${candidates.length} candidates`);

  const allResults = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    console.log(`[OPENAI-VERIFY] Candidate ${i + 1}/${candidates.length}: "${candidate.imageName}" (filter score: ${candidate.score})`);

    const result = await verifyMatch(product, candidate.dataUrl, pdfImageDataUrl);

    allResults.push({
      imageIndex: candidate.imageIndex,
      imageName: candidate.imageName,
      filterScore: candidate.score,
      ...result
    });

    // If auto-accepted, stop checking further candidates
    if (result.success && result.data?.status === 'auto_accepted') {
      console.log(`[OPENAI-VERIFY] Auto-accepted candidate "${candidate.imageName}" with ${result.data.confidence}% confidence`);
      break;
    }

    // Small delay between candidates to avoid rate limits
    if (i < candidates.length - 1) {
      const delayMs = parseInt(process.env.OPENAI_VERIFY_DELAY_MS || '2000', 10);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  // Find the best match
  const successfulResults = allResults.filter(r => r.success && r.data);
  const bestMatch = successfulResults.length > 0
    ? successfulResults.reduce((best, current) => {
        const bestConf = best.data?.confidence || 0;
        const currConf = current.data?.confidence || 0;
        return currConf > bestConf ? current : best;
      })
    : null;

  // Determine overall status
  let overallStatus;
  if (bestMatch && bestMatch.data?.status === 'auto_accepted') {
    overallStatus = 'auto_accepted';
  } else if (bestMatch && bestMatch.data?.status === 'needs_review') {
    overallStatus = 'needs_review';
  } else if (allResults.some(r => !r.success)) {
    overallStatus = 'retry_needed';
  } else {
    overallStatus = 'rejected';
  }

  return {
    bestMatch: bestMatch ? {
      imageIndex: bestMatch.imageIndex,
      imageName: bestMatch.imageName,
      filterScore: bestMatch.filterScore,
      isMatch: bestMatch.data.isMatch,
      confidence: bestMatch.data.confidence,
      reason: bestMatch.data.reason,
      visibleAttributes: bestMatch.data.visibleAttributes,
      status: bestMatch.data.status
    } : null,
    allResults: allResults.map(r => ({
      imageIndex: r.imageIndex,
      imageName: r.imageName,
      filterScore: r.filterScore,
      success: r.success,
      data: r.data,
      error: r.error
    })),
    status: overallStatus,
    reason: bestMatch?.data?.reason || 'No matching candidate found'
  };
}

/**
 * Verify all products in a batch against their candidates.
 * Processes products sequentially with configurable concurrency.
 *
 * @param {Array<object>} products - All products
 * @param {Array<{productIndex: number, candidates: Array}>} candidateResults - Filtered candidates per product
 * @param {Array<object>} pdfImages - PDF page images (optional)
 * @param {object} [options]
 * @param {number} [options.concurrency=2] - Max concurrent verifications
 * @param {function} [options.onProgress] - Progress callback (completed, total, product)
 * @returns {Promise<Array<object>>} Verification results per product
 */
export async function verifyAllProducts(products, candidateResults, pdfImages = [], options = {}) {
  const concurrency = options.concurrency || parseInt(process.env.OPENAI_MAX_CONCURRENCY || '2', 10);
  const onProgress = options.onProgress || null;

  if (!products || products.length === 0) {
    return [];
  }

  console.log(`[OPENAI-VERIFY] Verifying ${products.length} products (concurrency: ${concurrency})`);

  const results = [];
  let completed = 0;

  // Process in batches for concurrency control
  for (let batchStart = 0; batchStart < products.length; batchStart += concurrency) {
    const batchEnd = Math.min(batchStart + concurrency, products.length);
    const batchProducts = products.slice(batchStart, batchEnd);

    console.log(`[OPENAI-VERIFY] Processing batch ${Math.floor(batchStart / concurrency) + 1}/${Math.ceil(products.length / concurrency)} (products ${batchStart + 1}-${batchEnd})`);

    const batchResults = await Promise.allSettled(
      batchProducts.map(async (product, batchIdx) => {
        const productIndex = batchStart + batchIdx;
        const productCandidates = candidateResults.find(c => c.productIndex === productIndex);

        // Find PDF image for this product
        let pdfImageDataUrl = null;
        if (pdfImages.length > 0) {
          if (product.page && pdfImages[product.page - 1]) {
            pdfImageDataUrl = pdfImages[product.page - 1].dataUrl;
          } else if (productIndex < pdfImages.length) {
            pdfImageDataUrl = pdfImages[productIndex].dataUrl;
          }
        }

        const candidates = productCandidates?.candidates || [];

        if (candidates.length === 0) {
          return {
            productIndex,
            product,
            bestMatch: null,
            allResults: [],
            status: 'no_candidates',
            reason: 'No candidates passed filtering'
          };
        }

        const result = await verifyCandidates(product, candidates, pdfImageDataUrl);
        return {
          productIndex,
          product,
          ...result
        };
      })
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      }
      completed++;
      if (onProgress) {
        onProgress(completed, products.length, result.value);
      }
    }

    // Delay between batches to avoid rate limits
    if (batchEnd < products.length) {
      const delayMs = parseInt(process.env.OPENAI_VERIFY_DELAY_MS || '2000', 10);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  const autoAccepted = results.filter(r => r.status === 'auto_accepted').length;
  const needsReview = results.filter(r => r.status === 'needs_review').length;
  const rejected = results.filter(r => r.status === 'rejected').length;
  const retryNeeded = results.filter(r => r.status === 'retry_needed').length;
  const noCandidates = results.filter(r => r.status === 'no_candidates').length;

  console.log(`[OPENAI-VERIFY] Complete: ${results.length} products | ${autoAccepted} auto-accepted | ${needsReview} needs review | ${rejected} rejected | ${retryNeeded} retry needed | ${noCandidates} no candidates`);

  return results;
}
