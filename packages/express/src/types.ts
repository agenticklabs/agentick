/**
 * Express integration types for Tentickle.
 *
 * @module @tentickle/express/types
 */

import type { Request, Response, NextFunction, Router } from "express";
import type { App } from "@tentickle/core/app";
import type { SessionHandler, EventBridge } from "@tentickle/server";

/**
 * Configuration for the Tentickle Express router.
 */
export interface TentickleRouterConfig {
  /**
   * The Tentickle application instance.
   * Either `app` or `sessionHandler` must be provided.
   */
  app?: App;

  /**
   * Pre-configured session handler.
   * If not provided, one will be created from `app`.
   */
  sessionHandler?: SessionHandler;

  /**
   * Pre-configured event bridge.
   * If not provided, one will be created.
   */
  eventBridge?: EventBridge;

  /**
   * Extract authentication token from request.
   * Called for each request to get user identity.
   *
   * @example
   * ```typescript
   * authenticate: (req) => req.headers.authorization?.replace('Bearer ', '')
   * ```
   */
  authenticate?: (req: Request) => string | undefined | Promise<string | undefined>;

  /**
   * Extract user ID from request.
   * Called after authenticate, can use req.user if set by auth middleware.
   *
   * @example
   * ```typescript
   * getUserId: (req) => (req as any).user?.id
   * ```
   */
  getUserId?: (req: Request) => string | undefined | Promise<string | undefined>;

  /**
   * Custom path prefix for routes.
   * @default ""
   */
  pathPrefix?: string;

  /**
   * Custom route paths.
   */
  paths?: {
    /** @default "/sessions" */
    sessions?: string;
    /** @default "/sessions/:sessionId" */
    session?: string;
    /** @default "/events" */
    events?: string;
  };

  /**
   * SSE keepalive interval in milliseconds.
   * @default 15000
   */
  sseKeepaliveInterval?: number;

  /**
   * Default session options passed to app.createSession().
   * Use this to enable DevTools, set default props, etc.
   *
   * @example
   * ```typescript
   * defaultSessionOptions: { devTools: true }
   * ```
   */
  defaultSessionOptions?: Record<string, unknown>;
}

/**
 * Extended Express Request with Tentickle context.
 */
export interface TentickleRequest extends Request {
  tentickle?: {
    sessionHandler: SessionHandler;
    eventBridge: EventBridge;
    userId?: string;
    token?: string;
  };
}

/**
 * Handler function type for individual route handlers.
 */
export type TentickleHandler = (
  req: TentickleRequest,
  res: Response,
  next: NextFunction
) => void | Promise<void>;

/**
 * Result of creating a Tentickle router.
 */
export interface TentickleRouterResult {
  /** The Express router with all routes mounted */
  router: Router;
  /** The session handler instance */
  sessionHandler: SessionHandler;
  /** The event bridge instance */
  eventBridge: EventBridge;
  /** Cleanup function - call on server shutdown */
  destroy: () => void;
}
