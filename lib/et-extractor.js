// ═══════════════════════════════════════════════════════════════════
//  lib/et-extractor.js — WPS Spreadsheet (.et) text extractor
//  Uses SheetJS (xlsx) to parse .et files (OLE2 compound document format)
//  and extract text content for AI product extraction.
//
//  .et files are Kingsoft WPS Spreadsheet files. SheetJS can parse them
//  because they use the OLE2 compound document format (same as older .xls).
// ═══════════════════════════════════════════════════════════════════

import XLSX from 'xlsx';

/**
 * Extract text content from a .et (WPS Spreadsheet) file buffer.
 * Converts all spreadsheet data into a tabular text format suitable
 * for AI extraction (similar to PDF text extraction output).
 *
 * @param {Buffer} etBuffer - The raw buffer of the .et file
 * @param {object} [options]
 * @param {number} [options.maxRows=0] - Max rows to process (0 = all)
 * @returns {Promise<{text: string, rows: number, sheets: Array<{name: string, rows: number}>}>}
 */
export async function extractTextFromET(etBuffer, options = {}) {
  const maxRows = options.maxRows || 0;

  console.log(`[ET-EXTRACTOR] Parsing .et file (${(etBuffer.length / 1024).toFixed(1)} KB)...`);

  let workbook;
  try {
    workbook = XLSX.read(etBuffer, {
      type: 'buffer',
      cellDates: false,
      cellNF: false,
      cellText: true
    });
  } catch (parseErr) {
    throw new Error(`Failed to parse .et file: ${parseErr.message}`);
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('No sheets found in .et file');
  }

  console.log(`[ET-EXTRACTOR] Found ${workbook.SheetNames.length} sheet(s): ${workbook.SheetNames.join(', ')}`);

  const sheets = [];
  let allText = '';
  let totalRows = 0;

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;

    // Convert to 2D array (header: 1 = no header mapping, raw data)
    const data = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: '',
      blankrows: false // Skip completely empty rows
    });

    if (!data || data.length === 0) continue;

    // Find the actual data range (skip leading empty rows)
    let startRow = 0;
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (row && row.some(cell => cell !== '' && cell !== null && cell !== undefined)) {
        startRow = i;
        break;
      }
    }

    const relevantData = data.slice(startRow);
    const rowLimit = maxRows > 0 ? Math.min(relevantData.length, maxRows) : relevantData.length;
    const rowsToProcess = relevantData.slice(0, rowLimit);

    // Build text representation
    let sheetText = `=== Sheet: ${sheetName} ===\n`;
    sheetText += `--- Row ${startRow + 1}: Headers ---\n`;

    for (let r = 0; r < rowsToProcess.length; r++) {
      const row = rowsToProcess[r];
      if (!row || row.every(cell => cell === '' || cell === null || cell === undefined)) {
        continue; // Skip empty rows
      }

      // Format each row as tab-separated values
      const rowNum = startRow + r + 1;
      const cells = row.map((cell, c) => {
        if (cell === null || cell === undefined) return '';
        const str = String(cell).trim();
        // Skip formula artifacts like =DISPIMG(...)
        if (str.startsWith('=') && str.includes('DISPIMG')) return '[IMAGE]';
        return str;
      });

      // Only include non-empty rows
      if (cells.some(c => c !== '' && c !== '[IMAGE]')) {
        sheetText += `Row ${rowNum}: ${cells.join(' | ')}\n`;
        totalRows++;
      }
    }

    sheetText += `\n`;
    allText += sheetText;

    sheets.push({
      name: sheetName,
      rows: totalRows
    });
  }

  console.log(`[ET-EXTRACTOR] Extracted ${totalRows} data rows from ${sheets.length} sheet(s), ${allText.length} chars`);

  return {
    text: allText,
    rows: totalRows,
    sheets
  };
}

/**
 * Quick check if a buffer appears to be a .et file.
 * .et files use the OLE2 compound document format (starts with D0 CF 11 E0 A1 B1 1A E1).
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isETFile(buffer) {
  if (!buffer || buffer.length < 8) return false;
  // OLE2 magic bytes: D0 CF 11 E0 A1 B1 1A E1
  const magic = buffer.readUInt32LE(0);
  return magic === 0xE11AB1A0 || magic === 0xE011CFD0;
}
