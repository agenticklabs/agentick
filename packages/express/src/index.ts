/**
 * @tentickle/express - Express integration for Tentickle
 *
 * Provides an Express handler for Tentickle applications
 * with multiplexed SSE streaming and session control.
 *
 * @example Quick start
 * ```typescript
 * import express from "express";
 * import { createTentickleHandler } from "@tentickle/express";
 * import { createApp } from "@tentickle/core";
 *
 * const app = express();
 * app.use(express.json());
 *
 * const tentickleApp = createApp(<MyAgent />);
 * app.use("/api/agent", createTentickleHandler(tentickleApp));
 *
 * const server = app.listen(3000);
 *
 * // Cleanup on shutdown
 * process.on("SIGTERM", () => server.close());
 * ```
 *
 * @example With authentication
 * ```typescript
 * import { createTentickleHandler } from "@tentickle/express";
 * import { verifyToken } from "./auth";
 *
 * app.use("/api/agent", createTentickleHandler(tentickleApp, {
 *   authenticate: async (req) => {
 *     const token = req.headers.authorization?.replace("Bearer ", "");
 *     return token ? verifyToken(token) : undefined;
 *   },
 *   authorize: (user, sessionId) => {
 *     return !!user && sessionId.startsWith(`user-${user.id}-`);
 *   },
 *   getUserId: (req, user) => user?.id,
 * }));
 * ```
 *
 * @example Custom paths
 * ```typescript
 * app.use("/chat", createTentickleHandler(tentickleApp, {
 *   paths: {
 *     events: "/stream",
 *     send: "/send",
 *     subscribe: "/subscribe",
 *     abort: "/abort",
 *     close: "/close",
 *     toolResponse: "/tool-response",
 *   },
 * }));
 * ```
 *
 * ## Routes
 *
 * The handler provides the following endpoints:
 *
 * | Method | Path | Description |
 * |--------|------|-------------|
 * | GET | /events?subscribe=... | SSE stream for events |
 * | POST | /send | Send to a session or ephemeral execution |
 * | POST | /subscribe | Add/remove subscriptions |
 * | POST | /abort | Abort execution |
 * | POST | /close | Close session |
 * | POST | /tool-response | Submit tool confirmation |
 *
 * @module @tentickle/express
 */

export { createTentickleHandler } from "./router";

export type { TentickleHandlerOptions, TentickleRequest } from "./types";
