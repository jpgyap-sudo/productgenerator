// ═══════════════════════════════════════════════════════════════════
//  lib/vision-matcher.js — OpenAI Vision-based product-image matching
//                        with Gemini fallback for unmatched products
//
//  Architecture:
//    1. Extract visual fingerprints from ZIP images using OpenAI Vision
//    2. For each PDF product row, ask OpenAI to rank top 3 image candidates
//    3. For products with low/none confidence, run Gemini visual search
//       as a fallback to find a better match
//    4. Return ranked candidates with confidence scores and reasons
//
//  Key rules:
//    - Never depend on ZIP order
//    - Never depend on ZIP filenames
//    - Never auto-accept low confidence (< 90%)
// ═══════════════════════════════════════════════════════════════════

import { visualSearchMatch } from './gemini-verify.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
const OPENAI_API_BASE = 'https://api.openai.com/v1';

const MAX_IMAGES_PER_FINGERPRINT_BATCH = 5;
const MAX_CANDIDATES_FOR_RANKING = 20;

/**
 * Create a visual fingerprint for an image using OpenAI Vision.
 *
 * @param {string} imageDataUrl - Base64 data URL of the image
 * @param {string} imageId - Identifier for the image (e.g., "zip_0042.jpg")
 * @returns {Promise<object>} Visual fingerprint
 */
export async function createVisualFingerprint(imageDataUrl, imageId) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  const prompt = `You are a furniture product analyst. Analyze this product image and extract its visual attributes in JSON format.

Extract these attributes:
- type: What type of furniture is this? (e.g., "dining chair", "armchair", "sofa", "bar stool", "side table", "coffee table", "bed", "cabinet", "desk", "lamp", "shelf", "ottoman", "bench", "dining table", "console table", "nightstand", "dresser", "bookcase")
- color: Dominant color(s) of the main body (e.g., "brown", "black", "white", "gray", "beige", "blue", "green", "multi-color")
- material: Primary material(s) visible (e.g., "leather", "fabric", "wood", "metal", "marble", "glass", "velvet", "rattan", "plastic", "chrome")
- legs: Description of legs/base (e.g., "black tapered legs", "gold metal legs", "wooden straight legs", "no visible legs", "sledge base", "four wooden legs", "chrome swivel base")
- arms: Description of armrests (e.g., "curved arms", "straight arms", "no arms", "padded arms", "wooden arms", "wrapped arms", "tubular arms")
- backrest: Description of backrest (e.g., "rounded back", "high back", "low back", "slatted back", "winged back", "no backrest", "tufted back", "mesh back", "solid panel back")
- style: Overall style category (e.g., "modern luxury", "mid-century modern", "contemporary", "classic", "industrial", "scandinavian", "traditional", "minimalist", "art deco", "rustic", "bohemian")
- seat: Description of seat (e.g., "upholstered seat", "wooden seat", "cushioned seat", "woven seat", "leather seat", "bench seat")
- shape: Overall silhouette (e.g., "rectangular", "round", "square", "oval", "organic", "L-shaped", "curved", "angular")
- distinguishing_features: Array of 2-4 key distinguishing features that make this product unique

Return ONLY valid JSON, no markdown, no code fences:
{
  "image_id": "${imageId}",
  "type": "dining chair",
  "color": "brown",
  "material": "leather/fabric",
  "legs": "black tapered legs",
  "arms": "curved arms",
  "backrest": "rounded back",
  "style": "modern luxury",
  "seat": "upholstered seat",
  "shape": "rectangular",
  "distinguishing_features": ["curved armrests", "button tufting", "gold nailhead trim"]
}`;

  const requestBody = {
    model: OPENAI_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: imageDataUrl,
              detail: 'high'
            }
          }
        ]
      }
    ],
    max_tokens: 512,
    temperature: 0.1,
    response_format: { type: 'json_object' }
  };

  console.log(`[VISION-MATCHER] Creating fingerprint for ${imageId}...`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

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
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    const fingerprint = JSON.parse(content);
    console.log(`[VISION-MATCHER] Fingerprint for ${imageId}: ${fingerprint.type}, ${fingerprint.style}, ${fingerprint.color}`);
    return fingerprint;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('OpenAI Vision request timed out after 30 seconds');
    }
    throw err;
  }
}

/**
 * Create visual fingerprints for multiple images in batches.
 *
 * @param {Array<{imageId: string, dataUrl: string}>} images
 * @returns {Promise<Array<{imageId: string, fingerprint: object}>>}
 */
export async function createFingerprintsBatch(images) {
  console.log(`[VISION-MATCHER] Creating fingerprints for ${images.length} images in batches of ${MAX_IMAGES_PER_FINGERPRINT_BATCH}`);

  const results = [];

  for (let i = 0; i < images.length; i += MAX_IMAGES_PER_FINGERPRINT_BATCH) {
    const batch = images.slice(i, i + MAX_IMAGES_PER_FINGERPRINT_BATCH);
    const batchResults = await Promise.allSettled(
      batch.map(img => createVisualFingerprint(img.dataUrl, img.imageId).catch(err => {
        console.error(`[VISION-MATCHER] Failed fingerprint for ${img.imageId}: ${err.message}`);
        return null;
      }))
    );

    for (let j = 0; j < batch.length; j++) {
      const fp = batchResults[j].status === 'fulfilled' ? batchResults[j].value : null;
      if (fp) {
        results.push({ imageId: batch[j].imageId, fingerprint: fp });
      }
    }

    console.log(`[VISION-MATCHER] Batch ${Math.floor(i / MAX_IMAGES_PER_FINGERPRINT_BATCH) + 1}/${Math.ceil(images.length / MAX_IMAGES_PER_FINGERPRINT_BATCH)} complete: ${results.length}/${images.length} fingerprints`);
  }

  return results;
}

/**
 * Rank top 3 image candidates for a product row using OpenAI.
 * Compares the product attributes against visual fingerprints.
 *
 * @param {object} product - Product row from PDF extraction
 * @param {Array<{imageId: string, fingerprint: object}>} fingerprints - Visual fingerprints
 * @returns {Promise<{best_match: object, second_match: object, third_match: object, confidence: string, reason: string}>}
 */
export async function rankCandidatesForProduct(product, fingerprints) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  if (!fingerprints || fingerprints.length === 0) {
    return {
      best_match: null,
      second_match: null,
      third_match: null,
      confidence: 'none',
      reason: 'No image fingerprints available for matching'
    };
  }

  // Limit candidates to prevent token overflow
  const candidates = fingerprints.slice(0, MAX_CANDIDATES_FOR_RANKING);

  const productInfo = JSON.stringify({
    code: product.productCode || product.generatedCode || '',
    category: product.category || '',
    material: product.material || '',
    color: product.color || '',
    dimensions: product.dimensions || '',
    description: product.description || '',
    page: product.page || ''
  }, null, 2);

  const fingerprintsInfo = candidates.map((c, i) =>
    `Candidate ${i + 1} (image_id: ${c.imageId}):\n${JSON.stringify(c.fingerprint, null, 2)}`
  ).join('\n\n');

  const prompt = `You are a product matching expert. Your task is to match a product from a PDF catalog to the best images from a ZIP file.

PRODUCT FROM PDF CATALOG:
${productInfo}

AVAILABLE IMAGE FINGERPRINTS (from visual analysis of each image):
${fingerprintsInfo}

TASK:
1. Analyze the product description and attributes from the PDF
2. Compare against each image's visual fingerprint
3. Rank the top 3 best-matching images
4. Provide a confidence level and detailed reasoning

MATCHING CRITERIA (in order of importance):
- Product type/category must match (e.g., chair → chair, not chair → table)
- Design style should be consistent
- Materials should align
- Colors should be compatible
- Key distinguishing features should match

CRITICAL RULES:
- Never match based on image filename or ZIP order
- Only use the visual attributes from the fingerprints
- If NO image is a good match, set best_match to null
- Be honest about low-confidence matches

Return ONLY valid JSON, no markdown, no code fences:
{
  "best_match": {
    "image_id": "zip_0042.jpg",
    "rank": 1,
    "confidence": 92,
    "reason": "Matches product type (dining chair), style (modern luxury), and color (brown leather)"
  },
  "second_match": {
    "image_id": "zip_0017.jpg",
    "rank": 2,
    "confidence": 75,
    "reason": "Same product type but different color/material"
  },
  "third_match": {
    "image_id": "zip_0031.jpg",
    "rank": 3,
    "confidence": 60,
    "reason": "Similar style but different product sub-type"
  },
  "confidence": "high",
  "reason": "Strong match found for product type, style, and materials"
}

Confidence levels:
- "high": best_match confidence >= 90% — safe to auto-accept
- "medium": best_match confidence 70-89% — recommend user review
- "low": best_match confidence < 70% — user must confirm
- "none": No acceptable match found`;

  const requestBody = {
    model: OPENAI_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You are a precise product matching assistant. You analyze product attributes and image fingerprints to find the best visual matches. You never rely on filenames or ZIP order.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    max_tokens: 1024,
    temperature: 0.1,
    response_format: { type: 'json_object' }
  };

  console.log(`[VISION-MATCHER] Ranking candidates for "${product.name || product.productCode || 'unknown'}" (${candidates.length} candidates)...`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

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
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    const result = JSON.parse(content);
    console.log(`[VISION-MATCHER] Ranking result: best=${result.best_match?.image_id || 'none'}, confidence=${result.confidence}`);
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('OpenAI ranking request timed out after 30 seconds');
    }
    throw err;
  }
}

/**
 * Full matching pipeline: create fingerprints for all images, then rank
 * candidates for each product.
 *
 * @param {Array<object>} products - Product rows from PDF extraction
 * @param {Array<{name: string, dataUrl: string}>} images - ZIP images with data URLs
 * @returns {Promise<{matches: Array, fingerprints: Array}>}
 */
export async function matchProductsWithVision(products, images) {
  console.log(`[VISION-MATCHER] Starting vision-based matching: ${products.length} products, ${images.length} images`);

  // Step 1: Create visual fingerprints for all images
  const imageFingerprints = [];
  for (let i = 0; i < images.length; i++) {
    const imageId = `zip_${String(i + 1).padStart(4, '0')}.${images[i].name.split('.').pop() || 'jpg'}`;
    imageFingerprints.push({
      imageId,
      originalName: images[i].name,
      dataUrl: images[i].dataUrl,
      width: images[i].width,
      height: images[i].height
    });
  }

  console.log(`[VISION-MATCHER] Step 1: Creating ${imageFingerprints.length} visual fingerprints...`);
  const fingerprints = await createFingerprintsBatch(imageFingerprints);
  console.log(`[VISION-MATCHER] Created ${fingerprints.length} fingerprints successfully`);

  // Build a lookup map
  const fingerprintMap = {};
  for (const fp of fingerprints) {
    fingerprintMap[fp.imageId] = fp.fingerprint;
  }

  // Step 2: Rank candidates for each product
  const matches = [];
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    console.log(`[VISION-MATCHER] Step 2: Ranking for product ${i + 1}/${products.length}: "${product.name || product.productCode || 'unknown'}"`);

    try {
      const ranking = await rankCandidatesForProduct(product, fingerprints);

      // Resolve image details for each ranked candidate
      const resolveImage = (match) => {
        if (!match || !match.image_id) return null;
        const fpIndex = imageFingerprints.findIndex(f => f.imageId === match.image_id);
        if (fpIndex === -1) return null;
        const img = imageFingerprints[fpIndex];
        return {
          imageIndex: fpIndex,
          imageId: match.image_id,
          originalName: img.originalName,
          dataUrl: img.dataUrl,
          width: img.width,
          height: img.height,
          fingerprint: fingerprintMap[match.image_id] || null,
          confidence: match.confidence,
          reason: match.reason,
          rank: match.rank
        };
      };

      matches.push({
        productIndex: i,
        product,
        bestMatch: resolveImage(ranking.best_match),
        secondMatch: resolveImage(ranking.second_match),
        thirdMatch: resolveImage(ranking.third_match),
        overallConfidence: ranking.confidence,
        overallReason: ranking.reason,
        // Auto-accept only if confidence is "high" (>= 90%)
        autoAccept: ranking.confidence === 'high' && ranking.best_match !== null
      });
    } catch (err) {
      console.error(`[VISION-MATCHER] Ranking failed for product ${i}: ${err.message}`);
      matches.push({
        productIndex: i,
        product,
        bestMatch: null,
        secondMatch: null,
        thirdMatch: null,
        overallConfidence: 'error',
        overallReason: `Ranking failed: ${err.message}`,
        autoAccept: false
      });
    }
  }

  const autoAccepted = matches.filter(m => m.autoAccept).length;
  const needsReview = matches.filter(m => !m.autoAccept).length;
  console.log(`[VISION-MATCHER] OpenAI ranking complete: ${matches.length} products, ${autoAccepted} auto-accepted, ${needsReview} need review`);

  // ═══════════════════════════════════════════════════════════════════
  // Step 3: Gemini fallback for unmatched / low-confidence products
  // ═══════════════════════════════════════════════════════════════════
  const unmatchedProducts = matches.filter(m =>
    m.overallConfidence === 'low' || m.overallConfidence === 'none' || m.overallConfidence === 'error'
  );

  if (unmatchedProducts.length > 0) {
    console.log(`[VISION-MATCHER] Step 3: Running Gemini fallback for ${unmatchedProducts.length} unmatched products...`);

    // Collect images that are NOT already used as bestMatch for high/medium confidence matches
    const usedImageIds = new Set();
    for (const m of matches) {
      if (m.bestMatch && (m.overallConfidence === 'high' || m.overallConfidence === 'medium')) {
        usedImageIds.add(m.bestMatch.imageId);
      }
    }

    const availableImages = imageFingerprints
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
          const imgInfo = imageFingerprints.find(f => f.imageId === geminiImageId);
          const geminiConfidence = geminiResult.verification?.confidence || 'medium';

          // Map Gemini confidence to our confidence levels
          let overallConfidence = 'medium';
          if (geminiConfidence === 'high') overallConfidence = 'medium'; // Gemini high → our medium (still needs review)
          else if (geminiConfidence === 'low') overallConfidence = 'low';

          // Build a match entry from Gemini result
          const geminiMatch = imgInfo ? {
            imageIndex: imageFingerprints.indexOf(imgInfo),
            imageId: geminiImageId,
            originalName: imgInfo.originalName,
            dataUrl: imgInfo.dataUrl,
            width: imgInfo.width,
            height: imgInfo.height,
            fingerprint: fingerprintMap[geminiImageId] || null,
            confidence: geminiResult.score || 70,
            reason: geminiResult.verification?.reason || 'Gemini visual search fallback match',
            rank: 1,
            matchSource: 'gemini-fallback'
          } : null;

          if (geminiMatch) {
            // Update the match entry with Gemini's finding
            // Keep the original OpenAI ranking as second/third if they existed
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
        // Keep the original low-confidence match, don't overwrite
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
    fingerprints,
    stats: {
      totalProducts: products.length,
      totalImages: images.length,
      fingerprintsCreated: fingerprints.length,
      autoAccepted: finalAutoAccepted,
      geminiFallback: finalGeminiMatched,
      needsReview: finalNeedsReview,
      totalMatched: finalAutoAccepted + finalGeminiMatched
    }
  };
}
