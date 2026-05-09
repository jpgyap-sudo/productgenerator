// ═══════════════════════════════════════════════════════════════════
//  lib/deepseek.js — DeepSeek API client for AI-powered extraction
//  Used by the Uploading Agent to extract product info from PDF text.
// ═══════════════════════════════════════════════════════════════════

const DEEPSEEK_API_BASE = 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL = 'deepseek-chat'; // Fast, handles Chinese natively
const MAX_TOKENS = 4096; // Smaller per-batch token limit for faster responses
const TEMPERATURE = 0.1; // Low temp for structured extraction
const BATCH_SIZE = 4000; // Characters per chunk — process ~10 products at a time
const CONCURRENT_BATCHES = 3; // Process up to 3 chunks concurrently

/**
 * Extract structured product information from PDF text using DeepSeek.
 * Automatically splits large catalogs into batches for faster, more reliable processing.
 *
 * @param {string} pdfText - Raw text extracted from PDF
 * @returns {Promise<Array<{name: string, brand: string, description: string, category: string, productCode: string}>>}
 */
export async function extractProductInfo(pdfText) {
  // For small texts, process in one shot
  if (pdfText.length <= BATCH_SIZE) {
    return extractProductInfoBatch(pdfText, 1, 1);
  }

  // Split into chunks by newlines (preserving product boundaries)
  const chunks = splitIntoChunks(pdfText, BATCH_SIZE);
  console.log(`[DEEPSEEK] Splitting ${pdfText.length} chars into ${chunks.length} batches (~${BATCH_SIZE} chars each)`);

  // Process chunks concurrently (up to CONCURRENT_BATCHES at a time)
  const allProducts = [];
  for (let i = 0; i < chunks.length; i += CONCURRENT_BATCHES) {
    const batch = chunks.slice(i, i + CONCURRENT_BATCHES);
    const results = await Promise.allSettled(
      batch.map((chunk, idx) =>
        extractProductInfoBatch(chunk, i + idx + 1, chunks.length)
      )
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.length > 0) {
        allProducts.push(...result.value);
      } else if (result.status === 'rejected') {
        console.error(`[DEEPSEEK] Batch failed: ${result.reason?.message}`);
      }
    }
  }

  // Deduplicate by productCode (keep first occurrence)
  const seen = new Set();
  const deduped = allProducts.filter(p => {
    const key = p.productCode || p.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[DEEPSEEK] Total: ${deduped.length} unique products from ${chunks.length} batches`);
  return deduped;
}

/**
 * Split PDF text into chunks at natural boundaries (newlines).
 * Prepends column headers to every chunk after the first so each batch
 * knows what columns like "型号" (model number) mean.
 */
function splitIntoChunks(text, maxSize) {
  const lines = text.split('\n');
  const chunks = [];
  let current = '';

  // Extract column headers (first ~15 lines that contain Chinese column names)
  // These contain "型号", "产品图片", "材质说明" etc. — critical context for extraction
  let headerBlock = '';
  const headerLines = [];
  for (const line of lines) {
    headerLines.push(line);
    if (headerLines.length >= 15) break;
  }
  headerBlock = headerLines.join('\n');

  for (const line of lines) {
    // If adding this line would exceed maxSize, start a new chunk
    if (current.length + line.length + 1 > maxSize && current.length > 0) {
      chunks.push(current.trim());
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }

  // If splitting produced nothing useful, fall back to simple character split
  if (chunks.length === 0 || (chunks.length === 1 && chunks[0].length === text.length)) {
    // Simple character-based split
    for (let i = 0; i < text.length; i += maxSize) {
      chunks.push(text.slice(i, i + maxSize));
    }
  }

  // Prepend column headers to every chunk EXCEPT the first one (which already has them)
  // This ensures each batch knows what the columns mean
  for (let i = 1; i < chunks.length; i++) {
    chunks[i] = headerBlock + '\n... (continued) ...\n' + chunks[i];
  }

  return chunks;
}

/**
 * Extract products from a single batch of PDF text.
 */
async function extractProductInfoBatch(pdfText, batchNum, totalBatches) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY environment variable not set');
  }

  // Pre-scan the text for product code patterns using regex
  // This catches codes like CH-790, HA-005, P01-01 etc. that appear on their own line
  const detectedCodes = scanForProductCodes(pdfText);
  const codeHint = detectedCodes.length > 0
    ? `\n\nIMPORTANT HINT: The following product codes were detected in this batch text via pattern scanning: ${detectedCodes.join(', ')}. Make sure each product's "productCode" field matches one of these codes exactly.`
    : '';

  const systemPrompt = `You are an expert product catalog analyzer. Extract structured product information from PDF text that may contain mixed English and Chinese content.

This is a BATCH of a larger catalog. Extract ALL products visible in this batch.

Your task:
1. Identify ALL products described in the text
2. Extract the product name (in English if available)
3. Extract the brand/manufacturer name (in English if available)
4. Extract the product code/model number — this is CRITICAL. Look for:
   - Short alphanumeric codes like CH-005, HA-790, HC-001, P01-01, etc.
   - Codes usually appear near the product name, in a "型号" (model) column, or as a reference number
   - Look for patterns like "xxx-xxx" or "xxx xxx" that appear before product names
   - Extract the EXACT code as it appears in the catalog
5. Create a detailed product description suitable for AI image generation
6. Determine the product category

CRITICAL RULES for productCode:
- If the catalog has a "型号" (model number) column, use that value EXACTLY
- If a line contains ONLY a code like "CH-790" with no other text, that IS the product code for the next product
- NEVER leave productCode empty if a code exists in the text
- If truly no code exists, use a sequential code like "P001", "P002" based on product order
- The productCode is used to MATCH products to image filenames, so it MUST be accurate${codeHint}

For the description, include:
- Furniture type (chair, sofa, table, bed, cabinet, etc.)
- Style (modern, classic, luxury, minimalist, etc.)
- Materials (wood type, fabric, leather, metal finish)
- Colors and finishes
- Key design features and dimensions
- Any Chinese text that describes the product (translate key details)

IMPORTANT: Filter out irrelevant content like pricing, shipping info, contact details, terms & conditions, page numbers, headers/footers.

Return ONLY a valid JSON object with a "products" array. No markdown, no code fences, no explanations:
{
  "products": [
    {
      "name": "Chair",
      "brand": "Minotti",
      "productCode": "CH-790",
      "generatedCode": "CH-790",
      "description": "Detailed product description for AI image generation...",
      "category": "chair"
    }
  ]
}

If no valid product information is found, return {"products": []}.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Extract product information from this PDF catalog text:\n\n${pdfText}` }
  ];

  const requestBody = {
    model: DEEPSEEK_MODEL,
    messages,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    response_format: { type: 'json_object' }
  };

  console.log(`[DEEPSEEK] Batch ${batchNum}/${totalBatches} — sending extraction request (${pdfText.length} chars)...`);

  const res = await fetch(`${DEEPSEEK_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error('[DEEPSEEK] API error:', res.status, errorText);
    throw new Error(`DeepSeek API error ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    console.error('[DEEPSEEK] Empty response:', JSON.stringify(data));
    throw new Error('DeepSeek returned empty response');
  }

  console.log(`[DEEPSEEK] Batch ${batchNum}/${totalBatches} — response received (${content.length} chars)`);

  // Parse the JSON response
  // DeepSeek may return JSON with markdown code fences, trailing text, or truncated JSON
  try {
    const parsed = robustParseJSON(content);
    let products;

    if (Array.isArray(parsed)) {
      // Response is a bare array
      products = parsed;
    } else if (parsed.products && Array.isArray(parsed.products)) {
      // Response is { products: [...] }
      products = parsed.products;
    } else {
      // Single object — wrap in array
      products = [parsed];
    }

    // Validate and normalize
    const normalized = products.map((p, i) => ({
      name: p.name || `Product ${i + 1}`,
      brand: p.brand || '',
      productCode: p.productCode || '',
      description: p.description || '',
      category: p.category || 'other'
    }));

    // POST-PROCESSING: Inject regex-detected codes into products that have no productCode
    // DeepSeek often misses product codes in Chinese catalogs, but our regex scanner
    // reliably finds them. We assign codes in order to products that lack them.
    if (detectedCodes.length > 0) {
      let codeIdx = 0;
      for (const prod of normalized) {
        if (!prod.productCode && codeIdx < detectedCodes.length) {
          prod.productCode = detectedCodes[codeIdx];
          codeIdx++;
        }
      }
      if (codeIdx > 0) {
        console.log(`[DEEPSEEK] Injected ${codeIdx} product codes via regex post-processing`);
      }
    }

    return normalized;
  } catch (parseErr) {
    console.error('[DEEPSEEK] Failed to parse response:', content.substring(0, 500));
    throw new Error('Failed to parse DeepSeek response as JSON');
  }
}

/**
 * Robust JSON parser that handles:
 * - Markdown code fences (```json ... ```)
 * - Truncated JSON (missing closing braces/brackets)
 * - Trailing text after JSON
 * - Truncated string values (e.g. "category" without closing quote)
 * - Extra closing braces/brackets
 *
 * @param {string} content - Raw response content
 * @returns {object|Array} Parsed JSON
 */
function robustParseJSON(content) {
  if (!content) throw new Error('Empty content');

  let clean = content.trim();

  // 1. Strip markdown code fences
  const fenceMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    clean = fenceMatch[1].trim();
  }

  // 2. Try direct parse first
  try {
    return JSON.parse(clean);
  } catch {}

  // 3. Find the outermost JSON object/array boundaries
  const firstBrace = clean.indexOf('{');
  const firstBracket = clean.indexOf('[');
  let start = -1;
  let isObject = true;

  if (firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)) {
    start = firstBrace;
    isObject = true;
  } else if (firstBracket >= 0) {
    start = firstBracket;
    isObject = false;
  }

  if (start < 0) throw new Error('No JSON structure found');

  // 4. Extract from start position, then try to find the matching end
  const jsonStr = clean.substring(start);

  // 5. Try progressive truncation: remove trailing chars until valid JSON
  // This handles truncated string values like "category
  const openDelim = isObject ? '{' : '[';
  const closeDelim = isObject ? '}' : ']';

  // Walk backwards from the end, trying to parse
  for (let end = jsonStr.length; end > start + 1; end--) {
    const candidate = jsonStr.substring(0, end);
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  // 6. Try brace/bracket counting repair
  try {
    const openBraces = (jsonStr.match(/\{/g) || []).length;
    const closeBraces = (jsonStr.match(/\}/g) || []).length;
    const openBrackets = (jsonStr.match(/\[/g) || []).length;
    const closeBrackets = (jsonStr.match(/\]/g) || []).length;

    // Remove extra closing delimiters first
    let repaired = jsonStr;
    let extraClose = (closeBraces - openBraces) + (closeBrackets - openBrackets);
    while (extraClose > 0 && repaired.length > 0) {
      const lastChar = repaired[repaired.length - 1];
      if (lastChar === '}' || lastChar === ']') {
        repaired = repaired.substring(0, repaired.length - 1);
        extraClose--;
      } else {
        break;
      }
    }

    // Add missing closing delimiters
    const ob = (repaired.match(/\{/g) || []).length;
    const cb = (repaired.match(/\}/g) || []).length;
    const oa = (repaired.match(/\[/g) || []).length;
    const ca = (repaired.match(/\]/g) || []).length;

    for (let i = 0; i < ob - cb; i++) repaired += '}';
    for (let i = 0; i < oa - ca; i++) repaired += ']';

    return JSON.parse(repaired);
  } catch {}

  throw new Error('Could not repair JSON');
}

/**
 * Simple test function to verify DeepSeek API connectivity.
 */
// Export for testing
export function scanForProductCodes(text) {
  const codes = new Set();

  // Pattern 1: Lines that are JUST a product code like "CH-790" or "HA-005"
  // Matches patterns like CH-790, HA-005, HC-001, P01-01, etc.
  const codeLineRegex = /^([A-Za-z]{1,4}[-_]\d{2,4})$/gm;
  let match;
  while ((match = codeLineRegex.exec(text)) !== null) {
    codes.add(match[1]);
  }

  // Pattern 2: Codes in "型号" column context (型号 CH-790 or 型号:CH-790)
  const modelColRegex = /型号[：:]\s*([A-Za-z]{1,4}[-_]\d{2,4})/g;
  while ((match = modelColRegex.exec(text)) !== null) {
    codes.add(match[1]);
  }

  // Pattern 3: Any CH-\d{3} or HA-\d{3} pattern (common furniture catalog codes)
  const genericCodeRegex = /\b(CH|HA|HC|P0|ST|MD|RF)[-_](\d{2,4})\b/g;
  while ((match = genericCodeRegex.exec(text)) !== null) {
    codes.add(`${match[1]}-${match[2]}`);
  }

  // Pattern 4: Codes with letter suffix like "CH-262A" or "CH-735-40T"
  // e.g. CH-262A, CH-735-40T, HA-102B
  const suffixCodeRegex = /\b([A-Za-z]{1,4})[-_](\d{2,4})([A-Z](?:[-_]\d{1,3}[A-Z]?)?)\b/g;
  while ((match = suffixCodeRegex.exec(text)) !== null) {
    codes.add(`${match[1]}-${match[2]}${match[3]}`);
  }

  // Pattern 5: Codes embedded in longer text like "CH-790" not at line start
  // Broader match for any letter-number pattern that looks like a product code
  const embeddedCodeRegex = /(?<![A-Za-z0-9])([A-Za-z]{1,4})[-_](\d{2,4})(?![A-Za-z0-9-])/g;
  while ((match = embeddedCodeRegex.exec(text)) !== null) {
    // Avoid duplicating patterns already caught by Pattern 3
    const code = `${match[1]}-${match[2]}`;
    if (!codes.has(code)) {
      codes.add(code);
    }
  }

  return [...codes].sort();
}

export async function testConnection() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return { ok: false, error: 'No API key' };

  try {
    const res = await fetch(`${DEEPSEEK_API_BASE}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
