// ═══════════════════════════════════════════════════════════════════
//  lib/pdf-only-matcher.js — AI per-row matching for PDF-only uploads
//
//  When a user uploads only a PDF (no ZIP), this module:
//    1. Takes extracted products (from DeepSeek text analysis)
//    2. Takes PDF page images (extracted via sharp)
//    3. Uses GPT-4o Vision to match each product to its corresponding
//       PDF page image based on product code, description, and brand
//    4. Returns per-row results
//
//  Resilience features:
//    - Retry with exponential backoff (3 attempts: 5s, 15s, 30s)
//    - Gemini fallback when OpenAI is unavailable or rate-limited
//    - Timeout protection per product match (120s)
//    - Graceful degradation: individual product failures produce
//      "needs review" entries instead of crashing the whole batch
// ═══════════════════════════════════════════════════════════════════

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o';
const OPENAI_API_BASE = 'https://api.openai.com/v1';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const MAX_PRODUCTS_PER_BATCH = 3;  // Process 3 products at a time (slower = more reliable)
const MAX_IMAGES_PER_PRODUCT = 8;  // Max page images to consider per product
const MAX_RETRIES = 3;             // Max retry attempts per product
const RETRY_DELAYS = [5000, 15000, 30000]; // 5s, 15s, 30s exponential backoff
const MATCH_TIMEOUT_MS = 180000;   // 180s timeout per product match (generous for slow processing)
const INTER_BATCH_DELAY_MS = 3000; // 3s deliberate pause between batches to avoid rate limits

// ── Retry helper with exponential backoff ─────────────────────────

/**
 * Execute an async function with retry + exponential backoff.
 * Retries on network errors, 429 (rate limit), 5xx server errors.
 * Does NOT retry on 400 (bad request) or 401 (auth) errors.
 *
 * @param {Function} fn - Async function to execute
 * @param {object} [options]
 * @param {number} [options.maxRetries=3]
 * @param {number[]} [options.delays=[5000,15000,30000]]
 * @param {string} [options.label='operation'] - Label for logging
 * @returns {Promise<any>}
 */
async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const delays = options.delays ?? RETRY_DELAYS;
  const label = options.label || 'operation';
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Non-retryable errors — bail immediately
      const statusCode = err.status || err.statusCode || (err.message ? null : null);
      const isNonRetryable =
        err.message?.includes('400') ||
        err.message?.includes('401') ||
        err.message?.includes('403') ||
        err.message?.includes('invalid_api_key') ||
        err.message?.includes('insufficient_quota');

      if (isNonRetryable) {
        console.error(`[PDF-ONLY-MATCHER] ${label}: Non-retryable error, bailing: ${err.message}`);
        throw err;
      }

      if (attempt >= maxRetries) {
        console.error(`[PDF-ONLY-MATCHER] ${label}: All ${maxRetries + 1} attempts failed: ${err.message}`);
        throw err;
      }

      const delay = delays[attempt] || delays[delays.length - 1];
      console.warn(`[PDF-ONLY-MATCHER] ${label}: Attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${delay}ms: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// ── Timeout wrapper ───────────────────────────────────────────────

/**
 * Wrap a promise with a timeout.
 * @param {Promise} promise
 * @param {number} ms - Timeout in milliseconds
 * @param {string} [label='operation']
 * @returns {Promise<any>}
 */
function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout after ${ms}ms: ${label}`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// ── Gemini fallback matcher ───────────────────────────────────────

/**
 * Fallback: match a product to page images using Gemini Vision.
 * Used when OpenAI is unavailable or rate-limited.
 *
 * @param {object} product
 * @param {number} productIndex
 * @param {Array<object>} candidates
 * @returns {Promise<object>} Match result (same format as OpenAI path)
 */
async function matchWithGemini(product, productIndex, candidates) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured for fallback');
  }

  const apiUrl = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const productInfo = JSON.stringify({
    name: product.name || '',
    code: product.productCode || product.generatedCode || '',
    brand: product.brand || '',
    category: product.category || '',
    description: product.description || ''
  }, null, 2);

  const promptText = `You are a furniture product catalog matching expert. Match a product from a PDF catalog to the correct product image from the PDF pages.

PRODUCT INFORMATION (extracted from PDF text):
${productInfo}

Below are ${candidates.length} candidate PDF page images.

TASK:
1. Read the product information carefully
2. VISUALLY examine each candidate PDF page image
3. Find which page image BEST corresponds to this product
4. Provide a confidence score (0-100) and reasoning

MATCHING CRITERIA (in order of importance):
- The page image should show the actual product described
- Product type/category must match (e.g., chair → chair image)
- Design style should be consistent
- Colors and materials should align with the description

CRITICAL RULES:
- VISUALLY examine each page image — don't guess
- If NO image is a good match, set best_match_image_index to null
- Be honest about low-confidence matches

Return ONLY valid JSON, no markdown, no code fences:
{
  "best_match_image_index": 0,
  "best_match_confidence": 95,
  "best_match_reason": "The page image shows a modern armchair with wooden legs matching the product description",
  "overall_reason": "Strong visual match found between product description and page image"
}

If no good match exists:
{
  "best_match_image_index": null,
  "best_match_confidence": 0,
  "best_match_reason": "No page image matches this product description",
  "overall_reason": "No matching page image found"
}`;

  // Build inline image parts for Gemini
  const imageParts = candidates.map(c => {
    const matches = c.dataUrl?.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!matches) return null;
    return {
      inlineData: {
        mimeType: matches[1],
        data: matches[2]
      }
    };
  }).filter(Boolean);

  const requestBody = {
    contents: [{
      parts: [
        { text: promptText },
        ...imageParts
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1024
    }
  };

  console.log(`[PDF-ONLY-MATCHER] (Gemini fallback) Matching product #${productIndex + 1} "${product.name || product.productCode}"...`);

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error('Gemini returned empty response');
  }

  // Parse JSON from Gemini response (may be wrapped in markdown fences)
  let jsonStr = text.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (parseErr) {
    console.error(`[PDF-ONLY-MATCHER] Gemini parse error: ${text.substring(0, 200)}`);
    throw new Error('Failed to parse Gemini response as JSON');
  }

  const bestImageIndex = parsed.best_match_image_index;
  const confidence = parsed.best_match_confidence || 0;

  const bestMatch = bestImageIndex !== null && bestImageIndex !== undefined ? {
    imageIndex: bestImageIndex,
    imageName: candidates[bestImageIndex]?.name || `page_${bestImageIndex + 1}.png`,
    confidence,
    reason: parsed.best_match_reason || '',
    dataUrl: candidates[bestImageIndex]?.dataUrl || null,
    status: confidence >= 90 ? 'auto_accepted' : 'needs_review'
  } : null;

  const overallConfidence = confidence >= 90 ? 'high'
    : confidence >= 70 ? 'medium'
    : confidence >= 50 ? 'low'
    : 'none';

  return {
    productIndex,
    product,
    bestMatch,
    secondMatch: null,
    thirdMatch: null,
    overallConfidence,
    overallReason: parsed.overall_reason || bestMatch?.reason || '',
    confirmed: bestMatch?.status === 'auto_accepted'
  };
}

// ── Main matching function ────────────────────────────────────────

/**
 * Match products extracted from PDF text to PDF page images using GPT-4o Vision
 * with Gemini fallback, retry logic, and timeout protection.
 *
 * @param {Array<object>} products - Products extracted from PDF text via DeepSeek
 * @param {Array<object>} pageImages - PDF page images extracted via sharp
 * @returns {Promise<{matches: Array, stats: object}>}
 */
export async function matchPdfOnlyProducts(products, pageImages) {
  if (!OPENAI_API_KEY && !GEMINI_API_KEY) {
    throw new Error('Neither OPENAI_API_KEY nor GEMINI_API_KEY environment variable is set');
  }

  if (!products || products.length === 0) {
    throw new Error('No products to match');
  }

  if (!pageImages || pageImages.length === 0) {
    throw new Error('No PDF page images to match against');
  }

  console.log(`[PDF-ONLY-MATCHER] Starting per-row matching: ${products.length} products, ${pageImages.length} page images`);
  console.log(`[PDF-ONLY-MATCHER] Fallbacks available: ${GEMINI_API_KEY ? 'Gemini ✓' : 'Gemini ✗'}`);

  const matches = [];
  let autoAccepted = 0;
  let needsReview = 0;
  let usedFallback = false;

  // Process products in batches — slow and steady to avoid rate limits
  const totalBatches = Math.ceil(products.length / MAX_PRODUCTS_PER_BATCH);

  for (let batchStart = 0; batchStart < products.length; batchStart += MAX_PRODUCTS_PER_BATCH) {
    const batchNum = Math.floor(batchStart / MAX_PRODUCTS_PER_BATCH) + 1;
    const batchEnd = Math.min(batchStart + MAX_PRODUCTS_PER_BATCH, products.length);
    const batchProducts = products.slice(batchStart, batchEnd);

    console.log(`[PDF-ONLY-MATCHER] Processing batch ${batchNum}/${totalBatches}: products ${batchStart + 1}-${batchEnd}`);

    // Process each product in the batch concurrently with individual error isolation
    const batchResults = await Promise.allSettled(
      batchProducts.map((product, idx) => {
        const productIndex = batchStart + idx;
        return matchSingleProductWithFallback(product, productIndex, pageImages);
      })
    );

    for (let i = 0; i < batchResults.length; i++) {
      const result = batchResults[i];
      const productIndex = batchStart + i;

      if (result.status === 'fulfilled') {
        matches.push(result.value);
        if (result.value.overallConfidence === 'high') {
          autoAccepted++;
        } else {
          needsReview++;
        }
        if (result.value._usedFallback) {
          usedFallback = true;
        }
      } else {
        // Graceful degradation: individual product failure → "needs review" entry
        const failedProduct = batchProducts[i] || {};
        console.error(`[PDF-ONLY-MATCHER] Product #${productIndex + 1} completely failed: ${result.reason?.message}`);

        matches.push({
          productIndex,
          product: failedProduct,
          bestMatch: null,
          secondMatch: null,
          thirdMatch: null,
          overallConfidence: 'error',
          overallReason: result.reason?.message || 'All matching attempts failed',
          confirmed: false,
          _error: result.reason?.message
        });
        needsReview++;
      }
    }

    // Deliberate pause between batches to avoid rate limits and reduce server load
    if (batchEnd < products.length) {
      console.log(`[PDF-ONLY-MATCHER] Batch ${batchNum}/${totalBatches} complete. Pausing ${INTER_BATCH_DELAY_MS}ms before next batch...`);
      await new Promise(resolve => setTimeout(resolve, INTER_BATCH_DELAY_MS));
    }
  }

  const stats = {
    totalProducts: products.length,
    totalImages: pageImages.length,
    autoAccepted,
    needsReview,
    fingerprintsCreated: 0, // Not applicable for PDF-only mode
    usedFallback
  };

  console.log(`[PDF-ONLY-MATCHER] Complete: ${autoAccepted} auto-accepted, ${needsReview} need review${usedFallback ? ' (used Gemini fallback for some products)' : ''}`);

  return { matches, stats };
}

// ── Single product match with fallback chain ──────────────────────

/**
 * Match a single product with full fallback chain:
 *   1. Try OpenAI GPT-4o Vision (with retry)
 *   2. On failure, try Gemini fallback (with retry)
 *   3. On complete failure, throw — caller handles graceful degradation
 *
 * @param {object} product
 * @param {number} productIndex
 * @param {Array<object>} pageImages
 * @returns {Promise<object>}
 */
async function matchSingleProductWithFallback(product, productIndex, pageImages) {
  const candidates = selectCandidateImages(product, productIndex, pageImages, MAX_IMAGES_PER_PRODUCT);

  if (candidates.length === 0) {
    return {
      productIndex,
      product,
      bestMatch: null,
      secondMatch: null,
      thirdMatch: null,
      overallConfidence: 'none',
      overallReason: 'No candidate page images available',
      confirmed: false,
      _usedFallback: false
    };
  }

  // ── Attempt 1: OpenAI (with retry + timeout) ──────────────────
  if (OPENAI_API_KEY) {
    try {
      const result = await withTimeout(
        withRetry(
          () => matchSingleProductToPage(product, productIndex, candidates),
          {
            maxRetries: MAX_RETRIES,
            delays: RETRY_DELAYS,
            label: `OpenAI product #${productIndex + 1}`
          }
        ),
        MATCH_TIMEOUT_MS,
        `OpenAI product #${productIndex + 1}`
      );
      return { ...result, _usedFallback: false };
    } catch (openaiErr) {
      console.warn(`[PDF-ONLY-MATCHER] OpenAI failed for product #${productIndex + 1}: ${openaiErr.message}`);
      // Fall through to Gemini fallback
    }
  }

  // ── Attempt 2: Gemini fallback (with retry + timeout) ─────────
  if (GEMINI_API_KEY) {
    try {
      const result = await withTimeout(
        withRetry(
          () => matchWithGemini(product, productIndex, candidates),
          {
            maxRetries: MAX_RETRIES,
            delays: RETRY_DELAYS,
            label: `Gemini product #${productIndex + 1}`
          }
        ),
        MATCH_TIMEOUT_MS,
        `Gemini product #${productIndex + 1}`
      );
      return { ...result, _usedFallback: true };
    } catch (geminiErr) {
      console.error(`[PDF-ONLY-MATCHER] Gemini fallback also failed for product #${productIndex + 1}: ${geminiErr.message}`);
      // Fall through to final error
    }
  }

  // ── Both providers failed — throw so caller can add error entry ──
  const noKeyMsg = !OPENAI_API_KEY && !GEMINI_API_KEY
    ? 'No AI provider configured (set OPENAI_API_KEY or GEMINI_API_KEY)'
    : 'Both OpenAI and Gemini failed for this product';
  throw new Error(noKeyMsg);
}

// ── OpenAI matcher (single product) ───────────────────────────────

/**
 * Match a single product to the best PDF page image using GPT-4o Vision.
 *
 * @param {object} product - Product from DeepSeek extraction
 * @param {number} productIndex - Index in the products array
 * @param {Array<object>} candidates - Selected candidate page images
 * @returns {Promise<object>} Match result
 */
async function matchSingleProductToPage(product, productIndex, candidates) {
  const productInfo = JSON.stringify({
    name: product.name || '',
    code: product.productCode || product.generatedCode || '',
    brand: product.brand || '',
    category: product.category || '',
    description: product.description || ''
  }, null, 2);

  // Build the prompt for GPT-4o Vision
  const prompt = `You are a furniture product catalog matching expert. Your task is to match a product from a PDF catalog text to the correct product image from the PDF pages.

PRODUCT INFORMATION (extracted from PDF text):
${productInfo}

Below are ${candidates.length} candidate PDF page images labeled "Page-Image-0" through "Page-Image-${candidates.length - 1}".

TASK:
1. Read the product information carefully — note the product name, code, brand, category, and description
2. VISUALLY examine each candidate PDF page image
3. Find which page image BEST corresponds to this product
4. Rank the top 3 best-matching images
5. Provide a confidence level and detailed reasoning

MATCHING CRITERIA (in order of importance):
- The page image should show the actual product described (furniture piece)
- Product type/category must match (e.g., chair → chair image, not chair → table image)
- The product code or name on the page should align with the extracted product code
- Design style should be consistent (modern, classic, luxury, etc.)
- Colors and materials should align with the description

CRITICAL RULES:
- VISUALLY examine each page image — don't guess
- If NO image is a good match, set best_match to null
- Be honest about low-confidence matches
- Page-Image-0 is the first candidate image, Page-Image-1 is the second, etc.

Return ONLY a valid JSON object. No markdown, no code fences, no explanations:
{
  "best_match": {
    "image_index": 0,
    "confidence": 95,
    "reason": "The page image shows a modern armchair with wooden legs matching the product description..."
  },
  "second_match": {
    "image_index": 2,
    "confidence": 65,
    "reason": "Similar style but different color scheme..."
  },
  "third_match": {
    "image_index": null,
    "confidence": 0,
    "reason": "No third match found"
  },
  "overall_reason": "Strong visual match found between product description and page image"
}

If no good match exists:
{
  "best_match": null,
  "second_match": null,
  "third_match": null,
  "overall_reason": "No page image matches this product description"
}`;

  // Build the message content with images
  const messageContent = [
    { type: 'text', text: prompt }
  ];

  // Add candidate images
  for (let i = 0; i < candidates.length; i++) {
    messageContent.push({
      type: 'image_url',
      image_url: {
        url: candidates[i].dataUrl,
        detail: 'low' // Low detail to save tokens
      }
    });
  }

  const requestBody = {
    model: OPENAI_MODEL,
    messages: [
      {
        role: 'user',
        content: messageContent
      }
    ],
    max_tokens: 2048,
    temperature: 0.1,
    response_format: { type: 'json_object' }
  };

  console.log(`[PDF-ONLY-MATCHER] (OpenAI) Matching product #${productIndex + 1} "${product.name || product.productCode}" against ${candidates.length} page images...`);

  const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!res.ok) {
    const errorText = await res.text();
    const status = res.status;
    console.error(`[PDF-ONLY-MATCHER] OpenAI API error: ${status} ${errorText.substring(0, 200)}`);
    const err = new Error(`OpenAI API error ${status}: ${errorText.substring(0, 200)}`);
    err.status = status;
    throw err;
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('OpenAI returned empty response');
  }

  // Parse the JSON response
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (parseErr) {
    console.error(`[PDF-ONLY-MATCHER] Failed to parse OpenAI response: ${content.substring(0, 200)}`);
    throw new Error('Failed to parse OpenAI response as JSON');
  }

  // Build the match result
  const bestMatch = parsed.best_match ? {
    imageIndex: parsed.best_match.image_index,
    imageName: candidates[parsed.best_match.image_index]?.name || `page_${parsed.best_match.image_index + 1}.png`,
    confidence: parsed.best_match.confidence || 0,
    reason: parsed.best_match.reason || '',
    dataUrl: candidates[parsed.best_match.image_index]?.dataUrl || null,
    status: (parsed.best_match.confidence || 0) >= 90 ? 'auto_accepted' : 'needs_review'
  } : null;

  const secondMatch = parsed.second_match?.image_index !== null && parsed.second_match?.image_index !== undefined ? {
    imageIndex: parsed.second_match.image_index,
    imageName: candidates[parsed.second_match.image_index]?.name || `page_${parsed.second_match.image_index + 1}.png`,
    confidence: parsed.second_match.confidence || 0,
    reason: parsed.second_match.reason || '',
    dataUrl: candidates[parsed.second_match.image_index]?.dataUrl || null
  } : null;

  const thirdMatch = parsed.third_match?.image_index !== null && parsed.third_match?.image_index !== undefined ? {
    imageIndex: parsed.third_match.image_index,
    imageName: candidates[parsed.third_match.image_index]?.name || `page_${parsed.third_match.image_index + 1}.png`,
    confidence: parsed.third_match.confidence || 0,
    reason: parsed.third_match.reason || '',
    dataUrl: candidates[parsed.third_match.image_index]?.dataUrl || null
  } : null;

  const confidence = bestMatch?.confidence || 0;
  const overallConfidence = confidence >= 90 ? 'high'
    : confidence >= 70 ? 'medium'
    : confidence >= 50 ? 'low'
    : 'none';

  const confirmed = bestMatch?.status === 'auto_accepted';

  console.log(`[PDF-ONLY-MATCHER] Product #${productIndex + 1}: confidence=${confidence}%, status=${overallConfidence}${confirmed ? ' (auto-accepted)' : ''}`);

  return {
    productIndex,
    product,
    bestMatch,
    secondMatch,
    thirdMatch,
    overallConfidence,
    overallReason: parsed.overall_reason || bestMatch?.reason || '',
    confirmed
  };
}

// ── Candidate image selection ─────────────────────────────────────

/**
 * Select candidate page images for a product.
 *
 * Strategy:
 * - If the product has a page number, prefer images near that page
 * - Otherwise, distribute evenly based on product index
 * - Always include nearby pages for context
 *
 * @param {object} product - Product with optional page field
 * @param {number} productIndex - Index in products array
 * @param {Array<object>} pageImages - All PDF page images
 * @param {number} maxCandidates - Max images to consider
 * @returns {Array<object>} Selected candidate images
 */
function selectCandidateImages(product, productIndex, pageImages, maxCandidates) {
  if (pageImages.length <= maxCandidates) {
    return pageImages;
  }

  // If product has a page number, center around it
  if (product.page) {
    const targetPage = typeof product.page === 'number' ? product.page : parseInt(product.page, 10);
    if (!isNaN(targetPage) && targetPage > 0) {
      const idx = pageImages.findIndex(img => img.pageNumber === targetPage);
      if (idx >= 0) {
        const half = Math.floor(maxCandidates / 2);
        const start = Math.max(0, idx - half);
        const end = Math.min(pageImages.length, start + maxCandidates);
        return pageImages.slice(start, end);
      }
    }
  }

  // Distribute evenly: each product gets a slice of page images
  const productsPerImage = Math.max(1, Math.floor(pageImages.length / maxCandidates));
  const startIdx = Math.min(productIndex * productsPerImage, pageImages.length - maxCandidates);
  return pageImages.slice(startIdx, startIdx + maxCandidates);
}
