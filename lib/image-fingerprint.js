// ═══════════════════════════════════════════════════════════════════
//  lib/image-fingerprint.js — ZIP Image Fingerprinting via OpenAI Vision
//
//  Extracts visual attributes from each ZIP image ONCE and stores
//  them as structured fingerprints. These fingerprints are used for
//  fast candidate filtering (Step 3) WITHOUT repeatedly calling AI.
//
//  Architecture:
//    1. For each ZIP image, send to OpenAI Vision with a structured prompt
//    2. Extract: type, color, material, style, arms, legs, backrest, dimensions
//    3. Save fingerprint to database (zip_image_fingerprints table)
//    4. Return fingerprints for candidate filtering
//
//  Key rules:
//    - Each image is fingerprinted ONLY ONCE per batch
//    - Fingerprints are stored permanently to avoid future AI costs
//    - Uses gpt-4.1-mini (cheap, fast) for fingerprinting
//    - Strict JSON output only
// ═══════════════════════════════════════════════════════════════════

import { supabase, ZIP_IMAGE_FINGERPRINTS_TABLE } from './supabase.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FINGERPRINT_MODEL = process.env.OPENAI_FINGERPRINT_MODEL || 'gpt-4.1-mini';
const OPENAI_API_BASE = 'https://api.openai.com/v1';

/**
 * Extract a visual fingerprint from a single ZIP image using OpenAI Vision.
 * Describes the product shown in the image: type, color, material, style, etc.
 *
 * @param {string} imageDataUrl - Base64 data URL of the image
 * @param {string} imageName - Original filename for logging
 * @returns {Promise<object>} Structured fingerprint
 */
export async function fingerprintImage(imageDataUrl, imageName) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  const prompt = `You are a product attribute extractor. Analyze this furniture/product image and return a STRICT JSON object with these fields:

{
  "type": "chair|sofa|table|bed|cabinet|desk|lamp|shelf|ottoman|stool|bench|mirror|rug|other",
  "dominant_color": "main color name (e.g. brown, black, white, gray, beige, blue)",
  "secondary_color": "secondary color if any, or empty string",
  "material": "main material (e.g. fabric, leather, wood, metal, plastic, glass, rattan)",
  "style": "modern|traditional|industrial|scandinavian|mid-century|contemporary|rustic|minimalist|luxury|other",
  "has_arms": true|false,
  "leg_type": "tapered|straight|splayed|metal|wooden|no_legs|other",
  "leg_color": "color of legs or empty string",
  "backrest_type": "high|low|rounded|slatted|solid|none|other",
  "seat_type": "upholstered|cushioned|solid|slatted|none|other",
  "shape": "rectangular|round|square|oval|l_shaped|curved|other",
  "has_cushions": true|false,
  "cushion_count": 0,
  "is_upholstered": true|false,
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"]
}

Rules:
- Return ONLY valid JSON, no markdown, no code fences
- If unsure about a field, use your best guess based on visual cues
- keywords should be 3-5 descriptive terms (e.g. "curved", "tufted", "sleek", "ornate")
- For "type", choose the most specific category that applies`;

  const requestBody = {
    model: FINGERPRINT_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: imageDataUrl,
              detail: 'low' // Low detail is sufficient for attribute extraction
            }
          }
        ]
      }
    ],
    max_tokens: 500,
    temperature: 0.1, // Low temperature for consistent, deterministic output
    response_format: { type: 'json_object' }
  };

  try {
    const res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000) // 30 second timeout
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAI API error (${res.status}): ${errText || res.statusText}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    // Parse the JSON response
    let fingerprint;
    try {
      fingerprint = JSON.parse(content);
    } catch (parseErr) {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        fingerprint = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error(`Failed to parse fingerprint JSON: ${parseErr.message}`);
      }
    }

    // Validate required fields
    const requiredFields = ['type', 'dominant_color', 'material', 'style', 'has_arms'];
    for (const field of requiredFields) {
      if (fingerprint[field] === undefined || fingerprint[field] === null) {
        fingerprint[field] = field === 'has_arms' ? false : 'unknown';
      }
    }

    // Ensure keywords is an array
    if (!Array.isArray(fingerprint.keywords)) {
      fingerprint.keywords = [];
    }

    return {
      success: true,
      fingerprint,
      raw: content
    };
  } catch (err) {
    console.error(`[FINGERPRINT] Failed to fingerprint image "${imageName}": ${err.message}`);
    return {
      success: false,
      fingerprint: null,
      error: err.message
    };
  }
}

/**
 * Fingerprint all images in a batch and save to database.
 * Processes images sequentially with a delay between each to avoid rate limits.
 *
 * @param {Array<{name: string, dataUrl: string}>} images - ZIP images
 * @param {string} batchId - Batch identifier for DB storage
 * @param {object} [options]
 * @param {number} [options.delayMs=3000] - Delay between fingerprinting calls
 * @param {function} [options.onProgress] - Progress callback (current, total)
 * @returns {Promise<Array<object>>} Array of fingerprint results
 */
export async function fingerprintAllImages(images, batchId, options = {}) {
  const delayMs = options.delayMs || 3000;
  const onProgress = options.onProgress || null;

  if (!images || images.length === 0) {
    return [];
  }

  console.log(`[FINGERPRINT] Starting fingerprinting for ${images.length} images (batch: ${batchId})`);

  const results = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    console.log(`[FINGERPRINT] Fingerprinting image ${i + 1}/${images.length}: "${img.name}"`);

    const result = await fingerprintImage(img.dataUrl, img.name);

    // Save to database regardless of success/failure
    try {
      await saveFingerprintToDb({
        batch_id: batchId,
        image_name: img.name,
        image_path: img.name,
        visual_json: result.fingerprint ? JSON.stringify(result.fingerprint) : null,
        status: result.success ? 'completed' : 'failed',
        error_message: result.error || null
      });
    } catch (dbErr) {
      console.error(`[FINGERPRINT] DB save error for "${img.name}": ${dbErr.message}`);
    }

    results.push({
      imageName: img.name,
      ...result
    });

    if (onProgress) {
      onProgress(i + 1, images.length);
    }

    // Delay between calls to avoid rate limits
    if (i < images.length - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  const succeeded = results.filter(r => r.success).length;
  console.log(`[FINGERPRINT] Complete: ${succeeded}/${images.length} images fingerprinted successfully`);

  return results;
}

/**
 * Save a fingerprint record to the database.
 *
 * @param {object} record - { batch_id, image_name, image_path, visual_json, status, error_message }
 */
async function saveFingerprintToDb(record) {
  const { error } = await supabase
    .from(ZIP_IMAGE_FINGERPRINTS_TABLE)
    .insert({
      batch_id: record.batch_id,
      image_name: record.image_name,
      image_path: record.image_path,
      visual_json: record.visual_json,
      status: record.status,
      error_message: record.error_message || null,
      processed_at: new Date().toISOString()
    });

  if (error) {
    throw new Error(`Database insert failed: ${error.message}`);
  }
}

/**
 * Load existing fingerprints for a batch from the database.
 * Used to avoid re-fingerprinting images that were already processed.
 *
 * @param {string} batchId - Batch identifier
 * @returns {Promise<Array<object>>} Array of fingerprint records
 */
export async function loadFingerprintsForBatch(batchId) {
  const { data, error } = await supabase
    .from(ZIP_IMAGE_FINGERPRINTS_TABLE)
    .select('*')
    .eq('batch_id', batchId)
    .eq('status', 'completed');

  if (error) {
    console.error(`[FINGERPRINT] Failed to load fingerprints for batch ${batchId}: ${error.message}`);
    return [];
  }

  return data || [];
}

/**
 * Get fingerprints as a map keyed by image name for fast lookup.
 *
 * @param {Array<object>} fingerprints - Array of fingerprint records
 * @returns {object} Map of image_name -> parsed fingerprint
 */
export function buildFingerprintMap(fingerprints) {
  const map = {};
  for (const fp of fingerprints) {
    if (fp.visual_json) {
      try {
        map[fp.image_name] = typeof fp.visual_json === 'string'
          ? JSON.parse(fp.visual_json)
          : fp.visual_json;
      } catch {
        // Skip malformed fingerprints
      }
    }
  }
  return map;
}
