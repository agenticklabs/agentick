/**
 * Logging Plugin
 *
 * Logs all HTTP traffic — method, path, status, duration — like morgan
 * for Express but for the agentick gateway. Uses the kernel's Logger
 * for structured, context-aware output.
 *
 * ## Limitation
 *
 * The gateway's PluginContext does not expose a request-level interceptor
 * (no `onRequest` hook, no wildcard routes, no HTTP middleware pipeline).
 * Plugins can only register exact path routes via `ctx.registerRoute()` or
 * subscribe to lifecycle events via `ctx.on()` — neither of which covers
 * arbitrary inbound HTTP traffic.
 *
 * This plugin therefore exports two things:
 *
 * 1. `loggingPlugin()` — A GatewayPlugin that logs gateway lifecycle events
 *    (client connects/disconnects, session creation, plugin registration).
 *    Useful for observability but does NOT log individual HTTP requests.
 *
 * 2. `loggingMiddleware()` — A standalone request wrapper for embedded mode.
 *    Wrap `gateway.handleRequest` with this to get morgan-style HTTP logging:
 *
 *    ```typescript
 *    const mw = loggingMiddleware();
 *    app.use("/api", (req, res, next) => {
 *      mw(req, res, () => gateway.handleRequest(req, res).catch(next));
 *    });
 *    ```
 *
 * When the gateway adds a request interceptor hook to PluginContext, this
 * plugin should be updated to use it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Logger, type KernelLogger, type LoggerConfig } from "@agentick/kernel";
import type { GatewayPlugin, PluginContext } from "../types.js";

// ============================================================================
// Types
// ============================================================================

export interface LoggingPluginConfig {
  /** Plugin ID (default: "logging") */
  id?: string;

  /**
   * Pre-configured kernel logger instance. When provided, this is used
   * directly — giving you full control over level, transport, and format.
   *
   * @example
   * ```typescript
   * // Custom level + transport
   * loggingPlugin({
   *   logger: Logger.create({
   *     level: 'debug',
   *     transport: { target: 'pino/file', options: { destination: './http.log' } },
   *   }),
   * });
   *
   * // Child of global logger with extra bindings
   * loggingPlugin({
   *   logger: Logger.child({ service: 'api-gateway' }),
   * });
   * ```
   */
  logger?: KernelLogger;

  /**
   * Logger configuration — creates a standalone logger with these settings.
   * Ignored when `logger` is provided. When neither `logger` nor
   * `loggerConfig` is set, falls back to `Logger.for(pluginId)`.
   *
   * @example
   * ```typescript
   * loggingPlugin({
   *   loggerConfig: { level: 'debug', prettyPrint: true },
   * });
   * ```
   */
  loggerConfig?: LoggerConfig;

  /** Skip logging for these path prefixes (middleware) or event categories (plugin) */
  exclude?: string[];
}

// ============================================================================
// Internal: resolve a KernelLogger from config
// ============================================================================

function resolveLogger(component: string, config?: LoggingPluginConfig): KernelLogger {
  if (config?.logger) return config.logger;
  if (config?.loggerConfig) return Logger.create(config.loggerConfig).child({ component });
  return Logger.for(component);
}

// ============================================================================
// Standalone middleware (for embedded mode)
// ============================================================================

/**
 * Creates a logging middleware that wraps request handling.
 * Logs method, path, status code, and response time in morgan 'dev' format.
 *
 * Uses the kernel Logger for structured output. Configure via `logger` or
 * `loggerConfig` on the config object.
 *
 * @example
 * ```typescript
 * // Default — uses Logger.for("HTTP")
 * const mw = loggingMiddleware();
 *
 * // Custom logger with debug level
 * const mw = loggingMiddleware({
 *   logger: Logger.create({ level: 'debug' }),
 *   exclude: ["/health"],
 * });
 *
 * // In your Express/Fastify/Node handler:
 * mw(req, res, () => gateway.handleRequest(req, res));
 * ```
 */
export function loggingMiddleware(
  config?: Pick<LoggingPluginConfig, "logger" | "loggerConfig" | "exclude">,
): (req: IncomingMessage, res: ServerResponse, next: () => void | Promise<void>) => void {
  const log = resolveLogger("HTTP", config as LoggingPluginConfig);
  const excludePrefixes = config?.exclude ?? [];

  return (req, res, next) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    // Skip excluded paths
    if (excludePrefixes.some((prefix) => path.startsWith(prefix))) {
      next();
      return;
    }

    const method = req.method ?? "GET";
    const start = Date.now();

    // Intercept response finish to capture status + duration
    const onFinish = () => {
      const duration = Date.now() - start;
      const status = res.statusCode;
      log.info({ method, path, status, duration }, `${method} ${path} ${status} ${duration}ms`);
      res.removeListener("finish", onFinish);
      res.removeListener("close", onFinish);
    };

    res.on("finish", onFinish);
    res.on("close", onFinish);

    next();
  };
}

// ============================================================================
// Gateway Plugin (lifecycle events only)
// ============================================================================

/**
 * Gateway plugin that logs lifecycle events.
 *
 * NOTE: This does NOT log individual HTTP requests — the PluginContext lacks
 * a request interceptor hook. Use `loggingMiddleware()` for HTTP logging.
 * See module docstring for details.
 *
 * @example
 * ```typescript
 * // Default — uses Logger.for("logging")
 * gateway.use(loggingPlugin());
 *
 * // Custom logger with specific transport
 * gateway.use(loggingPlugin({
 *   logger: Logger.create({
 *     level: 'debug',
 *     transport: { target: 'pino-pretty', options: { colorize: true } },
 *   }),
 * }));
 *
 * // Skip client events
 * gateway.use(loggingPlugin({ exclude: ["client"] }));
 * ```
 */
export function loggingPlugin(config?: LoggingPluginConfig): GatewayPlugin {
  const pluginId = config?.id ?? "logging";
  const excludePrefixes = config?.exclude ?? [];

  // Event handlers (stored for cleanup)
  const handlers: Array<{ event: any; handler: any }> = [];
  let pluginCtx: PluginContext;

  return {
    id: pluginId,

    async initialize(ctx: PluginContext) {
      pluginCtx = ctx;
      const log = resolveLogger(pluginId, config);

      const isExcluded = (category: string) => excludePrefixes.some((p) => category.startsWith(p));

      // Log lifecycle events that PluginContext exposes
      const onClientConnected = (payload: { clientId: string; ip?: string }) => {
        if (!isExcluded("client")) {
          log.info({ clientId: payload.clientId, ip: payload.ip }, "client:connected");
        }
      };

      const onClientDisconnected = (payload: { clientId: string; reason?: string }) => {
        if (!isExcluded("client")) {
          log.info({ clientId: payload.clientId, reason: payload.reason }, "client:disconnected");
        }
      };

      const onSessionCreated = (payload: { sessionId: string; appId: string }) => {
        if (!isExcluded("session")) {
          log.info({ sessionId: payload.sessionId, appId: payload.appId }, "session:created");
        }
      };

      const onSessionClosed = (payload: { sessionId: string }) => {
        if (!isExcluded("session")) {
          log.info({ sessionId: payload.sessionId }, "session:closed");
        }
      };

      const onPluginRegistered = (payload: { pluginId: string }) => {
        log.info({ registeredPluginId: payload.pluginId }, "plugin:registered");
      };

      const onPluginRemoved = (payload: { pluginId: string }) => {
        log.info({ removedPluginId: payload.pluginId }, "plugin:removed");
      };

      const onError = (error: Error) => {
        log.error({ err: error }, "gateway error");
      };

      ctx.on("client:connected", onClientConnected);
      ctx.on("client:disconnected", onClientDisconnected);
      ctx.on("session:created", onSessionCreated);
      ctx.on("session:closed", onSessionClosed);
      ctx.on("plugin:registered", onPluginRegistered);
      ctx.on("plugin:removed", onPluginRemoved);
      ctx.on("error", onError);

      handlers.push(
        { event: "client:connected", handler: onClientConnected },
        { event: "client:disconnected", handler: onClientDisconnected },
        { event: "session:created", handler: onSessionCreated },
        { event: "session:closed", handler: onSessionClosed },
        { event: "plugin:registered", handler: onPluginRegistered },
        { event: "plugin:removed", handler: onPluginRemoved },
        { event: "error", handler: onError },
      );
    },

    async destroy() {
      for (const { event, handler } of handlers) {
        pluginCtx.off(event, handler);
      }
      handlers.length = 0;
    },
  };
}
