# Product Image Studio — VPS Deployment Guide

This guide walks you through deploying **Product Image Studio** on your own VPS (1 GB RAM / 25 GB SSD, Ubuntu 24.04) with continuous background rendering using **OpenAI GPT Image 2** and **Gemini 3**.

## Architecture

```
Browser ──HTTPS──> Caddy (:443) ──proxy──> Express (:3000)
                                               │
                          ┌────────────────────┤
                          ▼                    ▼
                     Supabase DB        Background Worker
                     (queue + results)   (polls every 5s)
                                               │
                          ┌────────────────────┤
                          ▼                    ▼
                     OpenAI API           Gemini API
                     (GPT Image 2)        (Gemini 3)
```

- **Caddy** handles HTTPS (automatic Let's Encrypt) and reverse proxies to Express
- **Express** serves the frontend and API endpoints
- **Background Worker** (in the same process) polls Supabase every 5 seconds for new queue items and processes them using OpenAI or Gemini
- **PM2** keeps the process alive and restarts it on crash

## Prerequisites

- Ubuntu 24.04 VPS with root/sudo access
- A domain name pointing to your VPS IP (`104.248.225.250`)
- Supabase project (free tier) with `product_queue` and `render_results` tables
- OpenAI API key and/or Gemini API key

## One-Time VPS Setup

### 1. SSH into your VPS

```bash
ssh superroo@104.248.225.250
```

### 2. Install Node.js 20

```bash
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# Verify
node --version   # Should be v20.x
npm --version    # Should be 10.x
```

### 3. Install PM2 (process manager)

```bash
sudo npm install -g pm2

# Enable PM2 to start on boot
pm2 startup systemd
```

### 4. Install Caddy (HTTPS reverse proxy)

```bash
sudo apt-get install -y caddy

# Verify
caddy version
```

### 5. Clone the project

```bash
cd /home/superroo
git clone <your-repo-url> productgenerator
# OR create the directory and rsync from your local machine
mkdir -p productgenerator
```

### 6. Create the `.env` file

```bash
cd /home/superroo/productgenerator
nano .env
```

Add the following (replace with your actual keys):

```env
# Required: Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Required (at least one): AI Provider
OPENAI_API_KEY=sk-proj-your-openai-key
GEMINI_API_KEY=AIzaSy-your-gemini-key

# Optional: Google Drive upload
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

### 7. Install dependencies

```bash
cd /home/superroo/productgenerator
npm install --production
```

### 8. Configure Caddy

Edit the Caddyfile:

```bash
sudo nano /etc/caddy/Caddyfile
```

Replace the contents with (change `yourdomain.com` to your actual domain):

```
yourdomain.com {
    reverse_proxy localhost:3000

    header {
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    encode gzip

    log {
        output file /var/log/caddy/product-image-studio.log
        format json
    }
}
```

Then format and start:

```bash
sudo caddy fmt /etc/caddy/Caddyfile
sudo systemctl restart caddy
sudo systemctl enable caddy
```

### 9. Start the app with PM2

```bash
cd /home/superroo/productgenerator
pm2 start ecosystem.config.cjs --env production
pm2 save
```

### 10. Verify everything is running

```bash
# Check PM2 status
pm2 status

# Check health endpoint
curl http://localhost:3000/health

# Check Caddy
curl -I https://yourdomain.com/health
```

## Deploying Updates

You have two ways to deploy updates to the VPS:

### Option A: Deploy Agent (recommended for AI coders)

The [`deploy-agent.mjs`](deploy-agent.mjs) script handles the full workflow: commit → push → rsync → PM2 restart → health check.

```bash
# Commit all changes, push to GitHub, and deploy to VPS
node deploy-agent.mjs "your commit message"

# Or use npm script (will prompt for commit message)
npm run deploy

# Deploy local files without pushing to GitHub first
npm run deploy:push

# Commit and push to GitHub only (skip VPS deploy)
npm run deploy:code
```

The deploy agent will:
1. Check git status for modified files
2. Stage all changes and commit with your message
3. Push to GitHub (`origin main`)
4. Rsync files to the VPS (excluding `node_modules`, `.env`, `.git`, etc.)
5. Restart PM2 with the new code
6. Run a health check to verify the app started

### Option B: Legacy deploy script

```bash
./deploy.sh
```

This will:
1. Rsync all files (excluding `node_modules`, `logs`, `.env`)
2. Run `npm install` on the VPS
3. Reload PM2 with the new code
4. Run a health check

## Monitoring

```bash
# View live logs
pm2 logs product-image-studio

# View last 50 lines
pm2 logs product-image-studio --lines 50

# Monitor CPU/memory
pm2 monit

# Check Caddy logs
sudo journalctl -u caddy --no-pager -n 50
```

## Troubleshooting

### App won't start
```bash
# Check PM2 logs
pm2 logs product-image-studio --lines 50

# Check if port 3000 is in use
sudo lsof -i :3000
```

### Caddy HTTPS not working
```bash
# Check Caddy status
sudo systemctl status caddy

# Check Caddy logs
sudo journalctl -u caddy --no-pager -n 50

# Make sure your domain's A record points to 104.248.225.250
```

### Background worker not processing
```bash
# Check the worker logs
pm2 logs product-image-studio | grep WORKER

# Verify Supabase credentials
curl http://localhost:3000/health
```

## Files

| File | Purpose |
|------|---------|
| `server.js` | Express server + background worker loop |
| `ecosystem.config.cjs` | PM2 process configuration |
| `Caddyfile` | Caddy reverse proxy configuration |
| `deploy.sh` | One-command deployment script |
| `api/queue/submit.js` | Queue submission endpoint |
| `api/queue/status.js` | Queue status endpoint |
| `api/fal-webhook.js` | fal.ai webhook endpoint (legacy) |
| `lib/openai.js` | OpenAI GPT Image 2 integration |
| `lib/gemini.js` | Gemini 3 image generation |
| `lib/supabase.js` | Supabase client |
