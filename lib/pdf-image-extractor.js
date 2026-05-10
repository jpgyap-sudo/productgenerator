// ═══════════════════════════════════════════════════════════════════
//  lib/pdf-image-extractor.js — Extract images from PDF pages
//
//  Uses sharp (which has built-in PDF support via libvips) to render
//  each PDF page as a PNG image. These page images contain the product
//  photos embedded in the catalog PDF, which can then be visually
//  compared against ZIP images using GPT-4o Vision.
//
//  Usage:
//    const pages = await extractImagesFromPDF(pdfBuffer);
//    // pages[0] = { page: 1, dataUrl: "data:image/png;base64,...", width, height }
// ═══════════════════════════════════════════════════════════════════

import sharp from 'sharp';

const MAX_PAGES = 50;        // Max PDF pages to render
const RENDER_DPI = 150;      // Render DPI — 150 is good balance of quality/speed
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB max per page image

/**
 * Extract images from each page of a PDF using sharp.
 * Sharp renders PDF pages via libvips' built-in PDF support.
 *
 * @param {Buffer} pdfBuffer - The PDF file buffer
 * @param {object} [options]
 * @param {number} [options.maxPages=50] - Max pages to render
 * @param {number} [options.dpi=150] - Render resolution
 * @returns {Promise<Array<{page: number, dataUrl: string, width: number, height: number, size: number}>>}
 */
export async function extractImagesFromPDF(pdfBuffer, options = {}) {
  const maxPages = options.maxPages || MAX_PAGES;
  const dpi = options.dpi || RENDER_DPI;

  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    throw new Error('PDF buffer is required');
  }

  if (pdfBuffer.length === 0) {
    throw new Error('PDF buffer is empty');
  }

  console.log(`[PDF-IMAGE-EXTRACTOR] Rendering PDF pages as images (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB, ${dpi} DPI)`);

  const pages = [];

  try {
    // Sharp can render multi-page PDFs using the `pages` and `page` options
    // First, determine how many pages by trying to render page 1 and checking metadata
    let totalPages = 0;

    // Try to get the number of pages by reading PDF metadata
    // Sharp's PDF loader doesn't expose page count directly, so we iterate
    // until we hit an error or reach maxPages
    for (let page = 0; page < maxPages; page++) {
      try {
        const img = sharp(pdfBuffer, {
          page,           // 0-indexed page number
          density: dpi,   // Render DPI
          pages: 1        // Only render this one page
        });

        const metadata = await img.metadata();
        const buffer = await img.png().toBuffer();

        if (buffer.length > MAX_IMAGE_SIZE) {
          console.log(`[PDF-IMAGE-EXTRACTOR] Page ${page + 1} image too large (${(buffer.length / 1024 / 1024).toFixed(2)} MB), skipping`);
          continue;
        }

        if (buffer.length < 1000) {
          // Very small buffer likely means blank/empty page — stop here
          console.log(`[PDF-IMAGE-EXTRACTOR] Page ${page + 1} appears empty (${buffer.length} bytes), stopping`);
          break;
        }

        const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;

        pages.push({
          page: page + 1,
          dataUrl,
          width: metadata.width || 0,
          height: metadata.height || 0,
          size: buffer.length
        });

        totalPages = page + 1;
        console.log(`[PDF-IMAGE-EXTRACTOR] Page ${page + 1}: ${metadata.width}x${metadata.height}, ${(buffer.length / 1024).toFixed(1)} KB`);
      } catch (pageErr) {
        // If we get an error on page 0, the PDF might not be renderable
        if (page === 0) {
          console.error(`[PDF-IMAGE-EXTRACTOR] Failed to render PDF page 1: ${pageErr.message}`);
          throw new Error(`Cannot render PDF as image: ${pageErr.message}`);
        }
        // Past page 0, error likely means we've exceeded the page count
        console.log(`[PDF-IMAGE-EXTRACTOR] No more pages after page ${page} (${pageErr.message})`);
        break;
      }
    }

    console.log(`[PDF-IMAGE-EXTRACTOR] Extracted ${pages.length} page images from PDF`);
    return pages;

  } catch (err) {
    console.error(`[PDF-IMAGE-EXTRACTOR] Error: ${err.message}`);
    throw err;
  }
}

/**
 * Extract images from a PDF file path.
 *
 * @param {string} filePath - Path to the PDF file
 * @param {object} [options] - Options passed to extractImagesFromPDF
 * @returns {Promise<Array<{page: number, dataUrl: string, width: number, height: number, size: number}>>}
 */
export async function extractImagesFromPDFFile(filePath, options = {}) {
  const fs = await import('fs');
  const path = await import('path');
  const resolvedPath = path.resolve(filePath);
  console.log(`[PDF-IMAGE-EXTRACTOR] Reading PDF from: ${resolvedPath}`);

  const buffer = fs.readFileSync(resolvedPath);
  return extractImagesFromPDF(buffer, options);
}
