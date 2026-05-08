---
name: product-render-pipeline
description: Design or implement the Product Image Studio structured rendering pipeline that combines OpenAI mini models and Gemini image editing. Use when working on product segmentation, structure-control prompts, OpenAI GPT mini/image rendering, Gemini fix/refinement passes, render queue orchestration, provider model configuration, or API-key setup for OPENAI_API_KEY and GEMINI_API_KEY.
---

# Product Render Pipeline

## Overview

Use this skill to keep product-rendering work staged, resumable, and provider-aware. The target pipeline is:

```text
Original Product
  -> Product Segmentation
  -> Structure Control
  -> GPT Mini Render
  -> Gemini Fix
```

## Quick Start

Read `references/openai-gemini-api-notes.md` before changing provider code, model IDs, API-key handling, queue metadata, or render orchestration.

Use these model roles unless the user requests a different model:

- `OPENAI_CONTROL_MODEL=gpt-5.4-mini` for JSON planning and structure control.
- `OPENAI_IMAGE_MODEL=gpt-image-1-mini` for the first image render/edit.
- `GEMINI_FIX_MODEL=gemini-2.5-flash-image` for visual cleanup and correction.

## Workflow

1. Preserve the original product image and metadata.
2. Produce or accept segmentation outputs: mask, cutout, bounding box, and confidence.
3. Ask OpenAI control model for a strict JSON render plan.
4. Render the first image through OpenAI image mini using the render plan and preservation rules.
5. Pass the original and OpenAI render to Gemini for a correction-only fix.
6. Save every intermediate URL and model ID so failed stages can resume.
7. Use the Gemini output as final only when it passes preservation checks; otherwise keep the OpenAI render.

## Implementation Rules

- Keep API keys server-side only.
- Do not expose provider keys in `index.html`.
- Do not overwrite original images.
- Store provider response metadata for audit.
- Prefer a new orchestrator such as `lib/render-pipeline.js` over mixing pipeline policy into `server.js`.
- Keep `lib/openai.js` and `lib/gemini.js` provider-focused.
- Make each stage independently retryable.

## Acceptance Checks

Before marking a render complete, verify:

- product silhouette and proportions are preserved
- material/color did not drift
- no extra product objects or logos were introduced
- target view and aspect ratio were followed
- final image URL is reachable
- model IDs and stage statuses are saved
