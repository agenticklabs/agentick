/**
 * Tentickle Example - Express Server
 *
 * Demonstrates:
 * - createTentickleMiddleware for Gateway integration
 * - Custom methods via Gateway methods API
 * - Channel-based state sync
 */

import { config as loadEnv } from "dotenv";
loadEnv();

import express from "express";
import cors from "cors";
import { z } from "zod";
import { Context, Logger } from "@tentickle/kernel";
import { createTentickleMiddleware, method } from "@tentickle/express";
import { DevToolsServer } from "@tentickle/devtools";
import { createTentickleApp } from "./setup.js";
import { TodoListService } from "./services/todo-list.service.js";

// Configure logging at debug level
Logger.configure({ level: "debug" });

const TODO_CHANNEL = "todo-list";

/**
 * Broadcast todo state change to connected clients via channels.
 * This enables real-time sync across multiple browser tabs.
 */
function broadcastTodoState(sessionId: string): void {
  const ctx = Context.tryGet();
  if (!ctx?.channels) return;

  const todos = TodoListService.list(sessionId);
  ctx.channels.publish(ctx, TODO_CHANNEL, {
    type: "state_changed",
    payload: { todos },
  });
}

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

  // Create Tentickle middleware with custom methods
  const tentickleMiddleware = createTentickleMiddleware({
    apps: { assistant: tentickleApp },
    defaultApp: "assistant",

    // Custom methods - replaces separate REST routes
    methods: {
      // ════════════════════════════════════════════════════════════════════════
      // Task Methods
      // ════════════════════════════════════════════════════════════════════════

      tasks: {
        list: method({
          schema: z.object({
            sessionId: z.string().optional().default("default"),
          }),
          handler: async (params) => {
            const todos = TodoListService.list(params.sessionId);
            return { todos };
          },
        }),

        create: method({
          schema: z.object({
            title: z.string().min(1, "title is required"),
            sessionId: z.string().optional().default("default"),
          }),
          handler: async (params) => {
            const todo = TodoListService.create(params.sessionId, params.title);
            const todos = TodoListService.list(params.sessionId);
            broadcastTodoState(params.sessionId);
            return { todo, todos };
          },
        }),

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
            broadcastTodoState(params.sessionId);
            return { todo, todos };
          },
        }),

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
            broadcastTodoState(params.sessionId);
            return { todo, todos };
          },
        }),

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
            broadcastTodoState(params.sessionId);
            return { deleted: true, todos };
          },
        }),
      },

      // ════════════════════════════════════════════════════════════════════════
      // Session Methods
      // ════════════════════════════════════════════════════════════════════════

      sessions: {
        create: method({
          schema: z.object({
            sessionId: z.string().optional(),
          }),
          handler: async (params) => {
            const session = params.sessionId
              ? tentickleApp.session(params.sessionId)
              : tentickleApp.session();
            return { sessionId: session.id };
          },
        }),

        get: method({
          schema: z.object({
            sessionId: z.string(),
          }),
          handler: async (params) => {
            if (!tentickleApp.has(params.sessionId)) {
              throw new Error("Session not found");
            }
            const session = tentickleApp.session(params.sessionId);
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
      }),
    },
  });

  // Mount Tentickle middleware at /api
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expressApp.use("/api", tentickleMiddleware as any);

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
║  HTTP Endpoints:                                             ║
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
╚══════════════════════════════════════════════════════════════╝
    `);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    devtools.stop();
    await tentickleMiddleware.gateway.close();
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
