/**
 * Tentickle Example - Express Server
 *
 * Demonstrates:
 * - createTentickleRouter for session/event routes
 * - Custom REST routes for todo management
 * - Channel-based state sync
 */

import { config as loadEnv } from "dotenv";
loadEnv();

import express from "express";
import cors from "cors";
import { createTentickleRouter } from "@tentickle/express";
import { DevToolsServer } from "@tentickle/devtools";
import { createTentickleApp } from "./setup.js";
import { todoRoutes } from "./routes/todos.js";

const PORT = Number(process.env["PORT"]) || 3000;
const DEVTOOLS_PORT = Number(process.env["DEVTOOLS_PORT"]) || 3002;

async function main() {
  const expressApp = express();

  // Start DevTools server (subscribes to devToolsEmitter)
  const devtools = new DevToolsServer({ port: DEVTOOLS_PORT, debug: true });
  devtools.start();

  // Middleware
  expressApp.use(cors());
  expressApp.use(express.json());

  // Health check
  expressApp.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Create Tentickle app
  const tentickleApp = createTentickleApp();

  // Create Tentickle router (provides /sessions and /events routes)
  const { router, sessionHandler, eventBridge, destroy } = createTentickleRouter({
    app: tentickleApp,
    defaultSessionOptions: { devTools: true },
  });

  // Mount Tentickle routes at /api
  expressApp.use("/api", router);

  // Custom REST routes for direct todo manipulation
  expressApp.use("/api/tasks", todoRoutes(sessionHandler, eventBridge));

  // Start server
  const server = expressApp.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║           Tentickle Example Server                           ║
╠══════════════════════════════════════════════════════════════╣
║  Server:     http://localhost:${PORT}                        ║
║  Health:     http://localhost:${PORT}/health                 ║
║  API:        http://localhost:${PORT}/api                    ║
║  DevTools:   http://localhost:${DEVTOOLS_PORT}               ║
╠══════════════════════════════════════════════════════════════╣
║  Endpoints:                                                  ║
║    POST /api/sessions          Create session                ║
║    GET  /api/sessions/:id      Get session state             ║
║    GET  /api/events            SSE stream (sessionId param)  ║
║    POST /api/events            Send event                    ║
║    GET  /api/tasks             List todos                    ║
║    POST /api/tasks             Create todo                   ║
╚══════════════════════════════════════════════════════════════╝
    `);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    destroy();
    devtools.stop();
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
    setTimeout(() => {
      console.error("Forced shutdown");
      process.exit(1);
    }, 5000);
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch(console.error);
