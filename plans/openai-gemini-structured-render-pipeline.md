# OpenAI Mini + Gemini Structured Render Pipeline

## Goal

Build a controlled product-rendering pipeline that keeps the original product identity intact while allowing AI-generated backgrounds, lighting, and scene fixes.

```text
Original Product
  -> Product Segmentation
  -> Structure Control
  -> GPT Mini Render
  -> Gemini Fix
  -> Final Asset + Metadata
```

## Official Docs To Use

- OpenAI API: https://openai.com/api/
- OpenAI Responses API: https://developers.openai.com/api/docs/guides/migrate-to-responses
- OpenAI models: https://developers.openai.com/api/docs/models
- OpenAI image mini model: https://developers.openai.com/api/docs/models/gpt-image-1-mini
- Gemini API key setup: https://ai.google.dev/gemini-api/docs/api-key
- Gemini image generation/editing: https://ai.google.dev/gemini-api/docs/image-generation
- Gemini generateContent API: https://ai.google.dev/api/generate-content

## Model Roles

Use two different OpenAI roles:

- `OPENAI_CONTROL_MODEL=gpt-5.4-mini`
  - Use for structure planning, prompt normalization, JSON contracts, validation, and render instructions.
  - This should return text/JSON, not images.

- `OPENAI_IMAGE_MODEL=gpt-image-1-mini`
  - Use for the first visual render/edit from the segmented product and structure-control prompt.
  - This repo already defaults `lib/openai.js` to `gpt-image-1-mini`.

Use Gemini as the visual repair/refinement stage:

- `GEMINI_FIX_MODEL=gemini-2.5-flash-image`
  - Use for image + text editing where the first OpenAI render needs cleanup.
  - Typical fixes: product silhouette drift, material mismatch, lighting mismatch, bad shadows, awkward scene integration, small geometry artifacts.

## Environment Variables

```env
OPENAI_API_KEY=
OPENAI_CONTROL_MODEL=gpt-5.4-mini
OPENAI_IMAGE_MODEL=gpt-image-1-mini
OPENAI_IMAGE_MODEL_CHEAP=gpt-image-1-mini
OPENAI_IMAGE_QUALITY=medium

GEMINI_API_KEY=
GEMINI_FIX_MODEL=gemini-2.5-flash-image
```

Keep all provider keys server-side. Do not expose `OPENAI_API_KEY` or `GEMINI_API_KEY` to browser JavaScript.

## Data Contract

Each render job should carry a pipeline object like this:

```json
{
  "product": {
    "sourceImageUrl": "https://...",
    "segmentationMaskUrl": "https://...",
    "description": "walnut dining chair with curved back",
    "brand": "optional brand",
    "mustPreserve": [
      "silhouette",
      "material",
      "visible logo",
      "product proportions"
    ]
  },
  "view": {
    "id": 1,
    "label": "front studio",
    "aspectRatio": "1:1",
    "resolution": "1K"
  },
  "structureControl": {
    "camera": "front, eye-level, 70mm product photo",
    "lighting": "softbox left, soft fill right",
    "background": "warm neutral studio sweep",
    "composition": "product centered, full product visible",
    "negativePrompt": "no extra products, no changed shape, no warped legs"
  },
  "providers": {
    "control": "openai",
    "render": "openai-image",
    "fix": "gemini"
  }
}
```

## Pipeline Stages

### 1. Original Product

Accept a product image URL or upload. Store the original image permanently and keep its URL in the queue item.

Required outputs:

- original image URL
- mime type
- dimensions when available
- product description
- view target

### 2. Product Segmentation

Create a foreground product mask and, ideally, a transparent cutout.

Required outputs:

- `segmentationMaskUrl`
- `productCutoutUrl`
- bounding box metadata
- confidence flag

Implementation can start simple:

- use an external segmentation service, or
- use an internal image-processing helper later, or
- manually accept an uploaded PNG mask during testing.

### 3. Structure Control

Use `OPENAI_CONTROL_MODEL` through the Responses API to convert the product, view, brand, and user intent into a strict JSON render plan.

The control stage should not generate an image. Its job is to reduce prompt chaos.

Recommended output:

```json
{
  "renderPrompt": "Precise product photo instruction...",
  "preservationRules": ["Do not alter product silhouette", "Preserve walnut grain"],
  "sceneRules": ["Warm neutral studio background", "Soft grounded shadow"],
  "fixCriteria": ["No warped legs", "No added logos", "No product shrinkage"]
}
```

### 4. GPT Mini Render

Use `OPENAI_IMAGE_MODEL` to render/edit the image from:

- original product image
- segmentation mask or cutout when available
- structured render prompt
- preservation rules

In the current repo, this belongs near `lib/openai.js` or a new wrapper such as `lib/render-pipeline.js`.

Store:

- first render URL
- provider response metadata
- model ID
- prompt hash
- status

### 5. Gemini Fix

Use Gemini image editing as a correction pass, not a full replacement pass.

Input:

- original product image
- GPT mini rendered image
- segmentation/cutout if available
- fix criteria from structure control

Prompt shape:

```text
Refine the rendered image while preserving the original product's exact silhouette,
material, proportions, and visible details. Fix only integration issues: lighting,
shadow, background realism, small artifacts, and color mismatch. Do not redesign the
product. Return one corrected image.
```

Store:

- fixed image URL
- fix notes if Gemini returns text
- whether fix was accepted automatically

## Acceptance Checks

Run these checks before marking an item complete:

- product silhouette still matches the original
- product material/color did not drift
- no extra product objects were added
- background/lighting matches requested view
- image was uploaded to Supabase or VPS storage
- final URL is reachable
- provider/model IDs are saved for audit

## Suggested Code Shape

Create one orchestrator:

```text
lib/render-pipeline.js
```

Suggested exported function:

```js
export async function runStructuredRenderPipeline(job) {
  const segmentation = await segmentProduct(job);
  const control = await createStructureControlPlan(job, segmentation);
  const openaiRender = await renderWithOpenAIMini(job, segmentation, control);
  const geminiFix = await fixWithGemini(job, segmentation, control, openaiRender);

  return {
    originalUrl: job.imageUrl,
    segmentation,
    control,
    openaiRender,
    geminiFix,
    finalUrl: geminiFix?.url || openaiRender.url
  };
}
```

Keep existing provider modules focused:

- `lib/openai.js`: OpenAI image render/edit helpers
- `lib/gemini.js`: Gemini image edit/fix helpers
- `lib/render-pipeline.js`: orchestration and policy
- `server.js`: queue worker calls the orchestrator

## Notes For AI Coder

- Prefer provider-specific small functions over one huge endpoint.
- Save intermediate outputs; do not overwrite the original.
- Make pipeline stages resumable so failed Gemini fixes can retry without re-running OpenAI render.
- Add model IDs and stage statuses to queue/result rows before optimizing UI.
- Start with one view end-to-end, then expand to all views.
