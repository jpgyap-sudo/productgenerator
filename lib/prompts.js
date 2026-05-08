// ═══════════════════════════════════════════════════════════════════
//  Render Prompts — Main render + Gemini fixer/fallback prompts
//
//  Architecture:
//    - Main render prompts: Tell GPT Image Mini to create the requested
//      render while preserving product identity exactly.
//    - Fixer prompts: Tell Gemini to repair only product differences
//      while preserving background, camera angle, and scene.
//    - Fallback prompts: Tell Gemini to generate a fresh image using
//      the reference as strict source of truth.
// ═══════════════════════════════════════════════════════════════════

/** Supported render views */
export const VIEWS = ['front', 'side', 'isometric', 'interior'];

/**
 * Base instruction shared across all main render views.
 * Emphasizes strict product identity preservation.
 */
const BASE_MAIN_INSTRUCTION = `Use the uploaded reference product image as the strict design source.

Preserve the product identity exactly:
- same proportions
- same silhouette
- same color
- same material
- same texture
- same visible construction details
- same legs/base/frame
- same cushions, stitching, seams, and edges

You may only change camera angle, product rotation, lighting, and environment according to the requested output.

Do not redesign the product.
Do not replace the product.
Do not recolor the product.
Do not add or remove cushions.
Do not change the legs, base, frame, armrests, backrest, or structure.
Do not make a collage, grid, multi-view sheet, or comparison image.
Generate one separate image only.`;

/**
 * View-specific instructions for the main renderer.
 */
const VIEW_INSTRUCTIONS = {
  front: `IMAGE 1 — FRONT VIEW
Straight-on front view of the chair.
Camera centered on the front face.
White background.
Centered premium catalog product photography.
Clean luxury lighting.
Soft realistic grounding shadow.
No extra furniture, decor, text, logo, watermark, or labels.`,

  side: `IMAGE 2 — TRUE SIDE VIEW
True side profile view of the chair.
Rotate product exactly 90 degrees from the front.
The front face should not be visible except as a very thin edge.
Show product depth clearly.
White background.
Centered premium catalog product photography.
Clean luxury lighting.
Soft realistic grounding shadow.
No extra furniture, decor, text, logo, watermark, or labels.`,

  isometric: `IMAGE 3 — ISOMETRIC VIEW
Three-quarter isometric catalog view.
Product rotated about 45 degrees from the front.
Both front and side must be visible.
Slightly elevated camera.
White background.
Centered premium catalog product photography.
Clean luxury lighting.
Soft realistic grounding shadow.
No extra furniture, decor, text, logo, watermark, or labels.`,

  interior: `IMAGE 4 — INTERIOR SCENE
Create a luxury modern dining room interior scene using the exact same chair as the main furniture.

The chair must remain the hero object and must match the uploaded product reference.

Scene style:
- high-end condominium or architect-designed luxury home
- marble, travertine, wood veneer, brushed metal, linen, boucle
- soft natural daylight
- balanced exposure
- realistic grounding shadows
- correct scale and perspective
- eye-level camera
- Home Atelier neutral luxury tones: beige, taupe, cream, warm gray, black accents, walnut, oak

Allowed supporting decor:
rugs, pendant lights, wall art, curtains, vases, books, trays.

Do not let decor overpower the chair.
The scene must look like a real photographed luxury property listing or interior design magazine image.
No text, logo, watermark, or labels.`
};

/**
 * Build the main render prompt for a given view.
 * @param {string} view - One of 'front', 'side', 'isometric', 'interior'
 * @param {string} [productName] - Optional product name
 * @param {string} [brand] - Optional brand/style source
 * @returns {string} Complete prompt
 */
export function mainRenderPrompt(view, productName, brand) {
  const context = [
    productName ? `Product name: ${productName}` : '',
    brand ? `Brand/style source: ${brand}` : ''
  ].filter(Boolean).join('\n');

  const viewInstruction = VIEW_INSTRUCTIONS[view];
  if (!viewInstruction) throw new Error(`Unknown view: ${view}`);

  return `${context}\n\n${BASE_MAIN_INSTRUCTION}\n\n${viewInstruction}`.trim();
}

/**
 * Build the Gemini fixer prompt.
 * Tells Gemini to repair only product differences while preserving the scene.
 * @param {string} view - The render view
 * @param {string[]} detectedIssues - Issues detected by QA
 * @returns {string} Fixer prompt
 */
export function geminiFixPrompt(view, detectedIssues) {
  const issues = detectedIssues.length
    ? detectedIssues.map(i => `- ${i}`).join('\n')
    : '- product consistency differences';

  return `You are fixing an existing furniture render.

Inputs:
1. Original product reference image
2. Generated render that needs correction

The original product reference is the source of truth.

Repair the generated render so the chair matches the original product more accurately.

Requested output view: ${view}

Detected issues to fix:
${issues}

Preserve:
- existing composition
- camera angle
- lighting
- background
- room scene if present
- catalog style
- image framing

Fix only the product differences:
- wrong silhouette
- changed proportions
- distorted chair legs
- incorrect armrests
- incorrect backrest
- changed cushion shape
- missing seams or stitching
- wrong material texture
- wrong color
- unrealistic shadows around the chair

Do not regenerate the whole image.
Do not redesign the chair.
Do not replace the chair.
Do not change the background unless needed for shadow correction.
Do not add extra furniture.
Do not create a collage or grid.

Output one corrected image only.`;
}

/**
 * Build the Gemini fallback prompt.
 * Tells Gemini to generate a fresh image using the reference as strict source of truth.
 * @param {string} view - The render view
 * @returns {string} Fallback prompt
 */
export function geminiFallbackPrompt(view) {
  return `The previous render failed. Generate a new image using the uploaded reference product as the strict source of truth.

Requested output view: ${view}

Preserve exact product identity:
same silhouette, proportions, color, material, legs, frame, armrests, cushion shape, seams, stitching, and visible design details.

Do not redesign, replace, recolor, or structurally change the product.

Generate only the requested image view.
One image only.
No collage.
No grid.
No text.
No watermark.`;
}
