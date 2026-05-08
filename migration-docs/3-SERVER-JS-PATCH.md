# server.js Patch — Serve index.html from Express

This is the only code change needed for the migration.

## What to Add

Open `server.js` and find where the Express app is created (the `app = express()` line).
Add the following **immediately after** the middleware setup, **before** any route registrations:

```javascript
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files from project root (css, images, etc.)
app.use(express.static(__dirname, {
  index: false,      // don't auto-serve index.html here
  dotfiles: 'deny',  // block .env access
}));

// Serve frontend for root and any non-API route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
```

## Why This Works

- `index.html` already calls all APIs as relative paths: `/api/queue/status`, `/api/agent/process`, etc.
- No URL changes needed in the frontend
- nginx will proxy `/api/*` → Express, so the routing is transparent to the browser

## What NOT to Change

- All `api/*.js` route files — unchanged
- All `lib/*.js` files — unchanged
- `index.html` — unchanged
- `.env` — unchanged (just copy to VPS if not already there)

## Vercel-Specific Files (can be removed)

Once migration is confirmed working:
- `vercel.json` — no longer needed
- `.vercel/` folder — no longer needed
