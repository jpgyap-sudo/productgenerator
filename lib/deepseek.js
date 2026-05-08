// ═══════════════════════════════════════════════════════════════════
//  lib/deepseek.js — DeepSeek API client for AI-powered extraction
//  Used by the Uploading Agent to extract product info from PDF text.
// ═══════════════════════════════════════════════════════════════════

const DEEPSEEK_API_BASE = 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL = 'deepseek-chat'; // Fast, handles Chinese natively
const MAX_TOKENS = 16384; // Increased for large catalogs with many products
const TEMPERATURE = 0.1; // Low temp for structured extraction

/**
 * Extract structured product information from PDF text using DeepSeek.
 * Handles mixed English/Chinese text, filters irrelevant content.
 *
 * @param {string} pdfText - Raw text extracted from PDF
 * @returns {Promise<Array<{name: string, brand: string, description: string, category: string, productCode: string}>>}
 */
export async function extractProductInfo(pdfText) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY environment variable not set');
  }

  const systemPrompt = `You are an expert product catalog analyzer. Extract structured product information from PDF text that may contain mixed English and Chinese content.

Your task:
1. Identify ALL products described in the text
2. Extract the product name (in English if available)
3. Extract the brand/manufacturer name (in English if available)
4. Extract the original product code (e.g., CH-005, HA-790, HC-001) — this is usually a short alphanumeric code near the product name
5. Create a detailed product description suitable for AI image generation
6. Determine the product category

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
      "name": "Product Name in English",
      "brand": "Brand Name",
      "productCode": "CH-005",
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

  console.log('[DEEPSEEK] Sending extraction request...');
  console.log(`[DEEPSEEK] PDF text length: ${pdfText.length} chars`);

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

  console.log(`[DEEPSEEK] Response received (${content.length} chars)`);

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
    return products.map((p, i) => ({
      name: p.name || `Product ${i + 1}`,
      brand: p.brand || '',
      productCode: p.productCode || '',
      description: p.description || '',
      category: p.category || 'other'
    }));
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
