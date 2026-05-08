# OpenAI + Gemini API Notes

Use this reference when implementing the structured product render pipeline.

## Sources

- OpenAI API overview: https://openai.com/api/
- OpenAI Responses API migration guide: https://developers.openai.com/api/docs/guides/migrate-to-responses
- OpenAI models: https://developers.openai.com/api/docs/models
- OpenAI image mini model: https://developers.openai.com/api/docs/models/gpt-image-1-mini
- Gemini API key setup: https://ai.google.dev/gemini-api/docs/api-key
- Gemini image generation/editing: https://ai.google.dev/gemini-api/docs/image-generation
- Gemini generateContent API: https://ai.google.dev/api/generate-content

## Current Guidance Summary

OpenAI recommends the Responses API for new projects. Use it for structured text/JSON planning and validation stages.

OpenAI model selection:

- Use `gpt-5.4-mini` for cheaper/lower-latency structure-control tasks.
- Use `gpt-image-1-mini` for cost-efficient image generation/editing.

Gemini key setup:

- Use `GEMINI_API_KEY` server-side.
- Google also supports `GOOGLE_API_KEY`, but only one should be set in this app to avoid ambiguous precedence.

Gemini image generation/editing:

- Use `generateContent`.
- Pass image inputs as inline base64 data.
- Parse returned `inlineData` parts for image bytes.
- Use Gemini as a correction pass after OpenAI image generation.

## Provider Boundaries

OpenAI structure control:

- Input: job metadata, product description, view target, brand, segmentation metadata.
- Output: strict JSON render plan.
- No image generation in this stage.

OpenAI mini image render:

- Input: original product image, mask/cutout, render prompt.
- Output: first generated image.
- Preserve original product identity.

Gemini fix:

- Input: original product image, OpenAI render, fix criteria.
- Output: corrected image.
- Avoid complete redesign.

## Failure Policy

- If segmentation fails, mark the job `needs_segmentation` or fall back to original image only.
- If OpenAI render fails, do not call Gemini.
- If Gemini fix fails, keep the OpenAI render as the final image and store the Gemini error.
- If final upload fails, retry upload without re-running providers.

## Minimum Metadata To Store

```json
{
  "pipelineVersion": "openai-mini-gemini-fix-v1",
  "stage": "completed",
  "models": {
    "control": "gpt-5.4-mini",
    "render": "gpt-image-1-mini",
    "fix": "gemini-2.5-flash-image"
  },
  "urls": {
    "original": "",
    "mask": "",
    "cutout": "",
    "openaiRender": "",
    "geminiFix": "",
    "final": ""
  },
  "checks": {
    "silhouettePreserved": null,
    "materialPreserved": null,
    "viewMatched": null
  }
}
```
