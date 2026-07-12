module.exports = {
  apps: [
    {
      name: "main-website",
      script: "server.js",
      cwd: "/home/ubuntu/Code/app",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        HOSTNAME: "127.0.0.1"  // bind to localhost; Nginx proxies to it
      }
    }
  ]
};