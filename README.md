# Product Image Studio

AI-powered product photography studio — generates 5 professional views (front, side, isometric, back, interior scene) from a single product image using [fal.ai](https://fal.ai) Nano Banana 2 model.

## Features

- **5 views per product** — front, side, isometric, back, and luxury interior scene
- **Parallel processing** — process up to 4 products simultaneously
- **Dark mode** — automatic system preference detection + manual toggle
- **Queue management** — reorder items, clear completed/all, per-item controls
- **Batch retry** — retry only failed views without re-processing everything
- **ZIP download** — download all renders with progress indicator
- **Image lightbox** — click any render for full-size preview
- **LocalStorage persistence** — queue, description, and settings survive page refresh
- **Environment variable API key** — set `FAL_API_KEY` in Vercel for zero-config deployments
- **Responsive layout** — works on desktop and mobile
- **Exponential backoff retry** — automatic retry with jitter for transient API errors
- **Content Security Policy** — CSP headers for enhanced security

## Deploy to Vercel

This project is configured for Vercel deployment.

### Option 1: API key via environment variable (recommended)

1. Push this repo to your GitHub account
2. Import the project in Vercel: `https://vercel.com/new`
3. Or connect to existing project: `https://vercel.com/jpgyap-4508s-projects/productgenerator`
4. **Set your fal.ai API key** in Vercel Dashboard:
   - Go to your project → **Settings** → **Environment Variables**
   - Add variable: **Name** = `FAL_API_KEY`, **Value** = your fal.ai key
   - Deploy the project
5. The API key is automatically injected at build time — no manual entry needed

### Option 2: Manual API key entry

If you don't set the environment variable, the API key input field will be available for manual entry (saved to localStorage).

## Usage

1. Enter a product description (color, material, style)
2. Upload product images (PNG/JPG/WEBP, max 10MB each)
3. Select resolution (0.5K–4K)
4. Adjust parallelism (1–4) for batch processing speed
5. Click **Start Queue**
6. Download individual renders or ZIP archives

> **Note:** If `FAL_API_KEY` is set as a Vercel environment variable, the API key field will be pre-filled and locked. No manual entry needed.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Main application (single-page app) |
| `vercel.json` | Vercel deployment configuration |
| `package.json` | Project metadata & build script |

## Tech Stack

- Vanilla JavaScript (no framework)
- [fal.ai](https://fal.ai) Nano Banana 2 API for AI image generation
- [JSZip](https://stuk.github.io/jszip/) for ZIP downloads
- Vercel for hosting
