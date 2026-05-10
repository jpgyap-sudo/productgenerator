// ═══════════════════════════════════════════════════════════════════
//  lib/vision-matcher.js — GPT-4o Vision direct image-to-image matching
//
//  Architecture (TRUE image-to-image matching):
//    1. Extract product images from PDF pages (each page has a product photo)
//    2. For each product, send the PDF product image + ALL ZIP candidate
//       images to GPT-4o Vision in a single call
//    3. GPT-4o visually compares the PDF product image against each ZIP
//       image and returns the top 3 ranked matches
//    4. This is TRUE image-to-image matching — the model sees both the
//       PDF product photo AND the ZIP images simultaneously
//    5. Gemini fallback for products GPT-4o couldn't match
//
//  Key rules:
//    - Never depend on ZIP order
//    - Never depend on ZIP filenames
//    - Never auto-accept low confidence (< 90%)
// ═══════════════════════════════════════════════════════════════════

import { visualSearchMatch } from './gemini-verify.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o';
const OPENAI_API_BASE = 'https://api.openai.com/v1';

const MAX_IMAGES_PER_MATCH_CALL = 20; // GPT-4o can handle many images per call
const BATCH_SIZE_PRODUCTS = 2;        // Process 2 products concurrently (image-heavy)

/**
 * Match a single product to candidate ZIP images using GPT-4o Vision.
 * Sends the PDF product image (from the catalog page) + ALL candidate
 * ZIP images in ONE call for TRUE visual image-to-image comparison.
 *
 * @param {object} product - Product row from PDF extraction
 * @param {Array<{imageId: string, originalName: string, dataUrl: string}>} candidateImages - ZIP images
 * @param {string|null} pdfImageDataUrl - The PDF page image showing this product (from catalog)
 * @returns {Promise<object>} Ranked match results
 */
export async function matchProductDirect(product, candidateImages, pdfImageDataUrl = null) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  if (!candidateImages || candidateImages.length === 0) {
    return {
      best_match: null,
      second_match: null,
      third_match: null,
      confidence: 'none',
      reason: 'No candidate images available for matching'
    };
  }

  // Limit candidates to prevent token overflow
  const candidates = candidateImages.slice(0, MAX_IMAGES_PER_MATCH_CALL);

  const productInfo = JSON.stringify({
    name: product.name || '',
    code: product.productCode || product.generatedCode || '',
    category: product.category || '',
    material: product.material || '',
    color: product.color || '',
    dimensions: product.dimensions || '',
    description: product.description || '',
    page: product.page || ''
  }, null, 2);

  const hasPdfImage = !!pdfImageDataUrl;

  const prompt = `You are a furniture product matching expert. Your task is to match a product from a PDF catalog to the best images from a ZIP file by VISUALLY comparing the actual product image from the PDF against the candidate images.

${hasPdfImage ? 'I have provided the ACTUAL PRODUCT IMAGE from the PDF catalog as the first image (labeled "PDF-PRODUCT-IMAGE").' : 'I have provided the product description from the PDF catalog below.'}

PRODUCT INFORMATION FROM PDF CATALOG:
${productInfo}

Below are ${candidates.length} candidate ZIP images labeled ZIP-Image-0 through ZIP-Image-${candidates.length - 1}.

TASK:
1. ${hasPdfImage ? 'VISUALLY examine the PDF product image to understand what the product looks like' : 'Read the product description carefully — note the product type, style, material, color, and dimensions'}
2. VISUALLY examine each candidate ZIP image
3. Find which ZIP image BEST matches the ${hasPdfImage ? 'PDF product image' : 'product description'}
4. Rank the top 3 best-matching images
5. Provide a confidence level and detailed reasoning

MATCHING CRITERIA (in order of importance):
- Product type/category must match (e.g., chair → chair, not chair → table) — this is the MOST important
- Design style should be consistent (modern, classic, etc.)
- Materials should align (leather, fabric, wood, metal, etc.)
- Colors should be compatible
- Key distinguishing features should match (armrests, leg style, backrest shape, etc.)
${hasPdfImage ? '\n- The PDF product image is the GROUND TRUTH — find the ZIP image that looks most like it' : ''}

CRITICAL RULES:
- Never match based on image filename or ZIP order
- VISUALLY compare each ZIP image ${hasPdfImage ? 'to the PDF product image' : 'to the product description'} — don't guess
- If NO image is a good match, set best_match to null
- Be honest about low-confidence matches
- ZIP-Image-0 is the first ZIP image, ZIP-Image-1 is the second, etc.

Return ONLY valid JSON, no markdown, no code fences:
{
  "best_match": {
    "image_index": 0,
    "image_id": "zip_0001.jpg",
    "rank": 1,
    "confidence": 92,
    "reason": "Visually matches the PDF product image — same dining chair, modern luxury style, brown leather"
  },
  "second_match": {
    "image_index": 1,
    "image_id": "zip_0017.jpg",
    "rank": 2,
    "confidence": 75,
    "reason": "Same product type but different color/material"
  },
  "third_match": {
    "image_index": 2,
    "image_id": "zip_0031.jpg",
    "rank": 3,
    "confidence": 60,
    "reason": "Similar style but different product sub-type"
  },
  "confidence": "high",
  "reason": "Strong visual match found — ZIP image matches the PDF product image"
}

Confidence levels:
- "high": best_match confidence >= 90% — safe to auto-accept
- "medium": best_match confidence 70-89% — recommend user review
- "low": best_match confidence < 70% — user must confirm
- "none": No acceptable match found`;

  // Build the message content: text prompt + PDF product image (if available) + ZIP candidate images
  const content = [
    { type: 'text', text: prompt }
  ];

  // If we have a PDF product image, send it first as the reference image
  if (hasPdfImage) {
    content.push({
      type: 'image_url',
      image_url: {
        url: pdfImageDataUrl,
        detail: 'high'
      }
    });
  }

  // Then send all ZIP candidate images
  for (let i = 0; i < candidates.length; i++) {
    content.push({
      type: 'image_url',
      image_url: {
        url: candidates[i].dataUrl,
        detail: 'high'
      }
    });
  }

  const requestBody = {
    model: OPENAI_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You are a precise furniture product matching assistant. You visually compare product images from a PDF catalog against candidate images from a ZIP file to find the best match. You never rely on filenames or ZIP order.'
      },
      {
        role: 'user',
        content
      }
    ],
    max_tokens: 1024,
    temperature: 0.1,
    response_format: { type: 'json_object' }
  };

  console.log(`[VISION-MATCHER] Direct image-to-image matching "${product.name || product.productCode || 'unknown'}" against ${candidates.length} ZIP images using ${OPENAI_MODEL}${hasPdfImage ? ' (with PDF reference image)' : ' (text-only fallback)'}...`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000); // 90s for multi-image with PDF reference

  try {
    const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAI API error ${res.status}: ${errText.substring(0, 200)}`);
    }

    const data = await res.json();
    const content_text = data.choices?.[0]?.message?.content;

    if (!content_text) {
      throw new Error('Empty response from OpenAI');
    }

    const result = JSON.parse(content_text);

    // Map image_index back to image_id
    // Note: if we sent a PDF image first, the ZIP images start at index 1
    const zipOffset = hasPdfImage ? 1 : 0;

    if (result.best_match && result.best_match.image_index !== undefined) {
      const zipIdx = result.best_match.image_index - zipOffset;
      if (zipIdx >= 0 && zipIdx < candidates.length) {
        result.best_match.image_id = candidates[zipIdx]?.imageId || `candidate_${zipIdx}`;
      } else {
        result.best_match = null; // Invalid index (pointed to PDF image itself)
      }
    }
    if (result.second_match && result.second_match.image_index !== undefined) {
      const zipIdx = result.second_match.image_index - zipOffset;
      if (zipIdx >= 0 && zipIdx < candidates.length) {
        result.second_match.image_id = candidates[zipIdx]?.imageId || `candidate_${zipIdx}`;
      } else {
        result.second_match = null;
      }
    }
    if (result.third_match && result.third_match.image_index !== undefined) {
      const zipIdx = result.third_match.image_index - zipOffset;
      if (zipIdx >= 0 && zipIdx < candidates.length) {
        result.third_match.image_id = candidates[zipIdx]?.imageId || `candidate_${zipIdx}`;
      } else {
        result.third_match = null;
      }
    }

    console.log(`[VISION-MATCHER] Direct match result: best=${result.best_match?.image_id || 'none'}, confidence=${result.confidence}`);
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('GPT-4o Vision request timed out after 90 seconds');
    }
    throw err;
  }
}

/**
 * Full matching pipeline: for each product, send the PDF page image
 * (showing the product from the catalog) + all ZIP candidate images
 * to GPT-4o for TRUE visual image-to-image comparison.
 *
 * @param {Array<object>} products - Product rows from PDF extraction
 * @param {Array<{name: string, dataUrl: string}>} images - ZIP images with data URLs
 * @param {Array<{page: number, dataUrl: string}>} [pdfImages] - PDF page images (product photos from catalog)
 * @returns {Promise<{matches: Array, stats: object}>}
 */
export async function matchProductsWithVision(products, images, pdfImages = []) {
  console.log(`[VISION-MATCHER] Starting DIRECT image-to-image matching: ${products.length} products, ${images.length} ZIP images, ${pdfImages.length} PDF page images using ${OPENAI_MODEL}`);

  // Build ZIP image metadata array
  const zipImages = [];
  for (let i = 0; i < images.length; i++) {
    const imageId = `zip_${String(i + 1).padStart(4, '0')}.${images[i].name.split('.').pop() || 'jpg'}`;
    zipImages.push({
      imageId,
      originalName: images[i].name,
      dataUrl: images[i].dataUrl,
      width: images[i].width,
      height: images[i].height
    });
  }

  // Build PDF image lookup by page number (1-indexed)
  const pdfImageByPage = {};
  for (const pImg of pdfImages) {
    pdfImageByPage[pImg.page] = pImg.dataUrl;
  }

  // Step 1: Match each product using GPT-4o Vision with PDF image reference
  const matches = [];

  // Process products in batches for concurrency
  for (let batchStart = 0; batchStart < products.length; batchStart += BATCH_SIZE_PRODUCTS) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE_PRODUCTS, products.length);
    const batchProducts = products.slice(batchStart, batchEnd);

    console.log(`[VISION-MATCHER] Processing product batch ${Math.floor(batchStart / BATCH_SIZE_PRODUCTS) + 1}/${Math.ceil(products.length / BATCH_SIZE_PRODUCTS)} (products ${batchStart + 1}-${batchEnd})`);

    const batchResults = await Promise.allSettled(
      batchProducts.map(async (product, batchIdx) => {
        const productIndex = batchStart + batchIdx;
        console.log(`[VISION-MATCHER] Matching product ${productIndex + 1}/${products.length}: "${product.name || product.productCode || 'unknown'}"`);

        try {
          // Find the PDF page image for this product
          // Products are typically listed in order matching PDF pages
          let pdfImageDataUrl = null;

          // Try to match by page number if available
          if (product.page && pdfImageByPage[product.page]) {
            pdfImageDataUrl = pdfImageByPage[product.page];
            console.log(`[VISION-MATCHER] Using PDF page ${product.page} image for "${product.name}"`);
          } else if (pdfImages.length > 0) {
            // Fallback: assume products are in order, match by index
            const pdfPageIndex = productIndex; // 0-indexed
            if (pdfPageIndex < pdfImages.length) {
              pdfImageDataUrl = pdfImages[pdfPageIndex].dataUrl;
              console.log(`[VISION-MATCHER] Using PDF page ${pdfImages[pdfPageIndex].page} image (by index ${pdfPageIndex}) for "${product.name}"`);
            }
          }

          const ranking = await matchProductDirect(product, zipImages, pdfImageDataUrl);

          // Resolve image details for each ranked candidate
          const resolveImage = (match) => {
            if (!match || !match.image_id) return null;
            const fpIndex = zipImages.findIndex(f => f.imageId === match.image_id);
            if (fpIndex === -1) return null;
            const img = zipImages[fpIndex];
            return {
              imageIndex: fpIndex,
              imageId: match.image_id,
              originalName: img.originalName,
              dataUrl: img.dataUrl,
              width: img.width,
              height: img.height,
              confidence: match.confidence,
              reason: match.reason,
              rank: match.rank
            };
          };

          return {
            productIndex,
            product,
            bestMatch: resolveImage(ranking.best_match),
            secondMatch: resolveImage(ranking.second_match),
            thirdMatch: resolveImage(ranking.third_match),
            overallConfidence: ranking.confidence,
            overallReason: ranking.reason,
            usedPdfImage: !!pdfImageDataUrl,
            // Auto-accept only if confidence is "high" (>= 90%)
            autoAccept: ranking.confidence === 'high' && ranking.best_match !== null
          };
        } catch (err) {
          console.error(`[VISION-MATCHER] Direct matching failed for product ${productIndex}: ${err.message}`);
          return {
            productIndex,
            product,
            bestMatch: null,
            secondMatch: null,
            thirdMatch: null,
            overallConfidence: 'error',
            overallReason: `Matching failed: ${err.message}`,
            autoAccept: false
          };
        }
      })
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        matches.push(result.value);
      }
    }
  }

  const autoAccepted = matches.filter(m => m.autoAccept).length;
  const needsReview = matches.filter(m => !m.autoAccept).length;
  const withPdfImage = matches.filter(m => m.usedPdfImage).length;
  console.log(`[VISION-MATCHER] GPT-4o direct matching complete: ${matches.length} products, ${autoAccepted} auto-accepted, ${needsReview} need review (${withPdfImage} used PDF reference images)`);

  // ═══════════════════════════════════════════════════════════════════
  // Step 2: Gemini fallback for unmatched / low-confidence products
  // ═══════════════════════════════════════════════════════════════════
  const unmatchedProducts = matches.filter(m =>
    m.overallConfidence === 'low' || m.overallConfidence === 'none' || m.overallConfidence === 'error'
  );

  if (unmatchedProducts.length > 0) {
    console.log(`[VISION-MATCHER] Step 2: Running Gemini fallback for ${unmatchedProducts.length} unmatched products...`);

    // Collect images that are NOT already used as bestMatch for high/medium confidence matches
    const usedImageIds = new Set();
    for (const m of matches) {
      if (m.bestMatch && (m.overallConfidence === 'high' || m.overallConfidence === 'medium')) {
        usedImageIds.add(m.bestMatch.imageId);
      }
    }

    const availableImages = zipImages
      .filter(img => !usedImageIds.has(img.imageId))
      .map(img => ({
        imageId: img.imageId,
        originalName: img.originalName,
        dataUrl: img.dataUrl,
        width: img.width,
        height: img.height
      }));

    console.log(`[VISION-MATCHER] ${availableImages.length} images available for Gemini fallback matching`);

    for (const match of unmatchedProducts) {
      const product = match.product;
      console.log(`[VISION-MATCHER] Gemini fallback for product ${match.productIndex + 1}/${products.length}: "${product.name || product.productCode || 'unknown'}"`);

      try {
        // Prepare candidate images for Gemini (limit to 10 as per visualSearchMatch)
        const geminiCandidates = availableImages.slice(0, 10).map(img => ({
          name: img.originalName,
          dataUrl: img.dataUrl,
          imageId: img.imageId
        }));

        const geminiResult = await visualSearchMatch(product, geminiCandidates);

        if (geminiResult && geminiResult.matchedImage) {
          const geminiImageId = geminiResult.matchedImage.imageId ||
            (geminiCandidates[0] ? geminiCandidates[0].imageId : null);

          // Find the full image info
          const imgInfo = zipImages.find(f => f.imageId === geminiImageId);
          const geminiConfidence = geminiResult.verification?.confidence || 'medium';

          // Map Gemini confidence to our confidence levels
          let overallConfidence = 'medium';
          if (geminiConfidence === 'high') overallConfidence = 'medium'; // Gemini high → our medium (still needs review)
          else if (geminiConfidence === 'low') overallConfidence = 'low';

          // Build a match entry from Gemini result
          const geminiMatch = imgInfo ? {
            imageIndex: zipImages.indexOf(imgInfo),
            imageId: geminiImageId,
            originalName: imgInfo.originalName,
            dataUrl: imgInfo.dataUrl,
            width: imgInfo.width,
            height: imgInfo.height,
            confidence: geminiResult.score || 70,
            reason: geminiResult.verification?.reason || 'Gemini visual search fallback match',
            rank: 1,
            matchSource: 'gemini-fallback'
          } : null;

          if (geminiMatch) {
            match.bestMatch = geminiMatch;
            match.overallConfidence = overallConfidence;
            match.overallReason = `Gemini fallback: ${geminiResult.verification?.reason || 'Visual search match'}`;
            match.autoAccept = false; // Never auto-accept Gemini fallback matches
            match.geminiFallback = true;

            console.log(`[VISION-MATCHER] Gemini found match for "${product.name || product.productCode}": ${geminiImageId} (confidence: ${overallConfidence})`);
          } else {
            console.log(`[VISION-MATCHER] Gemini could not resolve image info for match`);
          }
        } else {
          console.log(`[VISION-MATCHER] Gemini found no match for "${product.name || product.productCode}"`);
        }
      } catch (err) {
        console.error(`[VISION-MATCHER] Gemini fallback error for product ${match.productIndex}: ${err.message}`);
      }
    }

    console.log(`[VISION-MATCHER] Gemini fallback complete`);
  }

  // Final stats
  const finalAutoAccepted = matches.filter(m => m.autoAccept).length;
  const finalGeminiMatched = matches.filter(m => m.geminiFallback).length;
  const finalNeedsReview = matches.filter(m => !m.autoAccept && !m.geminiFallback).length;
  console.log(`[VISION-MATCHER] Complete: ${matches.length} products | ${finalAutoAccepted} auto-accepted | ${finalGeminiMatched} gemini-fallback | ${finalNeedsReview} need review`);

  return {
    matches,
    fingerprints: [],
    stats: {
      totalProducts: products.length,
      totalImages: images.length,
      fingerprintsCreated: 0,
      autoAccepted: finalAutoAccepted,
      geminiFallback: finalGeminiMatched,
      needsReview: finalNeedsReview,
      totalMatched: finalAutoAccepted + finalGeminiMatched
    }
  };
}
