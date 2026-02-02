import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Use Gateway HTTP port (18790) by default, or override via environment variable
const API_TARGET = process.env.VITE_API_TARGET || "http://localhost:18790";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // SSE endpoints need special handling - no buffering
      "/api/send": {
        target: API_TARGET,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["x-accel-buffering"] = "no";
          });
        },
      },
      "/api/events": {
        target: API_TARGET,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.headers["x-accel-buffering"] = "no";
          });
        },
      },
      // Regular API endpoints
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
