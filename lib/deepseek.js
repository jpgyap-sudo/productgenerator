// ═══════════════════════════════════════════════════════════════════
//  lib/deepseek.js — DeepSeek API client for AI-powered extraction
//  Used by the Uploading Agent to extract product info from PDF text.
// ═══════════════════════════════════════════════════════════════════

const DEEPSEEK_API_BASE = 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL = 'deepseek-chat'; // Fast, handles Chinese natively
const MAX_TOKENS = 8192;
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
    // Strip markdown code fences if present
    let cleanContent = content.trim();
    const fenceMatch = cleanContent.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      cleanContent = fenceMatch[1].trim();
    }

    // Try direct parse first
    const parsed = JSON.parse(cleanContent);
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
    // Try to extract JSON object or array from the response
    const objMatch = content.match(/\{[\s\S]*\}/);
    const arrMatch = content.match(/\[[\s\S]*\]/);
    let jsonStr = objMatch ? objMatch[0] : (arrMatch ? arrMatch[0] : null);

    if (jsonStr) {
      // Attempt to repair truncated JSON (missing closing brackets)
      try {
        const parsed = JSON.parse(jsonStr);
        let products;
        if (Array.isArray(parsed)) {
          products = parsed;
        } else if (parsed.products && Array.isArray(parsed.products)) {
          products = parsed.products;
        } else {
          products = [parsed];
        }
        return products.map((p, i) => ({
          name: p.name || `Product ${i + 1}`,
          brand: p.brand || '',
          productCode: p.productCode || '',
          description: p.description || '',
          category: p.category || 'other'
        }));
      } catch {
        // JSON is truncated — try to repair it
        try {
          // Count opening and closing braces/brackets
          const openBraces = (jsonStr.match(/\{/g) || []).length;
          const closeBraces = (jsonStr.match(/\}/g) || []).length;
          const openBrackets = (jsonStr.match(/\[/g) || []).length;
          const closeBrackets = (jsonStr.match(/\]/g) || []).length;

          // Add missing closing braces/brackets
          let repaired = jsonStr;
          for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}';
          for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += ']';

          const parsed = JSON.parse(repaired);
          let products;
          if (Array.isArray(parsed)) {
            products = parsed;
          } else if (parsed.products && Array.isArray(parsed.products)) {
            products = parsed.products;
          } else {
            products = [parsed];
          }
          console.log('[DEEPSEEK] Repaired truncated JSON successfully');
          return products.map((p, i) => ({
            name: p.name || `Product ${i + 1}`,
            brand: p.brand || '',
            productCode: p.productCode || '',
            description: p.description || '',
            category: p.category || 'other'
          }));
        } catch {}
      }
    }
    console.error('[DEEPSEEK] Failed to parse response:', content.substring(0, 500));
    throw new Error('Failed to parse DeepSeek response as JSON');
  }
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
