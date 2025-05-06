module.exports = {
    apps: [{
      name: "guiaisdownloader",
      script: "app.js",
      instances: "max",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3045
      },
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      log_file: "logs/combined.log",
      time: true
    }]
  };
  