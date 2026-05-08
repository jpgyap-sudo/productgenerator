# Vercel to VPS Handoff: render.abcx124.xyz

Goal: move the whole Product Image Studio app off Vercel and serve it from the VPS at:

```text
https://render.abcx124.xyz
```

The app is a Node.js Express server that serves `index.html`, exposes `/api/*` routes, runs the background render worker, writes local render assets to `vps-assets/`, and uses Supabase plus external AI APIs.

## Required Source Files

Send these files/folders to the VPS:

```text
index.html
server.js
package.json
package-lock.json
ecosystem.config.cjs
api/
lib/
supabase_migration.sql
supabase_migration_v2.sql
supabase_setup.sql
.env.example
Caddyfile
Dockerfile
docker-compose.yml
README-VPS.md
```

Do not send:

```text
node_modules/
.git/
.vercel/
dist/
logs/
vps-assets/
.env
vps-env.txt
```

Keep `.env` private and create it directly on the VPS.

## DNS

Create this DNS record:

```text
Type: A
Name: render
Value: <VPS_PUBLIC_IP>
Proxy/CDN: DNS only, at least until SSL is issued
```

Verify:

```bash
dig +short render.abcx124.xyz
```

## VPS Path

Use:

```text
/var/www/productgenerator
```

Create directories:

```bash
sudo mkdir -p /var/www/productgenerator
sudo mkdir -p /var/log/productgenerator
sudo chown -R $USER:$USER /var/www/productgenerator /var/log/productgenerator
```

## Environment File

Create `/var/www/productgenerator/.env`:

```env
NODE_ENV=production
PORT=3000

SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

OPENAI_API_KEY=
GEMINI_API_KEY=
DEEPSEEK_API_KEY=
STABILITY_API_KEY=

GOOGLE_SERVICE_ACCOUNT_JSON=

VPS_ASSET_DIR=./vps-assets
VPS_PUBLIC_PREFIX=/vps-assets
```

At least one image provider key must be valid. Supabase values are required.

## Node + PM2 Deployment

Install runtime:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
```

Deploy files to:

```bash
/var/www/productgenerator
```

Install dependencies:

```bash
cd /var/www/productgenerator
npm ci --omit=dev
mkdir -p logs vps-assets
```

Start the app:

```bash
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup systemd
```

Verify Express:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/monitor
```

## Caddy Reverse Proxy

Install Caddy:

```bash
sudo apt-get install -y caddy
```

Use this `/etc/caddy/Caddyfile`:

```caddy
render.abcx124.xyz {
    reverse_proxy localhost:3000

    header {
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
    }

    encode gzip

    log {
        output file /var/log/caddy/product-image-studio.log
        format json
    }
}
```

Reload:

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo systemctl enable caddy
sudo systemctl restart caddy
```

Verify public site:

```bash
curl -I https://render.abcx124.xyz/
curl https://render.abcx124.xyz/health
curl https://render.abcx124.xyz/api/monitor
```

## Optional Docker Deployment

Alternative to PM2:

```bash
cd /var/www/productgenerator
docker compose up -d --build
```

Then keep Caddy proxying to `localhost:3000`.

## Supabase

If tables are missing, apply SQL in Supabase SQL editor in this order:

```text
supabase_setup.sql
supabase_migration.sql
supabase_migration_v2.sql
```

Confirm tables used by the app exist:

```text
product_queue
render_results
```

## Remove Vercel Dependency

Check `index.html` and backend code for hardcoded Vercel URLs:

```bash
grep -R "vercel.app\|VERCEL\|productgenerator.vercel" -n .
```

Replace webhook/callback URLs with:

```text
https://render.abcx124.xyz/api/fal-webhook
```

The frontend should call relative `/api/...` paths only.

## Update Workflow

For future deploys:

```bash
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  --exclude logs \
  --exclude vps-assets \
  ./ user@<VPS_PUBLIC_IP>:/var/www/productgenerator/

ssh user@<VPS_PUBLIC_IP> "cd /var/www/productgenerator && npm ci --omit=dev && pm2 restart product-image-studio && pm2 save"
```

## Final Acceptance Checks

```bash
curl -I https://render.abcx124.xyz/
curl https://render.abcx124.xyz/health
curl https://render.abcx124.xyz/api/monitor
pm2 status
pm2 logs product-image-studio --lines 50
```

Success means:

```text
1. https://render.abcx124.xyz loads the UI.
2. /api/monitor returns JSON.
3. /health returns status ok.
4. PM2 process stays online.
5. A test render creates queue rows/results and assets under vps-assets/.
```
