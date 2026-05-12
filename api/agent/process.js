// ═══════════════════════════════════════════════════════════════════
//  api/agent/process.js — POST /api/agent/process
//  Uploading Agent: Accepts PDF/WPS/ET + ZIP (or standalone), extracts
//  product info + images using DeepSeek AI for text analysis.
//
//  Supported file types:
//    - PDF: Text extraction via pdf-parse, page image extraction via pdfjs-dist
//    - .wps: WPS Writer document (treated like PDF)
//    - .et:  WPS Spreadsheet (parsed via SheetJS/xlsx)
//    - .zip: Product images (optional, for standard matching mode)
//
//  Standalone mode (no ZIP): When only a document is uploaded, the system
//  extracts products from text via DeepSeek AND extracts page images
//  (PDF/WPS) for AI per-row matching. For .et files, no page images
//  are available — products are extracted from spreadsheet rows.
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
import os from 'os';
import path from 'path';
import { extractTextFromPDF } from '../../lib/pdf-extractor.js';
import { extractImagesFromPDF } from '../../lib/pdf-image-extractor.js';
import { extractTextFromET } from '../../lib/et-extractor.js';
import { extractETImagesAndData, verifyEtMatchesWithAI } from '../../lib/et-image-extractor.js';
import { extractAllImagesFromZip } from '../../lib/zip-extractor.js';
import { extractProductInfo } from '../../lib/deepseek.js';
import { saveImagesToGallery } from '../../lib/upload-gallery.js';
import { runBatchPipeline, createBatchJob, autoResumePausedBatches } from '../../lib/batch-queue.js';

// ── ET extraction progress store ────────────────────────────────────
// Global Map<batchId, { percent, stage, detail }> for .et extraction progress.
// The UI polls GET /api/agent/et-progress/:batchId to show a progress bar.
export const etProgressStore = new Map();

// ── ET extraction pause store ───────────────────────────────────────
// Global Map<batchId, { paused: boolean }> for pause/resume support.
// The UI calls POST /api/agent/et-pause/:batchId to toggle pause.
// Imported from et-image-extractor for the server endpoint.
import { etPauseStore } from '../../lib/et-image-extractor.js';
export { etPauseStore };

// Multer config — store files in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per file
    files: 2 // PDF + ZIP (or just PDF)
  },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase();
    const isPDF = file.mimetype === 'application/pdf' || ext.endsWith('.pdf');
    const isZIP = file.mimetype === 'application/zip'
      || file.mimetype === 'application/x-zip-compressed'
      || ext.endsWith('.zip');
    const isWPS = ext.endsWith('.wps');
    const isET = ext.endsWith('.et');

    if (isPDF || isZIP || isWPS || isET) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Only PDF, WPS, ET, and ZIP files are accepted.`));
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

    console.log('[AGENT] req.body keys:', Object.keys(req.body || {}));
    console.log('[AGENT] req.body.useBatchQueue:', req.body?.useBatchQueue, '(type:', typeof req.body?.useBatchQueue, ')');

    const pdfFile = req.files?.pdf?.[0];
    const zipFile = req.files?.zip?.[0];

    if (!pdfFile) {
      return res.status(400).json({ error: 'A document file (PDF, WPS, or ET) is required' });
    }

    // ── Detect file type ─────────────────────────────────────────────
    const fileName = pdfFile.originalname.toLowerCase();
    const isPDF = fileName.endsWith('.pdf');
    const isWPS = fileName.endsWith('.wps');
    const isET = fileName.endsWith('.et');
    const isSpreadsheet = isET; // .et is a spreadsheet format
    const isDocument = isPDF || isWPS; // PDF/WPS are document formats with pages

    // ── Determine mode: standalone or with ZIP ───────────────────────
    const isStandalone = !zipFile;

    console.log(`[AGENT] Processing file: "${pdfFile.originalname}" (${(pdfFile.buffer.length / 1024 / 1024).toFixed(2)} MB, type: ${isET ? 'ET' : isWPS ? 'WPS' : 'PDF'})`);
    if (zipFile) {
      console.log(`[AGENT] Processing ZIP: "${zipFile.originalname}" (${(zipFile.buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    }
    console.log(`[AGENT] Mode: ${isStandalone ? 'Standalone (AI per-row matching)' : 'Document+ZIP (standard batch)'}`);

    // ── Step 1: Extract images from source ──────────────────────────
    let zipResult = { images: [], totalImages: 0, batchId: '' };
    let pdfImages = [];

    if (zipFile) {
      // Standard mode: Extract ALL images from ZIP with data URLs for preview
      console.log('[AGENT] Step 1: Extracting ZIP images...');
      zipResult = await extractAllImagesFromZip(zipFile.buffer);

      if (zipResult.totalImages === 0) {
        return res.status(400).json({
          error: 'No valid images found in the ZIP file.',
          rawText
        });
      }

      console.log(`[AGENT] ZIP images extracted: ${zipResult.totalImages} images found, returning ${zipResult.images.length} for preview`);

      // Save images to VPS upload gallery for persistent access
      const batchId = `batch_${Date.now()}`;
      try {
        const galleryImages = await saveImagesToGallery(zipResult.images, batchId);
        const urlMap = {};
        galleryImages.forEach(gi => { urlMap[gi.name] = gi.url; });
        zipResult.images.forEach(img => {
          img.galleryUrl = urlMap[img.name] || '';
        });
        zipResult.batchId = batchId;
        console.log(`[AGENT] Saved ${galleryImages.length} images to gallery (batch: ${batchId})`);
      } catch (galleryErr) {
        console.warn('[AGENT] Gallery save failed (non-fatal):', galleryErr.message);
      }

      // Extract images from document pages (for GPT-4o visual matching)
      if (isDocument) {
        console.log('[AGENT] Step 1b: Extracting document page images...');
        try {
          pdfImages = await extractImagesFromPDF(pdfFile.buffer);
          console.log(`[AGENT] Extracted ${pdfImages.length} page images`);
        } catch (pdfImgErr) {
          console.warn('[AGENT] Page image extraction failed (non-fatal):', pdfImgErr.message);
        }
      } else {
        console.log('[AGENT] Step 1b: Skipping page image extraction for spreadsheet (.et) format');
      }
    } else {
      // Standalone mode: Extract page images from document (PDF/WPS only)
      if (isDocument) {
        console.log('[AGENT] Step 1 (standalone): Extracting page images as product images...');
        try {
          // Pass a COPY of the buffer so the original remains intact for text extraction.
          // pdfjs-dist's getDocument({ data: buffer.buffer }) may consume the underlying
          // ArrayBuffer, leaving the original Buffer empty.
          const pages = await extractImagesFromPDF(Buffer.from(pdfFile.buffer));
          // Map PDF pages to the same format as ZIP images for compatibility
          zipResult.images = pages.map((page, idx) => ({
            name: `page_${page.page}.png`,
            dataUrl: page.dataUrl,
            width: page.width,
            height: page.height,
            size: page.size,
            galleryUrl: '',
            isPdfPage: true,
            pageNumber: page.page
          }));
          zipResult.totalImages = zipResult.images.length;
          zipResult.batchId = `batch_${Date.now()}`;
          console.log(`[AGENT] Standalone: extracted ${zipResult.totalImages} page images`);
        } catch (pdfImgErr) {
          console.warn('[AGENT] Page image extraction failed:', pdfImgErr.message);
          // Continue — we'll still have text products even without page images
        }
      } else {
        // .et files (standalone): Extract embedded images + row data via LibreOffice + exceljs
        // .et files are WPS Spreadsheets — they contain product data AND embedded images in cells.
        // The extractor converts .et → .xlsx (LibreOffice), extracts images + cell anchors (exceljs),
        // and parses row data (SheetJS) — all without AI.
        console.log('[AGENT] Step 1 (standalone): .et spreadsheet — extracting embedded images + row data...');
        const etBatchId = `et_${Date.now()}`;
        zipResult.batchId = etBatchId;

        // Initialize progress store for this extraction
        etProgressStore.set(etBatchId, { percent: 0, stage: 'Starting', detail: '' });

        try {
          const etImageResult = await extractETImagesAndData(pdfFile.buffer, {
            batchId: etBatchId, // For pause/resume support
            onProgress: (progress) => {
              // Update the global progress store so the UI can poll it
              etProgressStore.set(etBatchId, {
                percent: progress.percent,
                stage: progress.stage,
                detail: progress.detail || ''
              });
            }
          });

          // Clear progress store after completion
          etProgressStore.delete(etBatchId);

          if (etImageResult.hasEmbeddedImages && etImageResult.allImages.length > 0) {
            // Embedded images found! Store them for the UI
            zipResult.images = etImageResult.allImages;
            zipResult.totalImages = etImageResult.allImages.length;
            zipResult.hasEmbeddedImages = true;
            zipResult.etProducts = etImageResult.products || [];
            console.log(`[AGENT] .et embedded image extraction: ${etImageResult.allImages.length} images, ${etImageResult.products.length} products`);
          } else {
            // No embedded images found — this is an error for .et files
            // The user expects images to be embedded in the .et file
            console.error('[AGENT] .et embedded image extraction: no images found');
            return res.status(400).json({
              error: 'No embedded images found in the .et file. The .et file must contain product images embedded in cells.',
              warning: etImageResult.warning || 'LibreOffice conversion succeeded but no images were found.'
            });
          }
        } catch (etImgErr) {
          // Clear progress store on error
          etProgressStore.delete(etBatchId);
          console.error('[AGENT] .et embedded image extraction failed:', etImgErr.message);
          return res.status(400).json({
            error: `Failed to extract images from .et file: ${etImgErr.message}`,
            warning: 'Ensure LibreOffice is installed on the server. For .et files, embedded images are required.'
          });
        }
      }
    }

    // ── Step 2: Extract text from document ───────────────────────────
    // For .et files with embedded images, data is already extracted in Step 1.
    // For PDF/WPS files, extract text via pdf-parse.
    let textResult = { text: '', pages: 0, rows: 0 };
    // hasEtEmbeddedImages is true when the .et extractor found embedded images,
    // regardless of whether products were successfully parsed from rows.
    // Even with 0 products, we still have images to work with.
    const hasEtEmbeddedImages = zipResult.hasEmbeddedImages === true;

    if (hasEtEmbeddedImages) {
      // .et files with embedded images: data already extracted in Step 1
      // Skip text extraction — products are already structured with row data
      const productCount = (zipResult.etProducts && zipResult.etProducts.length) || 0;
      console.log(`[AGENT] Step 2: Skipping text extraction — .et embedded image data already extracted (${productCount} products, ${zipResult.totalImages || 0} images)`);
    } else {
      // PDF/WPS files: Extract text via pdf-parse
      console.log('[AGENT] Step 2: Extracting document text...');
      try {
        textResult = await extractTextFromPDF(pdfFile.buffer);
        rawText = textResult.text || '';
      } catch (pdfErr) {
        console.error('[AGENT] PDF extraction failed:', pdfErr.message);
        return res.json({
          success: true,
          products: [],
          allImages: zipResult.images,
          rawText: '',
          totalImages: zipResult.totalImages,
          pdfError: pdfErr.message,
          isPdfOnly: isStandalone,
          warning: `Document text extraction failed: ${pdfErr.message}. You can manually enter product details below.`
        });
      }

      if (!rawText || rawText.length < 10) {
        return res.json({
          success: true,
          products: [],
          allImages: zipResult.images,
          rawText: rawText || '',
          totalImages: zipResult.totalImages,
          isPdfOnly: isStandalone,
          warning: 'Could not extract meaningful text from the document. You can manually enter product details below.'
        });
      }

      console.log(`[AGENT] Document text extracted: ${rawText.length} chars`);
    }

    // ── Step 3: Extract product info ──────────────────────────────────
    // For .et with embedded images: use pre-extracted data (skip DeepSeek AI)
    // For PDF/WPS: use DeepSeek AI to extract structured products from raw text
    let products = [];

    if (hasEtEmbeddedImages) {
      // Use pre-extracted products from .et image extractor
      // These already have productCode, description, brand, and image mappings
      if (zipResult.etProducts && zipResult.etProducts.length > 0) {
        const rawProducts = zipResult.etProducts.map(p => ({
          name: p.name || '',
          brand: p.brand || '',
          productCode: p.productCode || '',
          // generatedCode: use product code as-is if it starts with "HA",
          // otherwise wrap with HA...R for Drive folder naming convention.
          // Prevents double-wrapping like "HA" + "HA" + "R" = "HAHAR".
          generatedCode: p.generatedCode || (p.productCode
            ? (p.productCode.startsWith('HA') ? p.productCode : `HA${p.productCode}R`)
            : ''),
          description: p.description || '',
          category: p.category || '',
          // Preserve image mapping info for the UI
          row: p.row,
          hasPreMappedImage: p.hasPreMappedImage,
          imageName: p.imageName || '',
          dataUrl: p.dataUrl || ''
        }));
        // ── Skip AI verification for .et files ────────────────────────────
        // The OLE2 ETCellImageData parser extracts images with exact UUID
        // matching (DISPIMG formula UUID → cellImages.xml UUID). This is
        // already 100% accurate — the image in each row is the correct one.
        // AI vision verification is unnecessary and causes false mismatches
        // (e.g., rejecting correct dining chair images because they look
        // similar to other dining chair images).
        //
        // All products are auto-accepted with the UUID-based match.
        console.log(`[AGENT] Step 3: ${rawProducts.length} pre-extracted products from .et (UUID-matched, skipping AI verification)`);

        products = rawProducts.map(p => ({
          name: p.name || '',
          brand: p.brand || '',
          productCode: p.productCode || '',
          // generatedCode: use product code as-is if it starts with "HA",
          // otherwise wrap with HA...R for Drive folder naming convention.
          generatedCode: p.generatedCode || (p.productCode
            ? (p.productCode.startsWith('HA') ? p.productCode : `HA${p.productCode}R`)
            : ''),
          description: p.description || '',
          category: p.category || '',
          row: p.row,
          hasPreMappedImage: p.hasPreMappedImage,
          imageName: p.imageName || '',
          dataUrl: p.dataUrl || '',
          // All UUID-matched products are auto-accepted
          aiVerified: false,
          aiConfidence: 100,
          aiReason: 'UUID-matched via OLE2 ETCellImageData — exact match, no AI verification needed',
          aiMatchStatus: 'auto_accepted'
        }));

        console.log(`[AGENT] Step 3: All ${products.length} products auto-accepted (UUID-matched)`);
      } else {
        // Embedded images found but no products could be parsed from rows.
        // This happens when the column structure doesn't match expected patterns.
        // Return the images anyway so the user can manually enter product data.
        console.log('[AGENT] Step 3: .et embedded images found but 0 products parsed — returning images for manual entry');
        return res.json({
          success: true,
          isPdfOnly: false,
          hasEmbeddedImages: true,
          products: [],
          allImages: zipResult.images,
          pdfImages: [],
          rawText: '',
          totalImages: zipResult.totalImages,
          batchId: zipResult.batchId || `et_${Date.now()}`,
          warning: 'Extracted images from the .et file but could not parse product data from spreadsheet rows. You can manually enter product details below.'
        });
      }
    } else {
      // PDF/WPS: Use DeepSeek AI to extract structured products from raw text
      console.log('[AGENT] Step 3: Analyzing text with DeepSeek AI...');
      try {
        products = await extractProductInfo(rawText);
        console.log(`[AGENT] DeepSeek extracted ${products.length} product(s)`);

        // Auto-generate product codes: HA + originalCode + R
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
          isPdfOnly: isStandalone,
          aiError: aiErr.message,
          warning: 'AI extraction failed. You can manually enter product details below.'
        });
      }
    }

    if (products.length === 0 && !hasEtEmbeddedImages) {
      return res.json({
        success: true,
        products: [],
        allImages: zipResult.images,
        rawText,
        totalImages: zipResult.totalImages,
        isPdfOnly: isStandalone,
        warning: 'No product information could be extracted from the document. You can manually enter details below.'
      });
    }

    // ── Step 4: Return results ──────────────────────────────────────
    // PDF-only mode: Return with isPdfOnly flag so the UI can show AI per-row matching
    // PDF+ZIP mode: Check for batch queue or standard mode

    const useBatchQueue = req.body?.useBatchQueue === true || req.body?.useBatchQueue === 'true';

    if (isStandalone) {
      if (hasEtEmbeddedImages) {
        // .et with embedded images — return products with AI-verified image matches
        // Products now have aiConfidence, aiMatchStatus from Gemini verification
        const autoAccepted = products.filter(p => p.aiMatchStatus === 'auto_accepted').length;
        const needsReview = products.filter(p => p.aiMatchStatus === 'needs_review').length;
        const rejected = products.filter(p => p.aiMatchStatus === 'rejected').length;
        console.log(`[AGENT] .et embedded image mode complete. ${products.length} products (${autoAccepted} auto, ${needsReview} review, ${rejected} rejected).`);
        return res.json({
          success: true,
          isPdfOnly: false,
          hasEmbeddedImages: true,
          aiVerified: true,
          aiStats: { autoAccepted, needsReview, rejected },
          products,
          allImages: zipResult.images,
          pdfImages: [],
          rawText: '',
          totalImages: zipResult.totalImages,
          batchId: zipResult.batchId || `et_${Date.now()}`
        });
      } else {
        // PDF/WPS standalone mode — return products + page images for AI per-row matching
        console.log('[AGENT] PDF-only mode complete. Returning products + page images for AI per-row matching.');
        return res.json({
          success: true,
          isPdfOnly: true,
          products,
          allImages: zipResult.images,
          pdfImages: [],  // In PDF-only mode, page images ARE the allImages
          rawText,
          totalImages: zipResult.totalImages,
          batchId: zipResult.batchId || `pdf_${Date.now()}`
        });
      }
    }

    // Standard PDF+ZIP mode
    if (useBatchQueue) {
      console.log('[AGENT] Step 5: Launching batch queue pipeline asynchronously...');

      // Auto-resume any paused batches from previous server sessions
      autoResumePausedBatches().catch(() => {});

      // Create the batch job first to get a batchId
      const batchJob = await createBatchJob({
        sourcePdf: pdfFile.originalname,
        sourceZip: zipFile.originalname,
        totalProducts: products.length,
        totalImages: zipResult.images.length
      });
      const batchId = batchJob.id;

      // Fire the pipeline in the background (no await) — it saves results to DB
      runBatchPipeline({
        pdfBuffer: pdfFile.buffer,
        zipBuffer: zipFile.buffer,
        products,
        images: zipResult.images,
        pdfImages,
        sourcePdf: pdfFile.originalname,
        sourceZip: zipFile.originalname,
        existingBatchId: batchId
      }).then(result => {
        console.log(`[AGENT] Batch pipeline complete: ${result.status} (batch ID: ${batchId})`);
      }).catch(err => {
        console.error(`[AGENT] Batch pipeline failed (batch ID: ${batchId}):`, err.message);
      });

      // Return immediately — UI will poll for results
      return res.json({
        success: true,
        batchMode: true,
        batchId,
        products,
        allImages: zipResult.images,
        pdfImages,
        rawText,
        totalImages: zipResult.totalImages,
        batchStatus: 'queued',
        batchStage: 'Starting pipeline...',
        matchStats: { autoAccepted: 0, needsReview: 0, rejected: 0, retryNeeded: 0 },
        matches: []
      });
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
