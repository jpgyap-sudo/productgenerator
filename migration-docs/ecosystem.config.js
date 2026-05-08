// PM2 process config
// Usage: pm2 start ecosystem.config.js
// Deploy path: /var/www/productgenerator/

module.exports = {
  apps: [
    {
      name: 'productgenerator',
      script: 'server.js',
      cwd: '/var/www/productgenerator',
      interpreter: 'node',
      interpreter_args: '--experimental-vm-modules',

      // Restart policy
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,

      // Environment
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },

      // Logs
      out_file: '/var/log/productgenerator/out.log',
      error_file: '/var/log/productgenerator/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
