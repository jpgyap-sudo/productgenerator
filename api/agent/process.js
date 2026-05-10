// ═══════════════════════════════════════════════════════════════════
//  api/agent/process.js — POST /api/agent/process
//  Uploading Agent: Accepts PDF + ZIP, extracts product info + images
//  using DeepSeek AI for text analysis and adm-zip for image extraction.
//
//  Phase 1 (Extract & Inspect): Returns ALL images with data URLs so
//  the user can preview every image before matching.
//  Also extracts PDF page images for GPT-4o visual product matching.
//
//  Batch mode (optional): When `useBatchQueue=true` in the request body,
//  the pipeline runs the full batch queue system including:
//    - ZIP image fingerprinting (OpenAI Vision, once per image)
//    - Fast candidate filtering (attribute-based, no AI)
//    - OpenAI Vision verification (strict JSON, confidence scoring)
//    - Progress tracking with ETA
//    - Results saved to database
// ═══════════════════════════════════════════════════════════════════

import multer from 'multer';
import { extractTextFromPDF } from '../../lib/pdf-extractor.js';
import { extractImagesFromPDF } from '../../lib/pdf-image-extractor.js';
import { extractAllImagesFromZip } from '../../lib/zip-extractor.js';
import { extractProductInfo } from '../../lib/deepseek.js';
import { saveImagesToGallery } from '../../lib/upload-gallery.js';
import { runBatchPipeline } from '../../lib/batch-queue.js';

// Multer config — store files in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per file
    files: 2 // PDF + ZIP
  },
  fileFilter: (req, file, cb) => {
    const isPDF = file.mimetype === 'application/pdf'
      || file.originalname.toLowerCase().endsWith('.pdf');
    const isZIP = file.mimetype === 'application/zip'
      || file.mimetype === 'application/x-zip-compressed'
      || file.originalname.toLowerCase().endsWith('.zip');

    if (isPDF || isZIP) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Only PDF and ZIP files are accepted.`));
    }
  }
});

/**
 * Express middleware wrapper for multer.
 */
function multerMiddleware(req, res) {
  return new Promise((resolve, reject) => {
    upload.fields([
      { name: 'pdf', maxCount: 1 },
      { name: 'zip', maxCount: 1 }
    ])(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * POST /api/agent/process
 *
 * Request: multipart/form-data
 *   - pdf: PDF file (product catalog)
 *   - zip: ZIP file (product images)
 *
 * Response:
 *   {
 *     success: true,
 *     products: [{ name, brand, productCode, generatedCode, description, category }],
 *     allImages: [{ name, width, height, size, dataUrl }],  ← ALL images with data URLs
 *     pdfImages: [{ page, dataUrl, width, height, size }],  ← PDF page images for visual matching
 *     rawText: "...",
 *     totalImages: 57
 *   }
 */
export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let rawText = '';

    // Parse multipart form data
    await multerMiddleware(req, res);

    const pdfFile = req.files?.pdf?.[0];
    const zipFile = req.files?.zip?.[0];

    if (!pdfFile) {
      return res.status(400).json({ error: 'PDF file is required' });
    }

    if (!zipFile) {
      return res.status(400).json({ error: 'ZIP file is required' });
    }

    console.log(`[AGENT] Processing PDF: "${pdfFile.originalname}" (${(pdfFile.buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`[AGENT] Processing ZIP: "${zipFile.originalname}" (${(zipFile.buffer.length / 1024 / 1024).toFixed(2)} MB)`);

    // Step 1: Extract ALL images from ZIP with data URLs for preview
    console.log('[AGENT] Step 1: Extracting ZIP images...');
    const zipResult = await extractAllImagesFromZip(zipFile.buffer);

    if (zipResult.totalImages === 0) {
      return res.status(400).json({
        error: 'No valid images found in the ZIP file.',
        rawText
      });
    }

    console.log(`[AGENT] ZIP images extracted: ${zipResult.totalImages} images found, returning ${zipResult.images.length} for preview`);

    // Step 1b: Save images to VPS upload gallery for persistent access
    // This ensures images survive the matchmaking flow (dataUrls are stripped by match.js)
    const batchId = `batch_${Date.now()}`;
    try {
      const galleryImages = await saveImagesToGallery(zipResult.images, batchId);
      // Attach gallery URLs to each image for server-side resolution
      const urlMap = {};
      galleryImages.forEach(gi => { urlMap[gi.name] = gi.url; });
      zipResult.images.forEach(img => {
        img.galleryUrl = urlMap[img.name] || '';
      });
      zipResult.batchId = batchId;
      console.log(`[AGENT] Saved ${galleryImages.length} images to gallery (batch: ${batchId})`);
    } catch (galleryErr) {
      console.warn('[AGENT] Gallery save failed (non-fatal):', galleryErr.message);
      // Continue with dataUrls only — gallery is optional for preview
    }

    // Step 2: Extract images from PDF pages (for GPT-4o visual matching)
    console.log('[AGENT] Step 2: Extracting PDF page images...');
    let pdfImages = [];
    try {
      pdfImages = await extractImagesFromPDF(pdfFile.buffer);
      console.log(`[AGENT] Extracted ${pdfImages.length} PDF page images`);
    } catch (pdfImgErr) {
      console.warn('[AGENT] PDF image extraction failed (non-fatal):', pdfImgErr.message);
      // Continue without PDF images — matching will use text-only fallback
    }

    // Step 3: Extract text from PDF
    console.log('[AGENT] Step 3: Extracting PDF text...');
    let pdfResult = { text: '', pages: 0 };

    try {
      pdfResult = await extractTextFromPDF(pdfFile.buffer);
      rawText = pdfResult.text || '';
    } catch (pdfErr) {
      console.error('[AGENT] PDF extraction failed:', pdfErr.message);
      return res.json({
        success: true,
        products: [],
        allImages: zipResult.images,
        rawText: '',
        totalImages: zipResult.totalImages,
        pdfError: pdfErr.message,
        warning: `PDF text extraction failed: ${pdfErr.message}. You can manually enter product details below.`
      });
    }

    if (!rawText || rawText.length < 10) {
      return res.json({
        success: true,
        products: [],
        allImages: zipResult.images,
        rawText: rawText || '',
        totalImages: zipResult.totalImages,
        warning: 'Could not extract meaningful text from the PDF. The file may be scanned/image-based. You can manually enter product details below.'
      });
    }

    console.log(`[AGENT] PDF text extracted: ${rawText.length} chars from ${pdfResult.pages} pages`);

    // Step 4: Use DeepSeek to extract product info from PDF text
    console.log('[AGENT] Step 4: Analyzing PDF text with DeepSeek...');
    let products = [];

    try {
      products = await extractProductInfo(rawText);
      console.log(`[AGENT] DeepSeek extracted ${products.length} product(s)`);

      // Auto-generate product codes: HA + originalCode + R
      // e.g., CH-005 → HACH-005R
      products = products.map(p => ({
        ...p,
        generatedCode: p.productCode
          ? `HA${p.productCode}R`
          : ''
      }));
    } catch (aiErr) {
      console.error('[AGENT] DeepSeek extraction failed:', aiErr.message);
      return res.json({
        success: true,
        products: [],
        allImages: zipResult.images,
        rawText,
        totalImages: zipResult.totalImages,
        aiError: aiErr.message,
        warning: 'AI extraction failed. You can manually enter product details below.'
      });
    }

    if (products.length === 0) {
      return res.json({
        success: true,
        products: [],
        allImages: zipResult.images,
        rawText,
        totalImages: zipResult.totalImages,
        warning: 'No product information could be extracted from the PDF. You can manually enter details below.'
      });
    }

    // Step 5: Optionally run the full batch pipeline (fingerprinting + verification)
    // Triggered by `useBatchQueue: true` in the request body.
    // This runs the slow but accurate pipeline and saves results to the database.
    const useBatchQueue = req.body?.useBatchQueue === true || req.body?.useBatchQueue === 'true';

    if (useBatchQueue) {
      console.log('[AGENT] Step 5: Running batch queue pipeline (fingerprinting + verification)...');

      try {
        const batchResult = await runBatchPipeline({
          pdfBuffer: pdfFile.buffer,
          zipBuffer: zipFile.buffer,
          products,
          images: zipResult.images,
          pdfImages,
          sourcePdf: pdfFile.originalname,
          sourceZip: zipFile.originalname
        });

        console.log(`[AGENT] Batch pipeline complete: ${batchResult.status} (batch ID: ${batchResult.batchId})`);

        return res.json({
          success: true,
          batchMode: true,
          batchId: batchResult.batchId,
          products,
          allImages: zipResult.images,
          pdfImages,
          rawText,
          totalImages: zipResult.totalImages,
          batchStatus: batchResult.status,
          batchStage: batchResult.stage,
          matchStats: batchResult.stats,
          matches: batchResult.results.map(r => ({
            productIndex: r.productIndex,
            product: r.product,
            bestMatch: r.bestMatch ? {
              imageIndex: r.bestMatch.imageIndex,
              imageName: r.bestMatch.imageName,
              confidence: r.bestMatch.confidence,
              reason: r.bestMatch.reason,
              status: r.bestMatch.status
            } : null,
            status: r.status,
            reason: r.reason
          }))
        });
      } catch (batchErr) {
        console.error('[AGENT] Batch pipeline failed:', batchErr.message);
        // Fall back to returning standard results
        return res.json({
          success: true,
          batchMode: true,
          batchError: batchErr.message,
          products,
          allImages: zipResult.images,
          pdfImages,
          rawText,
          totalImages: zipResult.totalImages,
          batchId: zipResult.batchId || ''
        });
      }
    }

    // Standard mode: Return results with ALL images + PDF page images for Phase 2 matching
    console.log('[AGENT] Analysis complete. Returning results.');
    return res.json({
      success: true,
      products,
      allImages: zipResult.images,
      pdfImages,  // PDF page images for GPT-4o visual matching
      rawText,
      totalImages: zipResult.totalImages,
      batchId: zipResult.batchId || ''
    });

  } catch (err) {
    console.error('[AGENT] Process error:', err);

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Maximum size is 50MB per file.' });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Only one PDF and one ZIP file are accepted.' });
    }
    if (err.message?.includes('Unsupported file type')) {
      return res.status(400).json({ error: err.message });
    }

    return res.status(500).json({
      error: `Failed to process upload: ${err.message}`,
      code: err.code || null
    });
  }
}
