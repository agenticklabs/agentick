/**
 * Tentickle Example - Gateway Server
 *
 * Demonstrates running the Gateway alongside the Express server.
 * The Gateway provides WebSocket access to the same agent, enabling
 * CLI and multi-client connectivity.
 *
 * Run with: pnpm gateway
 */

import { config as loadEnv } from "dotenv";
loadEnv();

import { createGateway } from "@tentickle/gateway";
import { DevToolsServer } from "@tentickle/devtools";
import { createTentickleApp } from "./setup.js";

const GATEWAY_PORT = Number(process.env["GATEWAY_PORT"]) || 18789;
const HTTP_PORT = Number(process.env["HTTP_PORT"]) || 18790;
const DEVTOOLS_PORT = Number(process.env["DEVTOOLS_PORT"]) || 3002;

async function main() {
  // Start DevTools server
  const devtools = new DevToolsServer({ port: DEVTOOLS_PORT, debug: true });
  devtools.start();

  // Create Tentickle app
  const tentickleApp = createTentickleApp();

  // Create Gateway with the same app
  // Supports both WebSocket and HTTP/SSE transports
  const gateway = createGateway({
    port: GATEWAY_PORT,
    host: "127.0.0.1",
    id: "example-gateway",

    // Transport mode: "websocket", "http", or "both"
    // - "websocket" (default): WebSocket only - good for CLI/native clients
    // - "http": HTTP/SSE only - good for web browsers
    // - "both": Both transports on different ports
    transport: "both",
    httpPort: HTTP_PORT,
    httpPathPrefix: "/api", // Match Express server's API path

    // Agents - same app registered under different names for demo
    agents: {
      assistant: tentickleApp,
    },
    defaultAgent: "assistant",

    // Auth (optional - disable for local dev)
    auth: process.env["GATEWAY_TOKEN"]
      ? { type: "token", token: process.env["GATEWAY_TOKEN"] }
      : { type: "none" },
  });

  // Gateway events
  gateway.on("started", ({ port, host }) => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║           Tentickle Gateway Server                           ║
╠══════════════════════════════════════════════════════════════╣
║  WebSocket:  ws://${host}:${port}                       ║
║  HTTP/SSE:   http://${host}:${HTTP_PORT}                      ║
║  DevTools:   http://localhost:${DEVTOOLS_PORT}                        ║
╠══════════════════════════════════════════════════════════════╣
║  Connect with CLI (WebSocket):                               ║
║    tentickle chat --url ws://${host}:${port}            ║
║                                                              ║
║  Connect from browser (HTTP/SSE):                            ║
║    createClient({ baseUrl: 'http://${host}:${HTTP_PORT}' })    ║
╚══════════════════════════════════════════════════════════════╝
    `);
  });

  gateway.on("client:connected", ({ clientId }) => {
    console.log(`[Gateway] Client connected: ${clientId}`);
  });

  gateway.on("client:disconnected", ({ clientId }) => {
    console.log(`[Gateway] Client disconnected: ${clientId}`);
  });

  gateway.on("session:message", ({ sessionId, role, content }) => {
    console.log(`[Gateway] ${sessionId} [${role}]: ${content.slice(0, 50)}...`);
  });

  gateway.on("error", (error) => {
    console.error(`[Gateway] Error:`, error);
  });

  // Start gateway
  await gateway.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    devtools.stop();
    await gateway.stop();
    console.log("Gateway stopped");
    process.exit(0);
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch(console.error);
