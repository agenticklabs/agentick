import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // SSE endpoint needs special handling - no buffering, longer timeout
      "/api/events": {
        target: "http://localhost:3000",
        changeOrigin: true,
        // Configure for SSE: disable buffering and extend timeout
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            // Ensure response is not buffered
            proxyRes.headers["x-accel-buffering"] = "no";
          });
        },
      },
      // Regular API endpoints
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
