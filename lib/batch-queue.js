// ═══════════════════════════════════════════════════════════════════
//  lib/batch-queue.js — Batch Queue System with Progress Tracking
//
//  Manages the entire batch processing lifecycle:
//    1. Create batch job (Queued)
//    2. Extract PDF (Extracting PDF)
//    3. Fingerprint ZIP images (Fingerprinting ZIP Images)
//    4. Filter candidates (Filtering Candidates)
//    5. Verify with OpenAI (Verifying with OpenAI)
//    6. Retry failed items (Retrying Failed Items)
//    7. Manual review (Needs Review)
//    8. Complete (Completed / Failed)
//
//  Architecture:
//    - Each batch has a unique ID and tracks stage, progress, ETA
//    - Progress is saved to Supabase after every step
//    - Activity log records all events with timestamps
//    - Retry manager handles failed items
//
//  Key rules:
//    - NEVER auto-accept API failures
//    - NEVER use sequential fallback
//    - Save results after every step
// ═══════════════════════════════════════════════════════════════════

import { supabase, BATCH_JOBS_TABLE, ZIP_IMAGE_FINGERPRINTS_TABLE, PRODUCT_MATCHES_TABLE } from './supabase.js';
import { createProgressEstimator, formatTimestamp } from './progress-estimator.js';
import { createRetryManager } from './retry-manager.js';
import { fingerprintAllImages, loadFingerprintsForBatch, buildFingerprintMap } from './image-fingerprint.js';
import { filterAllCandidates } from './candidate-filter.js';
import { verifyAllProducts } from './openai-verify.js';

// Allowed statuses
const BATCH_STATUSES = [
  'queued',
  'extracting_pdf',
  'fingerprinting_zip',
  'filtering_candidates',
  'verifying_with_openai',
  'retrying_failed',
  'needs_review',
  'completed',
  'failed'
];

/**
 * Create a new batch job in the database.
 *
 * @param {object} params
 * @param {string} params.sourcePdf - Original PDF filename
 * @param {string} params.sourceZip - Original ZIP filename
 * @param {number} params.totalProducts - Number of products extracted from PDF
 * @param {number} params.totalImages - Number of images in ZIP
 * @returns {Promise<object>} Created batch job record
 */
export async function createBatchJob({ sourcePdf, sourceZip, totalProducts, totalImages }) {
  const now = new Date().toISOString();

  // Estimate total processing time based on item counts
  // Fingerprinting: ~4 sec per image, Verification: ~5 sec per product
  const estimatedFingerprintSec = totalImages * 4;
  const estimatedVerifySec = totalProducts * 5;
  const estimatedTotalSec = estimatedFingerprintSec + estimatedVerifySec + 120; // 2 min buffer

  const batchJob = {
    status: 'queued',
    stage: 'Queued',
    progress_percent: 0,
    total_products: totalProducts,
    total_images: totalImages,
    completed_products: 0,
    failed_items: 0,
    retry_items: 0,
    source_pdf: sourcePdf,
    source_zip: sourceZip,
    started_at: now,
    estimated_seconds_total: estimatedTotalSec,
    estimated_seconds_remaining: estimatedTotalSec,
    current_item: '',
    last_error: null,
    activity_log: JSON.stringify([{
      timestamp: formatTimestamp(now),
      message: `Batch created: ${totalProducts} products, ${totalImages} images`
    }])
  };

  const { data, error } = await supabase
    .from(BATCH_JOBS_TABLE)
    .insert(batchJob)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create batch job: ${error.message}`);
  }

  console.log(`[BATCH-QUEUE] Created batch job ${data.id}: ${totalProducts} products, ${totalImages} images`);
  return data;
}

/**
 * Update batch job status and progress in the database.
 *
 * @param {number} batchId - Batch job ID
 * @param {object} updates - Fields to update
 */
export async function updateBatchJob(batchId, updates) {
  const allowedFields = [
    'status', 'stage', 'progress_percent', 'completed_products',
    'failed_items', 'retry_items', 'current_item', 'last_error',
    'estimated_seconds_remaining', 'activity_log', 'completed_at'
  ];

  const cleanUpdates = {};
  for (const key of allowedFields) {
    if (updates[key] !== undefined) {
      cleanUpdates[key] = updates[key];
    }
  }

  if (Object.keys(cleanUpdates).length === 0) return;

  cleanUpdates.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from(BATCH_JOBS_TABLE)
    .update(cleanUpdates)
    .eq('id', batchId);

  if (error) {
    console.error(`[BATCH-QUEUE] Failed to update batch ${batchId}: ${error.message}`);
  }
}

/**
 * Add an activity log entry to the batch job.
 *
 * @param {number} batchId - Batch job ID
 * @param {string} message - Log message
 */
export async function addActivityLog(batchId, message) {
  try {
    const { data: batch } = await supabase
      .from(BATCH_JOBS_TABLE)
      .select('activity_log')
      .eq('id', batchId)
      .single();

    let logs = [];
    if (batch?.activity_log) {
      try {
        logs = typeof batch.activity_log === 'string'
          ? JSON.parse(batch.activity_log)
          : batch.activity_log;
      } catch {
        logs = [];
      }
    }

    logs.push({
      timestamp: formatTimestamp(new Date()),
      message
    });

    // Keep only last 100 entries
    if (logs.length > 100) {
      logs = logs.slice(-100);
    }

    await updateBatchJob(batchId, {
      activity_log: JSON.stringify(logs)
    });
  } catch (err) {
    console.error(`[BATCH-QUEUE] Failed to add activity log: ${err.message}`);
  }
}

/**
 * Save a product match result to the database.
 *
 * @param {object} match - Match result
 * @param {number} batchId - Batch job ID
 */
export async function saveProductMatch(match, batchId) {
  const record = {
    batch_id: batchId,
    product_code: match.product?.productCode || match.product?.generatedCode || '',
    product_name: match.product?.name || '',
    product_description: match.product?.description || '',
    selected_image_id: match.bestMatch?.imageIndex !== undefined ? String(match.bestMatch.imageIndex) : null,
    selected_image_name: match.bestMatch?.imageName || null,
    top_candidates: match.allResults ? JSON.stringify(match.allResults.map(r => ({
      imageIndex: r.imageIndex,
      imageName: r.imageName,
      confidence: r.data?.confidence || 0,
      status: r.data?.status || 'unknown'
    }))) : null,
    confidence: match.bestMatch?.confidence || 0,
    reason: match.reason || '',
    status: match.status || 'no_candidates'
  };

  const { error } = await supabase
    .from(PRODUCT_MATCHES_TABLE)
    .insert(record);

  if (error) {
    console.error(`[BATCH-QUEUE] Failed to save product match: ${error.message}`);
  }
}

/**
 * Run the full batch processing pipeline.
 *
 * @param {object} params
 * @param {Buffer} params.pdfBuffer - PDF file buffer
 * @param {Buffer} params.zipBuffer - ZIP file buffer
 * @param {Array<object>} params.products - Extracted products from PDF
 * @param {Array<object>} params.images - Extracted ZIP images
 * @param {Array<object>} params.pdfImages - PDF page images (optional)
 * @param {string} params.sourcePdf - Original PDF filename
 * @param {string} params.sourceZip - Original ZIP filename
 * @param {object} [options]
 * @param {function} [options.onProgress] - Progress callback (batchState)
 * @returns {Promise<object>} Final batch result
 */
export async function runBatchPipeline(params, options = {}) {
  const { pdfBuffer, zipBuffer, products, images, pdfImages, sourcePdf, sourceZip, existingBatchId } = params;
  const onProgress = options.onProgress || null;

  // ── Create batch job (or use existing one) ──────────────────────
  let batchId;
  if (existingBatchId) {
    batchId = existingBatchId;
    await updateBatchJob(batchId, {
      status: 'extracting_pdf',
      stage: 'Extracting PDF',
      progress_percent: 0
    });
  } else {
    const batch = await createBatchJob({
      sourcePdf: sourcePdf || 'unknown.pdf',
      sourceZip: sourceZip || 'unknown.zip',
      totalProducts: products.length,
      totalImages: images.length
    });
    batchId = batch.id;
  }
  const progressEstimator = createProgressEstimator({ totalItems: products.length + images.length });
  const retryManager = createRetryManager({ maxRetries: 3 });

  progressEstimator.start();

  try {
    // ── Stage: Extracting PDF ─────────────────────────────────────
    await updateBatchJob(batchId, {
      status: 'extracting_pdf',
      stage: 'Extracting PDF',
      progress_percent: 0
    });
    progressEstimator.setStage('Extracting PDF');
    await addActivityLog(batchId, `Extracted ${products.length} products from PDF`);
    if (onProgress) onProgress(await getBatchState(batchId));

    // ── Stage: Fingerprinting ZIP Images ──────────────────────────
    await updateBatchJob(batchId, {
      status: 'fingerprinting_zip',
      stage: 'Fingerprinting ZIP Images',
      progress_percent: 5
    });
    progressEstimator.setStage('Fingerprinting ZIP Images');
    await addActivityLog(batchId, `Starting fingerprinting for ${images.length} images`);

    // Check if fingerprints already exist for this batch
    let existingFingerprints = await loadFingerprintsForBatch(batchId);
    let fingerprintMap = buildFingerprintMap(existingFingerprints);

    if (existingFingerprints.length < images.length) {
      // Need to fingerprint remaining images
      const fingerprintedImages = images.filter(img =>
        !fingerprintMap[img.name]
      );

      if (fingerprintedImages.length > 0) {
        await fingerprintAllImages(images, batchId, {
          delayMs: parseInt(process.env.OPENAI_VERIFY_DELAY_MS || '3000', 10),
          onProgress: (current, total) => {
            const progress = 5 + Math.round((current / total) * 25);
            updateBatchJob(batchId, {
              progress_percent: progress,
              current_item: `Fingerprinting image ${current}/${total}`
            }).catch(() => {});
          }
        });

        // Reload fingerprints after processing
        existingFingerprints = await loadFingerprintsForBatch(batchId);
        fingerprintMap = buildFingerprintMap(existingFingerprints);
      }
    }

    await addActivityLog(batchId, `Fingerprinted ${existingFingerprints.length} images`);
    if (onProgress) onProgress(await getBatchState(batchId));

    // ── Stage: Filtering Candidates ───────────────────────────────
    await updateBatchJob(batchId, {
      status: 'filtering_candidates',
      stage: 'Filtering Candidates',
      progress_percent: 35
    });
    progressEstimator.setStage('Filtering Candidates');

    const candidateResults = filterAllCandidates(products, images, fingerprintMap, {
      maxCandidates: parseInt(process.env.MAX_CANDIDATES_PER_PRODUCT || '5', 10),
      minScore: parseInt(process.env.MIN_CANDIDATE_SCORE || '10', 10)
    });

    const totalCandidates = candidateResults.reduce((sum, c) => sum + c.candidates.length, 0);
    await addActivityLog(batchId, `Filtered to ${totalCandidates} candidates across ${products.length} products`);
    if (onProgress) onProgress(await getBatchState(batchId));

    // ── Stage: Verifying with OpenAI ──────────────────────────────
    await updateBatchJob(batchId, {
      status: 'verifying_with_openai',
      stage: 'Verifying with OpenAI',
      progress_percent: 40
    });
    progressEstimator.setStage('Verifying with OpenAI');

    const verifyResults = await verifyAllProducts(products, candidateResults, pdfImages || [], {
      concurrency: parseInt(process.env.OPENAI_MAX_CONCURRENCY || '2', 10),
      allImages: images,
      onProgress: (completed, total, result) => {
        const progress = 40 + Math.round((completed / total) * 40);
        const productName = result?.product?.name || result?.product?.productCode || `product ${completed}`;
        const status = result?.status || 'unknown';

        updateBatchJob(batchId, {
          progress_percent: progress,
          completed_products: completed,
          current_item: `${productName}: ${status}`
        }).catch(() => {});

        progressEstimator.completeItem(completed - 1);

        // Update ETA
        const prog = progressEstimator.getProgress();
        updateBatchJob(batchId, {
          estimated_seconds_remaining: prog.estimatedRemainingSec
        }).catch(() => {});
      }
    });

    // Save each match result to DB
    for (const result of verifyResults) {
      await saveProductMatch(result, batchId);
    }

    const autoAccepted = verifyResults.filter(r => r.status === 'auto_accepted').length;
    const needsReview = verifyResults.filter(r => r.status === 'needs_review').length;
    const retryNeeded = verifyResults.filter(r => r.status === 'retry_needed').length;
    const rejected = verifyResults.filter(r => r.status === 'rejected' || r.status === 'no_candidates').length;

    await addActivityLog(batchId,
      `Verification complete: ${autoAccepted} auto-accepted, ${needsReview} needs review, ${retryNeeded} retry needed, ${rejected} rejected`
    );

    // ── Stage: Retrying Failed Items ──────────────────────────────
    const failedItems = verifyResults.filter(r => r.status === 'retry_needed');

    if (failedItems.length > 0) {
      await updateBatchJob(batchId, {
        status: 'retrying_failed',
        stage: 'Retrying Failed Items',
        retry_items: failedItems.length
      });
      progressEstimator.setStage('Retrying Failed Items');
      await addActivityLog(batchId, `Retrying ${failedItems.length} failed items`);

      // Retry logic is handled by the retry manager inside verifyAllProducts
      // For now, mark them as needs_review so the user can manually handle them
      for (const failed of failedItems) {
        failed.status = 'needs_review';
        failed.reason = 'API verification failed after retries — needs manual review';
        await saveProductMatch(failed, batchId);
      }

      await addActivityLog(batchId, `${failedItems.length} items moved to manual review after retry exhaustion`);
    }

    // ── Final: Determine overall status ────────────────────────────
    const hasReviewItems = verifyResults.some(r =>
      r.status === 'needs_review' || r.status === 'retry_needed'
    );

    let finalStatus, finalStage;
    if (hasReviewItems) {
      finalStatus = 'needs_review';
      finalStage = 'Needs Review';
    } else {
      finalStatus = 'completed';
      finalStage = 'Completed';
    }

    const completedCount = verifyResults.filter(r =>
      r.status === 'auto_accepted' || r.status === 'needs_review'
    ).length;

    await updateBatchJob(batchId, {
      status: finalStatus,
      stage: finalStage,
      progress_percent: 100,
      completed_products: completedCount,
      failed_items: rejected,
      completed_at: new Date().toISOString(),
      estimated_seconds_remaining: 0
    });

    await addActivityLog(batchId,
      `Batch ${finalStatus}: ${autoAccepted} auto-accepted, ${needsReview} needs review`
    );

    if (onProgress) onProgress(await getBatchState(batchId));

    return {
      batchId,
      status: finalStatus,
      stage: finalStage,
      results: verifyResults,
      stats: {
        total: products.length,
        autoAccepted,
        needsReview,
        rejected,
        retryNeeded
      }
    };

  } catch (err) {
    console.error(`[BATCH-QUEUE] Pipeline error for batch ${batchId}: ${err.message}`);
    await updateBatchJob(batchId, {
      status: 'failed',
      stage: 'Failed',
      last_error: err.message,
      completed_at: new Date().toISOString()
    });
    await addActivityLog(batchId, `Pipeline failed: ${err.message}`);
    if (onProgress) onProgress(await getBatchState(batchId));

    return {
      batchId,
      status: 'failed',
      error: err.message,
      results: []
    };
  }
}

/**
 * Get the current state of a batch job from the database.
 *
 * @param {number} batchId - Batch job ID
 * @returns {Promise<object|null>} Batch job state
 */
export async function getBatchState(batchId) {
  const { data, error } = await supabase
    .from(BATCH_JOBS_TABLE)
    .select('*')
    .eq('id', batchId)
    .single();

  if (error) {
    console.error(`[BATCH-QUEUE] Failed to get batch ${batchId}: ${error.message}`);
    return null;
  }

  // Parse activity_log if it's a string
  if (data && typeof data.activity_log === 'string') {
    try {
      data.activity_log = JSON.parse(data.activity_log);
    } catch {
      data.activity_log = [];
    }
  }

  return data;
}

/**
 * Get all batch jobs with optional status filter.
 *
 * @param {object} [options]
 * @param {string} [options.status] - Filter by status
 * @param {number} [options.limit=20] - Max results
 * @returns {Promise<Array<object>>} Batch jobs
 */
export async function listBatchJobs(options = {}) {
  const status = options.status || null;
  const limit = options.limit || 20;

  let query = supabase
    .from(BATCH_JOBS_TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status && BATCH_STATUSES.includes(status)) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;

  if (error) {
    console.error(`[BATCH-QUEUE] Failed to list batches: ${error.message}`);
    return [];
  }

  // Parse activity_log for each batch
  return (data || []).map(b => {
    if (typeof b.activity_log === 'string') {
      try {
        b.activity_log = JSON.parse(b.activity_log);
      } catch {
        b.activity_log = [];
      }
    }
    return b;
  });
}
