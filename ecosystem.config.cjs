// ═══════════════════════════════════════════════════════════════════
//  PM2 Ecosystem Configuration
//  Manages the Product Image Studio Node.js process on the VPS.
//
//  Processes:
//    1. product-image-studio — Express web server (port 3000)
//    2. render-queue-worker — BullMQ render queue worker + cleanup cron
//
//  Features:
//  - Auto-restart on crash (3s delay)
//  - Restart on file changes (watch mode disabled by default)
//  - Log rotation (10MB max per file, 3 files retained)
//  - Graceful shutdown with SIGINT
//  - Environment variables loaded from .env file (via dotenv in server.js)
//    Actual secrets are NOT stored in this file — they're in .env (gitignored)
// ═══════════════════════════════════════════════════════════════════

module.exports = {
  apps: [
    {
      name: 'product-image-studio',
      script: './server.js',
      node_args: '--experimental-modules',
      env: {
        NODE_ENV: 'production',
        PORT: '3000'
        // ── All secrets (API keys, service account JSON) are loaded from .env ──
        //    See .env.example for the required variables.
        //    On the VPS, deploy.sh syncs vps-env.txt → .env automatically.
      },
      // Auto-restart settings
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 3000,
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,
      max_size: '10M',
      retain: 3,
      // Graceful shutdown
      kill_timeout: 10000,
      // Watch mode (disabled by default — enable with --watch flag)
      watch: false,
      // Instance count
      instances: 1,
      exec_mode: 'fork'
    },
    {
      name: 'render-queue-worker',
      script: './workers/render-queue.worker.js',
      node_args: '--experimental-modules',
      env: {
        NODE_ENV: 'production',
        RENDER_WORKER_CONCURRENCY: '2'
      },
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/render-worker-error.log',
      out_file: './logs/render-worker-out.log',
      merge_logs: true,
      max_size: '10M',
      retain: 3,
      kill_timeout: 10000,
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
};
