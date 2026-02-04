/**
 * Tentickle Example - Gateway Server
 *
 * Demonstrates running the Gateway as a standalone server.
 * The Gateway provides both WebSocket and HTTP/SSE access to the same agent.
 *
 * Features:
 * - Custom methods for todo CRUD operations (same API surface as Express server)
 * - Session management helpers
 * - Dual transport (WebSocket + HTTP/SSE)
 *
 * Run with: pnpm gateway
 *
 * The React app can connect to either:
 * - Express server (pnpm dev):  http://localhost:3000/api
 * - Gateway server (pnpm gateway): http://localhost:18790/api
 *
 * Both provide the same API surface via different mechanisms:
 * - Express: REST routes + createTentickleHandler
 * - Gateway: /invoke endpoint + custom methods
 */

import { config as loadEnv } from "dotenv";
loadEnv();

import { z } from "zod";
import { createGateway, method } from "@tentickle/gateway";
import { DevToolsServer } from "@tentickle/devtools";
import { createTentickleApp } from "./setup.js";
import { TodoListService } from "./services/todo-list.service.js";

const GATEWAY_PORT = Number(process.env["GATEWAY_PORT"]) || 18789;
const HTTP_PORT = Number(process.env["HTTP_PORT"]) || 18790;
const DEVTOOLS_PORT = Number(process.env["DEVTOOLS_PORT"]) || 3002;

async function main() {
  // Start DevTools server
  const devtools = new DevToolsServer({ port: DEVTOOLS_PORT, debug: true });
  devtools.start();

  // Create Tentickle app
  const tentickleApp = createTentickleApp();

  // Create Gateway with custom methods for todo operations
  const gateway = createGateway({
    port: GATEWAY_PORT,
    host: "127.0.0.1",
    id: "example-gateway",

    // Both transports - WebSocket for CLI, HTTP/SSE for browsers
    transport: "both",
    httpPort: HTTP_PORT,
    httpPathPrefix: "/api",
    httpCorsOrigin: "*",

    // Apps
    apps: {
      assistant: tentickleApp,
    },
    defaultApp: "assistant",

    // Auth (optional - disable for local dev)
    auth: process.env["GATEWAY_TOKEN"]
      ? { type: "token", token: process.env["GATEWAY_TOKEN"] }
      : { type: "none" },

    // Custom methods - provides same API as Express routes
    methods: {
      // ════════════════════════════════════════════════════════════════════════
      // Task Methods (same API as /api/tasks routes in server.ts)
      // ════════════════════════════════════════════════════════════════════════

      tasks: {
        /**
         * List all todos for a session
         * Express equivalent: GET /api/tasks?sessionId=xxx
         * Gateway: POST /api/invoke { method: "tasks:list", params: { sessionId: "xxx" } }
         */
        list: method({
          schema: z.object({
            sessionId: z.string().optional().default("default"),
          }),
          handler: async (params) => {
            const todos = TodoListService.list(params.sessionId);
            return { todos };
          },
        }),

        /**
         * Create a new todo
         * Express equivalent: POST /api/tasks { title, sessionId }
         * Gateway: POST /api/invoke { method: "tasks:create", params: { title, sessionId } }
         */
        create: method({
          schema: z.object({
            title: z.string().min(1, "title is required"),
            sessionId: z.string().optional().default("default"),
          }),
          handler: async (params) => {
            const todo = TodoListService.create(params.sessionId, params.title);
            const todos = TodoListService.list(params.sessionId);
            return { todo, todos };
          },
        }),

        /**
         * Update a todo
         * Express equivalent: PATCH /api/tasks/:id { title, completed, sessionId }
         * Gateway: POST /api/invoke { method: "tasks:update", params: { id, title, completed, sessionId } }
         */
        update: method({
          schema: z.object({
            id: z.number(),
            title: z.string().optional(),
            completed: z.boolean().optional(),
            sessionId: z.string().optional().default("default"),
          }),
          handler: async (params) => {
            const todo = TodoListService.update(params.sessionId, params.id, {
              title: params.title,
              completed: params.completed,
            });

            if (!todo) {
              throw new Error("Task not found");
            }

            const todos = TodoListService.list(params.sessionId);
            return { todo, todos };
          },
        }),

        /**
         * Mark a todo as complete
         * Express equivalent: POST /api/tasks/:id/complete { sessionId }
         * Gateway: POST /api/invoke { method: "tasks:complete", params: { id, sessionId } }
         */
        complete: method({
          schema: z.object({
            id: z.number(),
            sessionId: z.string().optional().default("default"),
          }),
          handler: async (params) => {
            const todo = TodoListService.complete(params.sessionId, params.id);

            if (!todo) {
              throw new Error("Task not found");
            }

            const todos = TodoListService.list(params.sessionId);
            return { todo, todos };
          },
        }),

        /**
         * Delete a todo
         * Express equivalent: DELETE /api/tasks/:id?sessionId=xxx
         * Gateway: POST /api/invoke { method: "tasks:delete", params: { id, sessionId } }
         */
        delete: method({
          schema: z.object({
            id: z.number(),
            sessionId: z.string().optional().default("default"),
          }),
          handler: async (params) => {
            const deleted = TodoListService.delete(params.sessionId, params.id);

            if (!deleted) {
              throw new Error("Task not found");
            }

            const todos = TodoListService.list(params.sessionId);
            return { deleted: true, todos };
          },
        }),
      },

      // ════════════════════════════════════════════════════════════════════════
      // Session Methods
      // ════════════════════════════════════════════════════════════════════════

      sessions: {
        /**
         * Create or get a session
         * Express equivalent: POST /api/sessions { sessionId? }
         */
        create: method({
          schema: z.object({
            sessionId: z.string().optional(),
          }),
          handler: async (params) => {
            const session = params.sessionId
              ? await tentickleApp.session(params.sessionId)
              : await tentickleApp.session();
            return { sessionId: session.id };
          },
        }),

        /**
         * Get session info
         * Express equivalent: GET /api/sessions/:id
         */
        get: method({
          schema: z.object({
            sessionId: z.string(),
          }),
          handler: async (params) => {
            // Check both in-memory and hibernated sessions
            const inMemory = tentickleApp.has(params.sessionId);
            const hibernated = await tentickleApp.isHibernated(params.sessionId);
            if (!inMemory && !hibernated) {
              throw new Error("Session not found");
            }
            const session = await tentickleApp.session(params.sessionId);
            const snapshot = session.snapshot();
            return {
              sessionId: params.sessionId,
              timeline: snapshot.timeline,
              tick: snapshot.tick,
              usage: snapshot.usage,
              timestamp: snapshot.timestamp,
            };
          },
        }),
      },

      // ════════════════════════════════════════════════════════════════════════
      // Health Check
      // ════════════════════════════════════════════════════════════════════════

      health: async () => ({
        status: "ok",
        timestamp: new Date().toISOString(),
        gateway: true,
      }),
    },
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
║  HTTP Endpoints (at :${HTTP_PORT}):                              ║
║    GET  /api/events            SSE event stream              ║
║    POST /api/send              Send chat message             ║
║    POST /api/invoke            Invoke custom method          ║
║                                                              ║
║  Custom Methods (via /api/invoke):                           ║
║    tasks:list                  List todos                    ║
║    tasks:create                Create todo                   ║
║    tasks:update                Update todo                   ║
║    tasks:complete              Complete todo                 ║
║    tasks:delete                Delete todo                   ║
║    sessions:create             Create session                ║
║    sessions:get                Get session info              ║
║    health                      Health check                  ║
╠══════════════════════════════════════════════════════════════╣
║  Connect with CLI (WebSocket):                               ║
║    tentickle chat --url ws://${host}:${port}            ║
║                                                              ║
║  Connect from browser (HTTP/SSE):                            ║
║    createClient({ baseUrl: 'http://${host}:${HTTP_PORT}/api' })    ║
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
