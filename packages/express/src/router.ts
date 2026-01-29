/**
 * Express router factory for Tentickle.
 *
 * @module @tentickle/express/router
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import {
  createSessionHandler,
  createEventBridge,
  createSSEWriter,
  setSSEHeaders,
} from "@tentickle/server";
import type { ServerConnection } from "@tentickle/server";
import type {
  TentickleRouterConfig,
  TentickleRequest,
  TentickleRouterResult,
} from "./types.js";

/**
 * Create an Express router with Tentickle endpoints.
 *
 * @example Basic usage
 * ```typescript
 * import express from "express";
 * import { createTentickleRouter } from "@tentickle/express";
 * import { createApp } from "@tentickle/core";
 *
 * const app = express();
 * const tentickleApp = createApp(<MyAgent />);
 *
 * const { router } = createTentickleRouter({ app: tentickleApp });
 * app.use("/api", router);
 *
 * // Routes:
 * // POST   /api/sessions      - Create session
 * // GET    /api/sessions/:id  - Get session state
 * // DELETE /api/sessions/:id  - Delete session
 * // GET    /api/events        - SSE stream
 * // POST   /api/events        - Send event
 * ```
 *
 * @example With authentication
 * ```typescript
 * const { router } = createTentickleRouter({
 *   app: tentickleApp,
 *   authenticate: (req) => req.headers.authorization?.replace("Bearer ", ""),
 *   getUserId: (req) => (req as any).user?.id,
 * });
 * ```
 */
export function createTentickleRouter(
  config: TentickleRouterConfig
): TentickleRouterResult {
  if (!config.app && !config.sessionHandler) {
    throw new Error("Either app or sessionHandler must be provided");
  }

  // Create or use provided session handler
  const sessionHandler =
    config.sessionHandler ??
    createSessionHandler({
      app: config.app!,
      defaultSessionOptions: config.defaultSessionOptions,
    });

  // Create or use provided event bridge
  const eventBridge =
    config.eventBridge ??
    createEventBridge({ sessionHandler });

  // Path configuration
  const paths = {
    sessions: config.paths?.sessions ?? "/sessions",
    session: config.paths?.session ?? "/sessions/:sessionId",
    events: config.paths?.events ?? "/events",
  };

  const sseKeepaliveInterval = config.sseKeepaliveInterval ?? 15000;

  // Create router
  const router = Router();

  // Middleware to attach tentickle context
  router.use(async (req: TentickleRequest, res: Response, next: NextFunction) => {
    try {
      const token = config.authenticate
        ? await config.authenticate(req)
        : undefined;
      const userId = config.getUserId
        ? await config.getUserId(req)
        : undefined;

      req.tentickle = {
        sessionHandler,
        eventBridge,
        token,
        userId,
      };
      next();
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // Session Routes
  // ============================================================================

  /**
   * POST /sessions - Create a new session
   *
   * Body: { sessionId?: string, props?: Record<string, unknown> }
   * Response: { sessionId: string, status: "created" | "existing" }
   */
  router.post(paths.sessions, async (req: TentickleRequest, res: Response, next: NextFunction) => {
    try {
      const { sessionId: requestedId, props } = req.body ?? {};

      const existing = requestedId
        ? sessionHandler.getSession(requestedId)
        : undefined;

      if (existing) {
        res.json({ sessionId: requestedId, status: "existing" });
        return;
      }

      const { sessionId } = await sessionHandler.create({
        sessionId: requestedId,
        props,
      });

      res.status(201).json({ sessionId, status: "created" });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /sessions/:sessionId - Get session state
   *
   * Response: SessionStateInfo | 404
   */
  router.get(paths.session, (req: TentickleRequest, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const state = sessionHandler.getState(sessionId);

      if (!state) {
        res.status(404).json({
          error: "SESSION_NOT_FOUND",
          message: `Session not found: ${sessionId}`,
        });
        return;
      }

      res.json(state);
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /sessions/:sessionId - Delete a session
   *
   * Response: { deleted: boolean }
   */
  router.delete(paths.session, (req: TentickleRequest, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const deleted = sessionHandler.delete(sessionId);
      res.json({ deleted });
    } catch (err) {
      next(err);
    }
  });

  // ============================================================================
  // Event Routes
  // ============================================================================

  // Track SSE connections for cleanup
  const activeConnections = new Map<string, ServerConnection>();

  /**
   * GET /events - SSE stream for server → client events
   *
   * Query params:
   * - sessionId (required): Session to subscribe to
   * - userId (optional): User identifier
   *
   * Response: Server-Sent Events stream
   */
  router.get(paths.events, (req: TentickleRequest, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.query.sessionId as string;
      const userId = req.tentickle?.userId ?? (req.query.userId as string | undefined);

      if (!sessionId) {
        res.status(400).json({
          error: "INVALID_REQUEST",
          message: "sessionId query parameter is required",
        });
        return;
      }

      // Check session exists
      if (!sessionHandler.getSession(sessionId)) {
        res.status(404).json({
          error: "SESSION_NOT_FOUND",
          message: `Session not found: ${sessionId}`,
        });
        return;
      }

      // Set up SSE
      setSSEHeaders(res);
      const writer = createSSEWriter(res, {
        keepaliveInterval: sseKeepaliveInterval,
      });

      // Generate connection ID
      const connectionId = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      // Create connection
      const connection: ServerConnection = {
        id: connectionId,
        sessionId,
        userId,
        metadata: {
          token: req.tentickle?.token,
          ip: req.ip,
          userAgent: req.get("user-agent"),
        },
        send: async (event) => {
          writer.writeEvent(event);
        },
        close: () => {
          writer.close();
        },
      };

      // Register connection
      activeConnections.set(connectionId, connection);
      eventBridge.registerConnection(connection);

      // Send initial connection event
      writer.writeComment(`connected: ${connectionId}`);

      // Cleanup on disconnect
      req.on("close", () => {
        activeConnections.delete(connectionId);
        eventBridge.unregisterConnection(connectionId);
        writer.close();
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /events - Send event from client → server
   *
   * Body: {
   *   connectionId?: string,  // Optional if sessionId provided
   *   sessionId?: string,     // Required if connectionId not provided
   *   channel: string,
   *   type: string,
   *   payload: unknown,
   *   id?: string
   * }
   */
  router.post(paths.events, async (req: TentickleRequest, res: Response, next: NextFunction) => {
    try {
      const {
        connectionId,
        sessionId: bodySessionId,
        metadata,
        channel,
        type,
        payload,
        id,
      } = req.body ?? {};

      // sessionId can be at top level or in metadata (client sends it in metadata)
      const sessionId = bodySessionId ?? metadata?.sessionId;

      if (!channel || !type) {
        res.status(400).json({
          error: "INVALID_REQUEST",
          message: "channel and type are required",
        });
        return;
      }

      // Find connection - by ID or create ephemeral one for the session
      let connection: ServerConnection | string;

      if (connectionId) {
        // Use existing connection
        connection = connectionId;
      } else if (sessionId) {
        // Create ephemeral connection for this request
        const userId = req.tentickle?.userId;
        connection = {
          id: `ephemeral-${Date.now()}`,
          sessionId,
          userId,
          metadata: {},
          send: async () => {}, // Ephemeral - can't receive
          close: () => {},
        };
      } else {
        res.status(400).json({
          error: "INVALID_REQUEST",
          message: "Either connectionId or sessionId is required",
        });
        return;
      }

      await eventBridge.handleEvent(connection, { channel, type, payload, id });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // Cleanup function
  const destroy = () => {
    // Close all active connections
    for (const connection of activeConnections.values()) {
      connection.close();
    }
    activeConnections.clear();

    // Destroy event bridge
    eventBridge.destroy();
  };

  return {
    router,
    sessionHandler,
    eventBridge,
    destroy,
  };
}
