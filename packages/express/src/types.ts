/**
 * Express integration types for Tentickle.
 *
 * @module @tentickle/express/types
 */

import type { Request } from "express";

/**
 * Configuration for the Tentickle Express router.
 */
export interface TentickleHandlerOptions<User = unknown> {
  /**
   * Extract authentication token from request.
   * Called for each request to get user identity.
   *
   * @example
   * ```typescript
   * authenticate: (req) => req.headers.authorization?.replace('Bearer ', '')
   * ```
   */
  authenticate?: (req: Request) => User | undefined | Promise<User | undefined>;

  /**
   * Authorization hook for session access.
   * Return true to allow, false to deny.
   */
  authorize?: (
    user: User | undefined,
    sessionId: string,
    req: Request,
  ) => boolean | Promise<boolean>;

  /**
   * Extract user ID from request.
   * Called after authenticate, can use req.user if set by auth middleware.
   *
   * @example
   * ```typescript
   * getUserId: (req) => (req as any).user?.id
   * ```
   */
  getUserId?: (req: Request, user?: User) => string | undefined | Promise<string | undefined>;

  /**
   * Custom path prefix for routes.
   * @default ""
   */
  pathPrefix?: string;

  /**
   * Custom route paths.
   */
  paths?: {
    /** @default "/events" */
    events?: string;
    /** @default "/send" */
    send?: string;
    /** @default "/subscribe" */
    subscribe?: string;
    /** @default "/abort" */
    abort?: string;
    /** @default "/close" */
    close?: string;
    /** @default "/tool-response" */
    toolResponse?: string;
    /** @default "/channel" */
    channel?: string;
  };

  /**
   * SSE keepalive interval in milliseconds.
   * @default 15000
   */
  sseKeepaliveInterval?: number;
}

/**
 * Extended Express Request with Tentickle context.
 */
export interface TentickleRequest<User = unknown> extends Request {
  tentickle?: {
    user?: User;
    userId?: string;
  };
}
