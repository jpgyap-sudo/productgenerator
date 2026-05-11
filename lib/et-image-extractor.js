// ═══════════════════════════════════════════════════════════════════
//  lib/et-image-extractor.js — Extract embedded images + row data
//  from .et (WPS Spreadsheet) files.
//
//  Workflow:
//    1. Convert .et → .xlsx via LibreOffice (soffice --headless)
//    2. Use exceljs to read worksheet data AND extract embedded images
//    3. Parse drawing XML to map images to cell anchors (row/col)
//    4. Return row-mapped products with image data URLs
//
//  This is an ADDITIONAL function — does NOT replace the existing
//  text-only extraction in lib/et-extractor.js.
//
//  Dependencies:
//    - LibreOffice (soffice) must be installed on the system
//    - exceljs npm package
// ═══════════════════════════════════════════════════════════════════

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import ExcelJS from 'exceljs';
import XLSX from 'xlsx';

// ── Constants ──────────────────────────────────────────────────────
const LIBREOFFICE_TIMEOUT = 60000; // 60s max for conversion
const MAX_IMAGE_SIZE_MB = 10;      // Skip images larger than this

/**
 * Check if LibreOffice is available on the system.
 * @returns {Promise<boolean>}
 */
export async function isLibreOfficeAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('soffice', ['--headless', '--version'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Convert a .et buffer to .xlsx using LibreOffice.
 * Writes temp files, runs soffice, reads result, cleans up.
 *
 * @param {Buffer} etBuffer - Raw .et file buffer
 * @param {string} tempDir - Temporary directory for conversion
 * @returns {Promise<Buffer>} The converted .xlsx buffer
 */
async function convertETtoXLSX(etBuffer, tempDir) {
  const timestamp = Date.now();
  const inputPath = path.join(tempDir, `input_${timestamp}.et`);
  const outputPath = path.join(tempDir, `input_${timestamp}.xlsx`);

  // Write .et to temp file
  await fs.promises.writeFile(inputPath, etBuffer);

  return new Promise((resolve, reject) => {
    const soffice = spawn('soffice', [
      '--headless',
      '--convert-to', 'xlsx',
      '--outdir', tempDir,
      inputPath
    ], {
      timeout: LIBREOFFICE_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    soffice.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    soffice.on('close', async (code) => {
      // Clean up input .et file
      try { await fs.promises.unlink(inputPath); } catch {}

      if (code !== 0) {
        // Clean up output if it exists
        try { await fs.promises.unlink(outputPath); } catch {}
        return reject(new Error(`LibreOffice conversion failed (exit ${code}): ${stderr.trim() || 'Unknown error'}`));
      }

      try {
        const xlsxBuffer = await fs.promises.readFile(outputPath);
        // Clean up output file
        try { await fs.promises.unlink(outputPath); } catch {}
        resolve(xlsxBuffer);
      } catch (readErr) {
        reject(new Error(`Failed to read converted .xlsx: ${readErr.message}`));
      }
    });

    soffice.on('error', (err) => {
      // Clean up temp files
      try { fs.promises.unlink(inputPath); } catch {}
      try { fs.promises.unlink(outputPath); } catch {}
      reject(new Error(`LibreOffice not found: ${err.message}. Install LibreOffice to extract images from .et files.`));
    });
  });
}

/**
 * Extract images and cell-anchor mapping from a .xlsx buffer using exceljs.
 *
 * @param {Buffer} xlsxBuffer - Converted .xlsx file buffer
 * @returns {Promise<{images: Array, rowImageMap: Map<number, object>, imageNameMap: Map<string, object>}>}
 *   images: Array of { id, index, buffer, extension, mimeType, name }
 *   rowImageMap: Map<rowNumber, imageObject> — images mapped by anchor row
 *   imageNameMap: Map<imageName, imageObject> — images mapped by name for DISPIMG lookup
 */
async function extractImagesFromXLSX(xlsxBuffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsxBuffer);

  // ── Collect all embedded images from workbook media ──────────────
  // exceljs stores media in workbook.media (array of { buffer, extension, type, name })
  const mediaList = [];
  if (workbook.media && workbook.media.length > 0) {
    workbook.media.forEach((medium, index) => {
      if (!medium.buffer) return;
      // Skip oversized images
      if (medium.buffer.length > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
        console.log(`[ET-IMAGE-EXTRACTOR] Skipping oversized image #${index}: ${(medium.buffer.length / 1024 / 1024).toFixed(1)} MB`);
        return;
      }
      const ext = medium.extension || 'png';
      const mimeType = ext === 'jpg' ? 'image/jpeg'
        : ext === 'jpeg' ? 'image/jpeg'
        : ext === 'png' ? 'image/png'
        : ext === 'gif' ? 'image/gif'
        : ext === 'bmp' ? 'image/bmp'
        : `image/${ext}`;
      mediaList.push({
        id: medium.index ?? index,
        index,
        buffer: medium.buffer,
        extension: ext,
        mimeType,
        name: medium.name || `image_${index}.${ext}`
      });
    });
  }

  if (mediaList.length === 0) {
    return { images: [], rowImageMap: new Map(), imageNameMap: new Map() };
  }

  console.log(`[ET-IMAGE-EXTRACTOR] Found ${mediaList.length} embedded images in workbook`);

  // ── Build imageNameMap: map image name → image object ───────────
  // WPS spreadsheets reference images by name via DISPIMG() formulas
  const imageNameMap = new Map();
  for (const media of mediaList) {
    // The name might be like "image1", "image2", etc. or have an extension
    const baseName = media.name.replace(/\.[^.]+$/, ''); // Strip extension
    imageNameMap.set(media.name, media);
    imageNameMap.set(baseName, media);
    // Also store by index as fallback
    imageNameMap.set(String(media.index), media);
    imageNameMap.set(String(media.id), media);
  }

  // ── Parse drawing XML to map images to cell anchors ──────────────
  // exceljs provides worksheet.getImages() which returns image placement info
  // Each image entry has: { imageId, range: { tl: { row, col }, br: { row, col } }, type }
  const rowImageMap = new Map();

  const worksheet = workbook.getWorksheet(1);
  if (!worksheet) {
    console.warn('[ET-IMAGE-EXTRACTOR] No worksheet found in workbook');
    return { images: mediaList, rowImageMap, imageNameMap };
  }

  try {
    const drawingImages = worksheet.getImages();
    console.log(`[ET-IMAGE-EXTRACTOR] Found ${drawingImages.length} image placements in drawings`);

    drawingImages.forEach((imgPlacement) => {
      // imgPlacement.imageId refers to the index in workbook.media
      const mediaIndex = imgPlacement.imageId;
      const media = mediaList.find(m => m.id === mediaIndex || m.index === mediaIndex);
      if (!media) {
        console.warn(`[ET-IMAGE-EXTRACTOR] No media found for imageId ${mediaIndex}`);
        return;
      }

      // Get the top-left cell anchor (row is 0-based in exceljs)
      const tl = imgPlacement.range?.tl;
      if (!tl || tl.row === undefined) {
        console.warn(`[ET-IMAGE-EXTRACTOR] Image #${mediaIndex} has no cell anchor, skipping`);
        return;
      }

      // exceljs uses 0-based row/col; spreadsheet rows are 1-based
      // IMPORTANT: Anchor rows can be floats (e.g., 338.99999), so round them
      const spreadsheetRow = Math.round(tl.row) + 1; // Round first, then convert to 1-based

      // If multiple images map to the same row, keep the first one
      if (!rowImageMap.has(spreadsheetRow)) {
        rowImageMap.set(spreadsheetRow, media);
        console.log(`[ET-IMAGE-EXTRACTOR] Mapped image #${mediaIndex} "${media.name}" to row ${spreadsheetRow} (raw tl.row=${tl.row})`);
      }
    });
  } catch (drawErr) {
    // getImages() may fail on some .xlsx files — non-fatal
    console.warn('[ET-IMAGE-EXTRACTOR] Drawing parsing failed (non-fatal):', drawErr.message);
  }

  return { images: mediaList, rowImageMap, imageNameMap };
}

/**
 * Extract plain text from a cell value that may be a rich text object.
 * SheetJS sometimes returns { richText: [{ font: ..., text: "..." }, ...] }
 * instead of a plain string.
 *
 * @param {any} cellValue - Raw cell value from SheetJS
 * @returns {string} Plain text
 */
function extractCellText(cellValue) {
  if (cellValue === null || cellValue === undefined) return '';
  if (typeof cellValue === 'string') return cellValue.trim();
  if (typeof cellValue === 'number') return String(cellValue);
  if (typeof cellValue === 'boolean') return String(cellValue);

  // Handle rich text objects: { richText: [{ text: "HA-790\n" }, { text: "锌合金脚" }] }
  if (typeof cellValue === 'object' && cellValue !== null) {
    if (Array.isArray(cellValue.richText)) {
      return cellValue.richText
        .map(rt => (rt.text || ''))
        .join('')
        .trim();
    }
    // Handle other object types
    if (cellValue.text !== undefined) return String(cellValue.text).trim();
    if (cellValue.h !== undefined) return String(cellValue.h).trim();
  }

  return String(cellValue).trim();
}

/**
 * Extract product data from worksheet rows and map images to them.
 * Uses a two-pass approach:
 *   Pass 1: Scan all cells for DISPIMG() formula references to build image-to-row mapping
 *   Pass 2: Parse data rows and map images
 *
 * @param {Buffer} xlsxBuffer - Converted .xlsx file buffer
 * @param {Map<number, object>} rowImageMap - Map of rowNumber -> image object (from drawing anchors)
 * @param {Map<string, object>} imageNameMap - Map of imageName -> image object (for DISPIMG lookup)
 * @returns {Array<object>} Array of { row, productCode, name, description, brand, generatedCode, imageBuffer, imageName, dataUrl }
 */
function extractProductsFromRows(xlsxBuffer, rowImageMap, imageNameMap) {
  // Use SheetJS (xlsx) for reliable row data parsing
  // We re-parse the xlsx buffer rather than using exceljs for data,
  // because SheetJS handles cell formatting and text extraction better
  const workbook = XLSX.read(xlsxBuffer, {
    type: 'buffer',
    cellDates: false,
    cellNF: false,
    cellText: true,
    cellFormula: true  // Keep formulas so we can detect DISPIMG()
  });

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    return [];
  }

  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) return [];

  // ── Pass 1: Scan all cells for DISPIMG() formula references ─────
  // WPS spreadsheets use =DISPIMG("image_name", ...) to reference images
  // The formula is in a cell, and the image name tells us which image to use
  const dispimgMap = new Map(); // Map<rowNumber, imageName>
  const cellAddresses = Object.keys(worksheet);
  for (const addr of cellAddresses) {
    if (addr.startsWith('!')) continue; // Skip sheet-level keys
    const cell = worksheet[addr];
    if (!cell) continue;

    // Check for DISPIMG formula
    let formulaStr = '';
    if (cell.f && typeof cell.f === 'string') {
      formulaStr = cell.f;
    }
    // Also check the raw value (SheetJS may store formula result differently)
    if (cell.l && typeof cell.l === 'object' && cell.l.Target) {
      // Hyperlink - not what we want
    }

    if (formulaStr.toUpperCase().includes('DISPIMG')) {
      // Extract the image name from DISPIMG("name", ...)
      // Pattern: =DISPIMG("image_name", ...) or =DISPIMG('image_name', ...)
      const match = formulaStr.match(/DISPIMG\s*\(\s*["']([^"']+)["']/i);
      if (match && match[1]) {
        const imageName = match[1].trim();
        // Parse the cell address to get row number
        const colRow = addr.match(/[A-Z]+(\d+)/);
        if (colRow && colRow[1]) {
          const rowNum = parseInt(colRow[1], 10);
          dispimgMap.set(rowNum, imageName);
          console.log(`[ET-IMAGE-EXTRACTOR] DISPIMG reference: cell ${addr} (row ${rowNum}) → image "${imageName}"`);
        }
      }
    }
  }

  if (dispimgMap.size > 0) {
    console.log(`[ET-IMAGE-EXTRACTOR] Found ${dispimgMap.size} DISPIMG formula references`);
  }

  // ── Convert to 2D array (header: 1 = raw data, no header mapping) ─
  const data = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    blankrows: false
  });

  if (!data || data.length < 2) return []; // Need at least header + 1 data row

  // ── Find column indices by header names ──────────────────────────
  const headers = data[0].map(h => extractCellText(h).toLowerCase());

  // Try to find relevant columns (flexible matching)
  const findCol = (keywords) => {
    for (let i = 0; i < headers.length; i++) {
      for (const kw of keywords) {
        if (headers[i].includes(kw)) return i;
      }
    }
    return -1;
  };

  let codeCol = findCol(['code', 'product code', 'item code', 'sku', 'no', 'part number']);
  let descCol = findCol(['description', 'desc', 'product description', 'item description', 'name', 'product name']);
  let brandCol = findCol(['brand', 'brand name', 'manufacturer', 'vendor']);
  let imageCol = findCol(['image', 'img', 'picture', 'photo', 'pic']);

  // ── Fallback: if keyword search fails, use positional heuristics ─
  // Many .et files have empty headers for columns 0 and 2 (code and description)
  if (codeCol === -1 && headers.length > 0 && headers[0] === '') {
    codeCol = 0;
    console.log('[ET-IMAGE-EXTRACTOR] Column fallback: using col 0 for product code (empty header)');
  }
  if (descCol === -1 && headers.length > 2 && headers[2] === '') {
    descCol = 2;
    console.log('[ET-IMAGE-EXTRACTOR] Column fallback: using col 2 for description (empty header)');
  }
  // If still not found, try broader fallback
  if (codeCol === -1 && headers.length > 0) {
    // Check if first column has any data that looks like product codes
    const sampleValues = [];
    for (let i = 1; i < Math.min(6, data.length); i++) {
      const row = data[i];
      if (row && row[0] !== '' && row[0] !== null && row[0] !== undefined) {
        sampleValues.push(extractCellText(row[0]));
      }
    }
    if (sampleValues.length > 0) {
      codeCol = 0;
      console.log('[ET-IMAGE-EXTRACTOR] Column fallback: using col 0 for product code (heuristic)');
    }
  }
  if (descCol === -1 && headers.length > 2) {
    const sampleValues = [];
    for (let i = 1; i < Math.min(6, data.length); i++) {
      const row = data[i];
      if (row && row[2] !== '' && row[2] !== null && row[2] !== undefined) {
        sampleValues.push(extractCellText(row[2]));
      }
    }
    if (sampleValues.length > 0) {
      descCol = 2;
      console.log('[ET-IMAGE-EXTRACTOR] Column fallback: using col 2 for description (heuristic)');
    }
  }

  console.log(`[ET-IMAGE-EXTRACTOR] Column mapping: code=${codeCol}, desc=${descCol}, brand=${brandCol}, image=${imageCol}`);

  // ── Build positional image mapping ───────────────────────────────
  // After LibreOffice conversion, DISPIMG formula UUIDs don't match
  // the generic media names (image1-image4). We need to map images
  // to products by position: sort DISPIMG rows by row number, sort
  // images by anchor row, and map them in order.
  //
  // Strategy:
  //   1. Get all DISPIMG rows sorted ascending
  //   2. Get all images sorted by their anchor row ascending
  //   3. Map first N images to first N DISPIMG rows in order
  //   4. Also keep drawing anchor lookup as fallback
  const sortedDispimgRows = [...dispimgMap.keys()].sort((a, b) => a - b);
  const sortedImages = [...rowImageMap.entries()]
    .sort(([rowA], [rowB]) => rowA - rowB)
    .map(([, img]) => img);

  console.log(`[ET-IMAGE-EXTRACTOR] Positional mapping: ${sortedImages.length} images to map to DISPIMG rows`);
  if (sortedImages.length > 0) {
    console.log(`[ET-IMAGE-EXTRACTOR] First DISPIMG rows: ${sortedDispimgRows.slice(0, 5).join(', ')}`);
    console.log(`[ET-IMAGE-EXTRACTOR] Image anchor rows: ${[...rowImageMap.keys()].sort((a,b)=>a-b).join(', ')}`);
  }

  // Build a positional map: DISPIMG row index → image
  const positionalImageMap = new Map();
  for (let i = 0; i < sortedImages.length && i < sortedDispimgRows.length; i++) {
    positionalImageMap.set(sortedDispimgRows[i], sortedImages[i]);
    console.log(`[ET-IMAGE-EXTRACTOR] Positional map: DISPIMG row ${sortedDispimgRows[i]} → image "${sortedImages[i].name}"`);
  }

  // ── Process data rows ────────────────────────────────────────────
  const products = [];
  const seenCodes = new Set(); // For deduplication of merged cells

  // Find the actual data start (skip empty rows after header)
  let startRow = 1;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row && row.some(cell => cell !== '' && cell !== null && cell !== undefined)) {
      startRow = i;
      break;
    }
  }

  for (let r = startRow; r < data.length; r++) {
    const row = data[r];
    if (!row) continue;

    // Skip completely empty rows
    if (row.every(cell => cell === '' || cell === null || cell === undefined)) continue;

    // Extract cell values using rich-text-aware extraction
    const getCell = (colIdx) => {
      if (colIdx < 0 || colIdx >= row.length) return '';
      const val = row[colIdx];
      if (val === null || val === undefined) return '';
      const str = extractCellText(val);
      // Skip formula artifacts
      if (str.startsWith('=') && str.includes('DISPIMG')) return '';
      return str;
    };

    const productCode = getCell(codeCol);
    const description = getCell(descCol);
    const brand = getCell(brandCol);

    // Skip rows with no meaningful product data
    if (!productCode && !description) continue;

    // Deduplicate: skip if we've seen this product code before (merged cells)
    if (productCode && seenCodes.has(productCode)) continue;
    if (productCode) seenCodes.add(productCode);

    // The spreadsheet row number (1-based, accounting for header row 0)
    const spreadsheetRow = r + 1;

    // ── Image mapping strategy (tiered) ────────────────────────────
    // Tier 1: Positional mapping (DISPIMG row index → image order)
    // Tier 2: Drawing anchor lookup
    let rowImage = null;

    // Tier 1: Positional mapping
    // After LibreOffice conversion, DISPIMG UUIDs become generic image1-image4.
    // The order of DISPIMG rows matches the order of images by anchor row.
    if (positionalImageMap.has(spreadsheetRow)) {
      rowImage = positionalImageMap.get(spreadsheetRow);
      if (rowImage) {
        console.log(`[ET-IMAGE-EXTRACTOR] Row ${spreadsheetRow}: matched via positional mapping → "${rowImage.name}"`);
      }
    }

    // Tier 2: Drawing anchor
    if (!rowImage) {
      rowImage = rowImageMap.get(spreadsheetRow);
      if (rowImage) {
        console.log(`[ET-IMAGE-EXTRACTOR] Row ${spreadsheetRow}: matched via drawing anchor → "${rowImage.name}"`);
      }
    }

    // Generate dataUrl if image exists
    let dataUrl = '';
    if (rowImage && rowImage.buffer) {
      dataUrl = `data:${rowImage.mimeType};base64,${rowImage.buffer.toString('base64')}`;
    }

    // Generate product name from description or code
    const name = description
      ? (description.length > 60 ? description.substring(0, 60) + '...' : description)
      : (productCode ? `Product ${productCode}` : `Row ${spreadsheetRow}`);

    products.push({
      row: spreadsheetRow,
      productCode: productCode || '',
      name,
      description: description || '',
      brand: brand || '',
      generatedCode: productCode ? `HA${productCode}R` : '',
      // Image data (only present if image was found for this row)
      imageBuffer: rowImage?.buffer || null,
      imageName: rowImage?.name || '',
      dataUrl: dataUrl || '',
      // Flag to indicate this product has a pre-mapped image
      hasPreMappedImage: !!rowImage
    });
  }

  console.log(`[ET-IMAGE-EXTRACTOR] Extracted ${products.length} products with data`);
  const withImages = products.filter(p => p.hasPreMappedImage).length;
  console.log(`[ET-IMAGE-EXTRACTOR] ${withImages}/${products.length} products have pre-mapped images`);

  return products;
}

/**
 * Report progress via the onProgress callback.
 * @param {function|null} onProgress
 * @param {number} percent - 0-100
 * @param {string} stage - Current stage name
 * @param {string} [detail] - Optional detail message
 */
function reportProgress(onProgress, percent, stage, detail) {
  if (typeof onProgress === 'function') {
    try {
      onProgress({ percent, stage, detail: detail || '' });
    } catch {}
  }
  console.log(`[ET-IMAGE-EXTRACTOR] Progress: ${percent}% — ${stage}${detail ? ': ' + detail : ''}`);
}

/**
 * Save resume state to a temp file so extraction can be resumed if interrupted.
 * @param {string} tempDir
 * @param {object} state - Resume state object
 */
async function saveResumeState(tempDir, state) {
  const statePath = path.join(tempDir, 'resume-state.json');
  try {
    await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2));
  } catch {}
}

/**
 * Load resume state from temp file.
 * @param {string} tempDir
 * @returns {object|null}
 */
async function loadResumeState(tempDir) {
  const statePath = path.join(tempDir, 'resume-state.json');
  try {
    const data = await fs.promises.readFile(statePath, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Clear resume state file.
 * @param {string} tempDir
 */
async function clearResumeState(tempDir) {
  const statePath = path.join(tempDir, 'resume-state.json');
  try {
    await fs.promises.unlink(statePath);
  } catch {}
}

/**
 * Main entry point: Extract embedded images and row data from a .et file.
 *
 * Workflow:
 *   1. Check LibreOffice availability
 *   2. Convert .et → .xlsx via soffice (with retry)
 *   3. Extract images + cell anchors via exceljs
 *   4. Extract product data from rows via SheetJS
 *   5. Merge images with row data
 *   6. Return format compatible with existing pipeline
 *
 * Supports progress reporting via onProgress callback and resume fallback
 * via resume state saved to temp directory.
 *
 * @param {Buffer} etBuffer - Raw .et file buffer
 * @param {object} [options]
 * @param {string} [options.tempDir] - Custom temp directory (default: os.tmpdir())
 * @param {function} [options.onProgress] - Progress callback ({ percent, stage, detail })
 * @param {boolean} [options.useResume] - Whether to try resuming from saved state (default: true)
 * @returns {Promise<{products: Array, allImages: Array, totalImages: number, hasEmbeddedImages: boolean}>}
 */
export async function extractETImagesAndData(etBuffer, options = {}) {
  const onProgress = options.onProgress || null;
  const useResume = options.useResume !== false; // Default: true
  const fileSizeMB = (etBuffer.length / 1024 / 1024).toFixed(2);

  console.log(`[ET-IMAGE-EXTRACTOR] Starting extraction (${fileSizeMB} MB)`);
  reportProgress(onProgress, 0, 'Initializing', `File size: ${fileSizeMB} MB`);

  // ── Step 1: Check LibreOffice ────────────────────────────────────
  reportProgress(onProgress, 5, 'Checking LibreOffice');
  const libreAvailable = await isLibreOfficeAvailable();
  if (!libreAvailable) {
    console.warn('[ET-IMAGE-EXTRACTOR] LibreOffice not available — cannot extract embedded images');
    reportProgress(onProgress, 100, 'Failed', 'LibreOffice not installed');
    return {
      products: [],
      allImages: [],
      totalImages: 0,
      hasEmbeddedImages: false,
      warning: 'LibreOffice is not installed. Install LibreOffice to extract embedded images from .et files.'
    };
  }

  // ── Step 2: Create temp directory ────────────────────────────────
  reportProgress(onProgress, 10, 'Preparing temp directory');
  const tempDir = options.tempDir || path.join(os.tmpdir(), 'et-extract');
  try {
    await fs.promises.mkdir(tempDir, { recursive: true });
  } catch {}

  // Check for resume state
  let resumeState = null;
  if (useResume) {
    resumeState = await loadResumeState(tempDir);
    if (resumeState) {
      console.log(`[ET-IMAGE-EXTRACTOR] Found resume state from previous run (step: ${resumeState.step || 'unknown'})`);
      reportProgress(onProgress, 10, 'Resuming', `Previous step: ${resumeState.step || 'unknown'}`);
    }
  }

  // ── Step 3: Convert .et → .xlsx (with retry) ─────────────────────
  reportProgress(onProgress, 15, 'Converting .et to .xlsx', 'Running LibreOffice...');
  let xlsxBuffer;

  // Save resume state before conversion
  await saveResumeState(tempDir, { step: 'converting', timestamp: Date.now() });

  // Try conversion with up to 2 retries
  const MAX_CONV_RETRIES = 2;
  let convErr = null;
  for (let attempt = 0; attempt <= MAX_CONV_RETRIES; attempt++) {
    if (attempt > 0) {
      const waitSec = attempt * 3;
      console.log(`[ET-IMAGE-EXTRACTOR] Conversion retry ${attempt}/${MAX_CONV_RETRIES} after ${waitSec}s delay...`);
      reportProgress(onProgress, 15, 'Retrying conversion', `Attempt ${attempt}/${MAX_CONV_RETRIES}`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }
    try {
      xlsxBuffer = await convertETtoXLSX(etBuffer, tempDir);
      convErr = null;
      break; // Success
    } catch (err) {
      convErr = err;
      console.warn(`[ET-IMAGE-EXTRACTOR] Conversion attempt ${attempt + 1} failed:`, err.message);
    }
  }

  if (convErr) {
    console.error('[ET-IMAGE-EXTRACTOR] All conversion attempts failed:', convErr.message);
    await clearResumeState(tempDir);
    reportProgress(onProgress, 100, 'Failed', `Conversion error: ${convErr.message}`);
    return {
      products: [],
      allImages: [],
      totalImages: 0,
      hasEmbeddedImages: false,
      warning: `LibreOffice conversion failed after ${MAX_CONV_RETRIES + 1} attempts: ${convErr.message}.`
    };
  }

  console.log(`[ET-IMAGE-EXTRACTOR] Conversion successful (${(xlsxBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
  reportProgress(onProgress, 40, 'Converting .et to .xlsx', 'Done');

  // Save resume state after conversion
  await saveResumeState(tempDir, { step: 'extracting_images', timestamp: Date.now() });

  // ── Step 4: Extract images + cell anchors ────────────────────────
  reportProgress(onProgress, 45, 'Extracting embedded images', 'Parsing workbook media...');
  const { images, rowImageMap, imageNameMap } = await extractImagesFromXLSX(xlsxBuffer);

  if (images.length === 0) {
    console.log('[ET-IMAGE-EXTRACTOR] No embedded images found in .et file');
    await clearResumeState(tempDir);
    reportProgress(onProgress, 100, 'Failed', 'No embedded images found');
    return {
      products: [],
      allImages: [],
      totalImages: 0,
      hasEmbeddedImages: false,
      warning: 'No embedded images found in the .et file.'
    };
  }

  reportProgress(onProgress, 60, 'Extracting embedded images', `${images.length} images found`);

  // Save resume state after image extraction
  await saveResumeState(tempDir, { step: 'extracting_products', timestamp: Date.now(), imageCount: images.length });

  // ── Step 5: Extract products from rows ───────────────────────────
  reportProgress(onProgress, 65, 'Extracting product data', 'Parsing spreadsheet rows...');
  const products = extractProductsFromRows(xlsxBuffer, rowImageMap, imageNameMap);
  reportProgress(onProgress, 80, 'Extracting product data', `${products.length} products found`);

  // ── Step 6: Build allImages array (compatible with existing format) ──
  reportProgress(onProgress, 85, 'Building image data URLs', `${images.length} images`);
  const allImages = images.map((img, idx) => {
    const dataUrl = `data:${img.mimeType};base64,${img.buffer.toString('base64')}`;
    return {
      name: img.name || `embedded_image_${idx}.${img.extension}`,
      dataUrl,
      width: 0,   // Not available from exceljs
      height: 0,  // Not available from exceljs
      size: img.buffer.length,
      galleryUrl: '',
      isEmbedded: true,
      imageIndex: idx
    };
  });

  // ── Step 7: Finalize ─────────────────────────────────────────────
  // Clear resume state on success
  await clearResumeState(tempDir);

  const withImages = products.filter(p => p.hasPreMappedImage).length;
  console.log(`[ET-IMAGE-EXTRACTOR] Extraction complete: ${products.length} products, ${allImages.length} images (${withImages} with pre-mapped images)`);
  reportProgress(onProgress, 100, 'Complete', `${products.length} products, ${allImages.length} images`);

  return {
    products,
    allImages,
    totalImages: allImages.length,
    hasEmbeddedImages: true
  };
}

/**
 * Quick check if a buffer appears to be a .et file (re-exported for convenience).
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isETFile(buffer) {
  if (!buffer || buffer.length < 8) return false;
  const magic = buffer.readUInt32LE(0);
  return magic === 0xE11AB1A0 || magic === 0xE011CFD0;
}
