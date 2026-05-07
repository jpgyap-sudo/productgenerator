// ═══════════════════════════════════════════════════════════════════
//  lib/pdf-extractor.js — PDF text extraction wrapper
//  Uses pdf-parse to extract text content from PDF files.
// ═══════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Dynamic import for pdf-parse (ESM compatible)
let PDFParseClass = null;

async function getPdfParse() {
  if (!PDFParseClass) {
    // pdf-parse v2+ exports PDFParse as a named export (class)
    const mod = await import('pdf-parse');
    PDFParseClass = mod.PDFParse;
  }
  return PDFParseClass;
}

/**
 * Extract text from a PDF buffer.
 *
 * @param {Buffer} pdfBuffer - The PDF file buffer
 * @param {object} [options] - Optional extraction options
 * @param {number} [options.maxPages] - Maximum pages to extract (0 = all)
 * @returns {Promise<{text: string, pages: number, metadata: object}>}
 */
export async function extractTextFromPDF(pdfBuffer, options = {}) {
  const { maxPages = 0 } = options;

  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    throw new Error('PDF buffer is required');
  }

  if (pdfBuffer.length === 0) {
    throw new Error('PDF buffer is empty');
  }

  console.log(`[PDF-EXTRACTOR] Extracting text from PDF (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

  const PDFParse = await getPdfParse();

  // pdf-parse v2+ uses a class-based API: new PDFParse({ data: buffer })
  const parser = new PDFParse({ data: pdfBuffer });

  let textResult;
  let infoResult;

  try {
    // Extract text
    textResult = await parser.getText({
      // Use pageJoiner to mark page boundaries for optional truncation
      pageJoiner: maxPages > 0 ? '\n-- PAGE_BREAK --\n' : undefined
    });

    // Extract metadata
    infoResult = await parser.getInfo();
  } finally {
    // Always clean up the parser
    await parser.destroy().catch(() => {});
  }

  let text = textResult.text || '';
  const numPages = textResult.total || 0;
  const metadata = infoResult?.info || {};

  console.log(`[PDF-EXTRACTOR] Extracted ${text.length} chars from ${numPages} pages`);

  // Limit pages if requested
  if (maxPages > 0 && numPages > maxPages) {
    const pageBreaks = text.split('-- PAGE_BREAK --');
    if (pageBreaks.length > maxPages) {
      text = pageBreaks.slice(0, maxPages).join('\n');
      console.log(`[PDF-EXTRACTOR] Truncated to ${maxPages} pages (${text.length} chars)`);
    }
  }

  // Clean up the text
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    text,
    pages: numPages,
    metadata
  };
}

/**
 * Extract text from a PDF file path.
 *
 * @param {string} filePath - Path to the PDF file
 * @param {object} [options] - Options passed to extractTextFromPDF
 * @returns {Promise<{text: string, pages: number, metadata: object}>}
 */
export async function extractTextFromPDFFile(filePath, options = {}) {
  const resolvedPath = path.resolve(filePath);
  console.log(`[PDF-EXTRACTOR] Reading PDF from: ${resolvedPath}`);

  const buffer = fs.readFileSync(resolvedPath);
  return extractTextFromPDF(buffer, options);
}
