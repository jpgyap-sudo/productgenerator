// ═══════════════════════════════════════════════════════════════════
//  api/agent/process.js — POST /api/agent/process
//  Uploading Agent: Accepts PDF + ZIP, extracts product info + images
//  using DeepSeek AI for text analysis and adm-zip for image extraction.
// ═══════════════════════════════════════════════════════════════════

import multer from 'multer';
import { extractTextFromPDF } from '../../lib/pdf-extractor.js';
import { extractImagesFromZip } from '../../lib/zip-extractor.js';
import { extractProductInfo } from '../../lib/deepseek.js';

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
 *     selectedImage: { name, width, height, dataUrl },
 *     allImages: [{ name, width, height, score, selected, dataUrl }],
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

    // Step 1: Extract images from ZIP first. Even if PDF extraction fails,
    // the user can still submit manually with the selected product image.
    console.log('[AGENT] Step 1: Extracting ZIP images...');
    const zipResult = await extractImagesFromZip(zipFile.buffer);

    if (zipResult.totalImages === 0) {
      return res.status(400).json({
        error: 'No valid images found in the ZIP file.',
        rawText
      });
    }

    console.log(`[AGENT] ZIP images extracted: ${zipResult.totalImages} images found`);

    // Step 2: Extract text from PDF
    console.log('[AGENT] Step 2: Extracting PDF text...');
    let pdfResult = { text: '', pages: 0 };
    let rawText = '';

    try {
      pdfResult = await extractTextFromPDF(pdfFile.buffer);
      rawText = pdfResult.text || '';
    } catch (pdfErr) {
      console.error('[AGENT] PDF extraction failed:', pdfErr.message);
      return res.json({
        success: true,
        products: [],
        selectedImage: zipResult.selectedImage,
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
        selectedImage: zipResult.selectedImage,
        allImages: zipResult.images,
        rawText: rawText || '',
        totalImages: zipResult.totalImages,
        warning: 'Could not extract meaningful text from the PDF. The file may be scanned/image-based. You can manually enter product details below.'
      });
    }

    console.log(`[AGENT] PDF text extracted: ${rawText.length} chars from ${pdfResult.pages} pages`);

    // Step 3: Use DeepSeek to extract product info from PDF text
    console.log('[AGENT] Step 3: Analyzing PDF text with DeepSeek...');
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
      // Fallback: return raw text so user can manually enter info
      return res.json({
        success: true,
        products: [],
        selectedImage: zipResult.selectedImage,
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
        selectedImage: zipResult.selectedImage,
        allImages: zipResult.images,
        rawText,
        totalImages: zipResult.totalImages,
        warning: 'No product information could be extracted from the PDF. You can manually enter details below.'
      });
    }

    // Step 4: Return results
    console.log('[AGENT] Analysis complete. Returning results.');
    return res.json({
      success: true,
      products,
      selectedImage: zipResult.selectedImage,
      allImages: zipResult.images,
      rawText,
      totalImages: zipResult.totalImages
    });

  } catch (err) {
    console.error('[AGENT] Process error:', err);

    // Handle multer errors
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
      error: 'Failed to process upload',
      details: err.message
    });
  }
}
