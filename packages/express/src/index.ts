/**
 * @tentickle/express - Express integration for Tentickle
 *
 * Provides a pre-configured Express router for Tentickle applications
 * with session management, SSE streaming, and event handling.
 *
 * @example Quick start
 * ```typescript
 * import express from "express";
 * import { createTentickleRouter } from "@tentickle/express";
 * import { createApp } from "@tentickle/core";
 *
 * const app = express();
 * app.use(express.json());
 *
 * const tentickleApp = createApp(<MyAgent />);
 * const { router, destroy } = createTentickleRouter({ app: tentickleApp });
 *
 * app.use("/api", router);
 *
 * const server = app.listen(3000);
 *
 * // Cleanup on shutdown
 * process.on("SIGTERM", () => {
 *   destroy();
 *   server.close();
 * });
 * ```
 *
 * @example With authentication
 * ```typescript
 * import { createTentickleRouter } from "@tentickle/express";
 * import { verifyToken } from "./auth";
 *
 * const { router } = createTentickleRouter({
 *   app: tentickleApp,
 *   authenticate: async (req) => {
 *     const token = req.headers.authorization?.replace("Bearer ", "");
 *     if (token) {
 *       const user = await verifyToken(token);
 *       (req as any).user = user;
 *       return token;
 *     }
 *   },
 *   getUserId: (req) => (req as any).user?.id,
 * });
 * ```
 *
 * @example Custom paths
 * ```typescript
 * const { router } = createTentickleRouter({
 *   app: tentickleApp,
 *   paths: {
 *     sessions: "/chat/sessions",
 *     session: "/chat/sessions/:sessionId",
 *     events: "/chat/stream",
 *   },
 * });
 * ```
 *
 * ## Routes
 *
 * The router provides the following endpoints:
 *
 * | Method | Path | Description |
 * |--------|------|-------------|
 * | POST | /sessions | Create a new session |
 * | GET | /sessions/:sessionId | Get session state |
 * | DELETE | /sessions/:sessionId | Delete a session |
 * | GET | /events?sessionId=... | SSE stream for events |
 * | POST | /events | Send event to session |
 *
 * @module @tentickle/express
 */

export { createTentickleRouter } from "./router.js";

export type {
  TentickleRouterConfig,
  TentickleRouterResult,
  TentickleRequest,
  TentickleHandler,
} from "./types.js";

// Re-export commonly used types from server
export type {
  SessionHandler,
  EventBridge,
  SessionStateInfo,
} from "@tentickle/server";
