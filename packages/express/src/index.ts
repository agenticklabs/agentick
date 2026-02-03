/**
 * @tentickle/express - Express adapter for Tentickle Gateway
 *
 * Provides an Express middleware that delegates to Gateway.
 * This is a thin adapter - all business logic lives in @tentickle/gateway.
 *
 * @example Quick start
 * ```typescript
 * import express from "express";
 * import { createTentickleMiddleware } from "@tentickle/express";
 * import { createApp } from "@tentickle/core";
 *
 * const app = express();
 * app.use(express.json());
 *
 * const tentickleApp = createApp(<MyAgent />);
 *
 * app.use("/api", createTentickleMiddleware({
 *   apps: { assistant: tentickleApp },
 *   defaultApp: "assistant",
 * }));
 *
 * const server = app.listen(3000);
 *
 * // Cleanup on shutdown
 * process.on("SIGTERM", () => server.close());
 * ```
 *
 * @example With custom methods and auth
 * ```typescript
 * import { createTentickleMiddleware, method } from "@tentickle/express";
 * import { z } from "zod";
 *
 * app.use("/api", createTentickleMiddleware({
 *   apps: { assistant: tentickleApp },
 *   defaultApp: "assistant",
 *   auth: {
 *     type: "custom",
 *     validate: async (token) => {
 *       const user = await verifyToken(token);
 *       return user ? { valid: true, user } : { valid: false };
 *     },
 *   },
 *   methods: {
 *     tasks: {
 *       list: method({
 *         schema: z.object({ sessionId: z.string() }),
 *         handler: async (params) => todoService.list(params.sessionId),
 *       }),
 *     },
 *   },
 * }));
 * ```
 *
 * @module @tentickle/express
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { Gateway, type GatewayConfig } from "@tentickle/gateway";

/**
 * Options for the Express middleware.
 */
export interface TentickleMiddlewareOptions {
  /**
   * Extract token from Express request.
   * By default, extracts from Authorization header.
   */
  getToken?: (req: Request) => string | undefined;
}

/**
 * Gateway config type for Express middleware.
 * Excludes standalone-mode-only options.
 */
export type TentickleExpressConfig = Omit<
  GatewayConfig,
  "port" | "host" | "transport" | "httpPort"
>;

/**
 * Express Router with attached Gateway instance for lifecycle management.
 */
export interface TentickleRouter extends Router {
  /** The underlying Gateway instance for lifecycle management */
  gateway: Gateway;
}

/**
 * Create Express middleware that delegates to Gateway.
 *
 * @param gatewayConfig - Gateway configuration (apps, methods, auth, etc.)
 * @param options - Optional Express-specific options
 * @returns Express Router middleware with attached gateway
 *
 * @example
 * ```typescript
 * const middleware = createTentickleMiddleware({
 *   apps: { assistant: myApp },
 *   defaultApp: "assistant",
 * });
 *
 * app.use("/api", middleware);
 *
 * // Access gateway for lifecycle management
 * process.on("SIGTERM", () => middleware.gateway.close());
 * ```
 */
export function createTentickleMiddleware(
  gatewayConfig: TentickleExpressConfig,
  options: TentickleMiddlewareOptions = {},
): TentickleRouter {
  // Create gateway in embedded mode
  const gateway = new Gateway({
    ...gatewayConfig,
    embedded: true,
  });

  const router = Router() as TentickleRouter;

  // Attach gateway for lifecycle management
  router.gateway = gateway;

  // Delegate all requests to gateway
  router.use((req: Request, res: Response, next: NextFunction) => {
    // Optionally inject token from custom extractor
    if (options.getToken) {
      const token = options.getToken(req);
      if (token) {
        req.headers.authorization = `Bearer ${token}`;
      }
    }

    // Delegate to gateway
    gateway.handleRequest(req, res).catch(next);
  });

  return router;
}

/**
 * Get the Gateway instance from middleware for advanced use.
 * Useful for lifecycle management, events, etc.
 */
export function createTentickleGateway(gatewayConfig: TentickleExpressConfig): Gateway {
  return new Gateway({
    ...gatewayConfig,
    embedded: true,
  });
}

// Re-export gateway types for convenience
export {
  Gateway,
  method,
  type GatewayConfig,
  type MethodDefinition,
  type AuthConfig,
} from "@tentickle/gateway";
