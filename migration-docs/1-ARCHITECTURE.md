# Product Image Studio — Architecture

## Current Architecture (Vercel + VPS)

```
User Browser
     │
     ▼
┌─────────────────────────┐
│   Vercel CDN            │  ← serves index.html
│   productgenerator.vercel.app │
└────────────┬────────────┘
             │  /api/*  and  /vps-assets/*
             │  (Vercel rewrites these to VPS)
             ▼
┌─────────────────────────┐
│   VPS — 104.248.225.250 │
│   Node.js Express :3000 │  ← all API logic lives here
│   /vps-assets/renders/  │  ← rendered images stored here
└────────────┬────────────┘
             │
     ┌───────┼───────────────┬──────────────┐
     ▼       ▼               ▼              ▼
  Supabase  OpenAI        Gemini        Google Drive
  (DB +     (image gen)   (image gen    (archive
  Storage)               + verify)      renders)
             │
             ▼
          DeepSeek
          (PDF text
          extraction)
```

---

## Target Architecture (Full VPS)

```
User Browser
     │
     ▼
┌─────────────────────────┐
│   nginx (port 80/443)   │  ← SSL termination, domain routing
│   render.abcx124.xyz    │
└────────────┬────────────┘
             │
    ┌────────┴──────────┐
    │                   │
    │ /                 │ /api/*  and  /vps-assets/*
    ▼                   ▼
  serve               proxy_pass
  index.html          http://localhost:3000
    │                   │
    └─────────┬─────────┘
              ▼
┌─────────────────────────┐
│   Node.js Express :3000 │
│   server.js             │
│   /vps-assets/renders/  │
└────────────┬────────────┘
             │
     ┌───────┼───────────────┬──────────────┐
     ▼       ▼               ▼              ▼
  Supabase  OpenAI        Gemini        Google Drive
  DeepSeek  (image gen)   (image gen    (archive
  (PDF)                   + verify)      renders)
```

---

## Component Map

| File | Role |
|---|---|
| `index.html` | Entire frontend (383KB, vanilla JS, no framework) |
| `server.js` | Express server + background render worker |
| `api/queue/submit.js` | Submit items to render queue |
| `api/queue/status.js` | Poll render progress |
| `api/queue/completed.js` | Save/load/delete completed batches |
| `api/queue/download-zip.js` | Package renders into ZIP for download |
| `api/queue/upload-drive.js` | Upload renders to Google Drive |
| `api/queue/save-state.js` | Persist state on page unload (sendBeacon) |
| `api/queue/rerender-view.js` | Re-generate one view for a product |
| `api/agent/process.js` | Phase 1 — extract products from PDF + images from ZIP |
| `api/agent/match.js` | Phase 2 — match products to images |
| `api/agent/matched-images.js` | Phase 2b — serve matched image previews |
| `api/agent/save-matched.js` | Phase 3 — confirm matches, create queue items |
| `api/agent/submit.js` | Submit single product from agent workflow |
| `api/process-item.js` | Core render worker — generates 4 views per product |
| `api/fal-webhook.js` | Webhook receiver for fal.ai async job results |
| `api/monitor.js` | Health check — tests all external services |
| `lib/supabase.js` | Supabase client |
| `lib/fal.js` | fal.ai image generation |
| `lib/openai.js` | OpenAI image generation |
| `lib/gemini.js` | Gemini image generation |
| `lib/deepseek.js` | DeepSeek PDF text extraction |
| `lib/gemini-verify.js` | Gemini vision for product-image matching |
| `lib/pdf-extractor.js` | PDF → text |
| `lib/zip-extractor.js` | ZIP → images |
| `lib/drive.js` | Google Drive upload |
| `lib/vps-storage.js` | Local filesystem storage for renders |
| `lib/completed-batches.js` | JSON file persistence for completed items |
| `lib/render-with-fallback.js` | Provider fallback chain |
| `vps-assets/renders/` | Local render output directory |

---

## Key Data Flows

### Upload Agent Flow
```
User uploads PDF + ZIP
       │
       ▼
POST /api/agent/process
  → DeepSeek extracts product names, codes, descriptions
  → pdf-extractor reads PDF text
  → zip-extractor unpacks all images
  → returns: products[] + images[]
       │
       ▼
POST /api/agent/match
  → product-matcher.js pattern-matches products ↔ images
  → gemini-verify.js optionally verifies matches via vision
  → returns: matches[] + unmatched[]
       │
       ▼
POST /api/agent/save-matched
  → user confirms selections
  → uploads images to Supabase Storage
  → creates queue rows in Supabase DB
       │
       ▼
     Queue
```

### Render Flow
```
Queue item (status: waiting)
       │
       ▼
POST /api/process-item  (called by server.js worker loop)
  → generates 4 product views in parallel
  → providers: OpenAI GPT-Image-2 / Gemini Flash / fal.ai
  → saves each render to Supabase Storage
  → uploads to Google Drive
  → updates render_results rows in Supabase
       │
       ▼
Frontend polls GET /api/queue/status every N seconds
  → shows per-view progress
  → marks item complete when all 4 views done
```

---

## Database (Supabase)

Tables used:
- `queue` — one row per product being rendered
- `render_results` — one row per view (4 per product), tracks URL + status

Storage buckets:
- `renders` — final render images
- `uploads` — source product images from agent
