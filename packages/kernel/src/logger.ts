/**
 * Logger - Structured logging with automatic context injection
 *
 * Built on pino for performance, with automatic injection of:
 * - Execution context (executionId, threadId, userId, tick)
 * - OpenTelemetry trace/span IDs for log-trace correlation
 * - Custom metadata
 *
 * @example
 * ```typescript
 * import { Logger } from './core';
 *
 * // Configure once at app start
 * Logger.configure({
 *   level: 'info',
 *   transport: {
 *     targets: [
 *       { target: 'pino-pretty', options: { colorize: true } },
 *       { target: 'pino/file', options: { destination: './app.log' } },
 *     ],
 *   },
 * });
 *
 * // Use anywhere - context is auto-injected
 * const log = Logger.get();
 * log.info('Processing request');
 *
 * // Create scoped child logger
 * const toolLog = Logger.for('CalculatorTool');
 * toolLog.debug('Executing', { expression: '2+2' });
 * ```
 */

import pino, {
  type Logger as PinoLogger,
  type LoggerOptions,
  type TransportSingleOptions,
  type TransportMultiOptions,
} from "pino";
import { Context, type KernelContext } from "./context";

// =============================================================================
// Types
// =============================================================================

/**
 * Log levels supported by the kernel logger.
 *
 * Levels in order of severity (least to most):
 * - `trace` - Very detailed debugging information
 * - `debug` - Debugging information
 * - `info` - Normal operational messages
 * - `warn` - Warning conditions
 * - `error` - Error conditions
 * - `fatal` - Severe errors causing shutdown
 * - `silent` - Disable all logging
 *
 * @example
 * ```typescript
 * Logger.configure({ level: 'debug' });
 * Logger.setLevel('warn'); // Runtime change
 * if (Logger.isLevelEnabled('trace')) {
 *   // Expensive debug operation
 * }
 * ```
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

/**
 * Function to extract fields from KernelContext for logging.
 * Return an object with fields to include in every log entry.
 *
 * @typeParam TContext - The context type (extends KernelContext)
 *
 * @example
 * ```typescript
 * const myExtractor: ContextFieldsExtractor = (ctx) => ({
 *   userId: ctx.user?.id,
 *   tenantId: ctx.user?.tenantId,
 *   requestId: ctx.requestId,
 * });
 * ```
 *
 * @see {@link composeContextFields} - Combine multiple extractors
 */
export type ContextFieldsExtractor<TContext extends KernelContext = KernelContext> = (
  ctx: TContext,
) => Record<string, unknown>;

export interface LoggerConfig<TContext extends KernelContext = KernelContext> {
  /** Log level (default: 'info') */
  level?: LogLevel;
  /** Pino transport configuration */
  transport?: TransportSingleOptions | TransportMultiOptions;
  /** Auto-inject execution context into every log (default: true) */
  includeContext?: boolean;
  /**
   * Custom function to extract fields from context.
   * If not provided, only core KernelContext fields are extracted.
   * Use this to add application-specific fields from user/metadata.
   *
   * @example
   * ```typescript
   * Logger.configure({
   *   contextFields: (ctx) => ({
   *     // Core fields (you control what's included)
   *     request_id: ctx.requestId,
   *     trace_id: ctx.traceId,
   *     // Your custom fields
   *     tenantId: ctx.user?.tenantId,
   *     threadId: ctx.metadata?.threadId,
   *   }),
   * });
   * ```
   */
  contextFields?: ContextFieldsExtractor<TContext>;
  /** Base properties to include in every log */
  base?: Record<string, unknown>;
  /** Custom mixin function for additional properties */
  mixin?: () => Record<string, unknown>;
  /** Pretty print in development (default: true if NODE_ENV !== 'production') */
  prettyPrint?: boolean;
  /**
   * Replace existing config instead of merging (default: false).
   * When true, completely replaces the existing configuration.
   * When false (default), merges with existing configuration.
   */
  replace?: boolean;
}

/**
 * Log method signature supporting both message-first and object-first forms.
 *
 * @example Message-first (simple logging)
 * ```typescript
 * log.info('User logged in');
 * log.info('Processed %d items', count);
 * ```
 *
 * @example Object-first (structured logging)
 * ```typescript
 * log.info({ userId, action: 'login' }, 'User logged in');
 * log.error({ err, requestId }, 'Request failed');
 * ```
 */
export interface LogMethod {
  /** Log a message with optional printf-style args */
  (msg: string, ...args: unknown[]): void;
  /** Log structured data with optional message */
  (obj: Record<string, unknown>, msg?: string, ...args: unknown[]): void;
}

/**
 * Kernel logger interface with structured logging and context injection.
 *
 * Loggers automatically inject execution context (requestId, traceId, etc.)
 * from the current `KernelContext` via AsyncLocalStorage.
 *
 * @example
 * ```typescript
 * const log = Logger.get();
 *
 * // Simple message
 * log.info('Request received');
 *
 * // With structured data
 * log.debug({ userId, action }, 'Processing action');
 *
 * // Create child logger with bindings
 * const reqLog = log.child({ requestId: 'abc-123' });
 *
 * // Check level before expensive operation
 * if (log.isLevelEnabled('trace')) {
 *   log.trace({ fullState: getState() }, 'State dump');
 * }
 * ```
 *
 * @see {@link Logger} - Static methods to get/configure loggers
 * @see {@link LogLevel} - Available log levels
 */
export interface KernelLogger {
  /** Log at trace level (very detailed debugging) */
  trace: LogMethod;
  /** Log at debug level (debugging information) */
  debug: LogMethod;
  /** Log at info level (normal operations) */
  info: LogMethod;
  /** Log at warn level (warning conditions) */
  warn: LogMethod;
  /** Log at error level (error conditions) */
  error: LogMethod;
  /** Log at fatal level (severe errors) */
  fatal: LogMethod;

  /** Create a child logger with additional bindings */
  child(bindings: Record<string, unknown>): KernelLogger;

  /** Get the current log level */
  level: LogLevel;

  /** Check if a level is enabled */
  isLevelEnabled(level: LogLevel): boolean;
}

// =============================================================================
// Implementation
// =============================================================================

let globalLogger: PinoLogger | null = null;
let globalConfig: LoggerConfig = {};

/**
 * Default context fields extractor.
 * Only extracts well-defined KernelContext properties.
 * Does NOT make assumptions about user/metadata structure.
 */
const defaultContextFieldsExtractor: ContextFieldsExtractor = (ctx) => {
  const fields: Record<string, unknown> = {};

  // Core KernelContext fields (well-defined)
  if (ctx.requestId) fields.request_id = ctx.requestId;
  if (ctx.traceId) fields.trace_id = ctx.traceId;

  // Procedure context (well-defined)
  if (ctx.procedurePid) fields.procedure_id = ctx.procedurePid;
  if (ctx.procedureNode?.name) fields.procedure_name = ctx.procedureNode.name;
  if (ctx.origin?.name) fields.origin_procedure = ctx.origin.name;

  return fields;
};

/**
 * Extract context fields for logging.
 * Called on every log to inject current execution context.
 */
function getContextFields(config: LoggerConfig): Record<string, unknown> {
  if (config.includeContext === false) {
    return {};
  }

  const ctx = Context.tryGet();
  if (!ctx) {
    return {};
  }

  // Use custom extractor or default
  const extractor = config.contextFields ?? defaultContextFieldsExtractor;
  return extractor(ctx);
}

/**
 * Create pino logger options from config.
 */
function createPinoOptions(config: LoggerConfig): LoggerOptions {
  const isDev = process.env.NODE_ENV !== "production";
  const usePretty = config.prettyPrint ?? isDev;

  const options: LoggerOptions = {
    level: config.level ?? "info",
    base: config.base ?? { pid: process.pid },

    // Mixin runs on every log to inject context
    mixin: () => {
      const contextFields = getContextFields(config);
      const customFields = config.mixin?.() ?? {};
      return { ...contextFields, ...customFields };
    },

    // Timestamp in ISO format
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  // Transport configuration
  if (config.transport) {
    options.transport = config.transport;
  } else if (usePretty) {
    options.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    };
  }

  return options;
}

/**
 * Wrap pino logger to match KernelLogger interface.
 */
function wrapLogger(pinoLogger: PinoLogger): KernelLogger {
  return {
    trace: pinoLogger.trace.bind(pinoLogger),
    debug: pinoLogger.debug.bind(pinoLogger),
    info: pinoLogger.info.bind(pinoLogger),
    warn: pinoLogger.warn.bind(pinoLogger),
    error: pinoLogger.error.bind(pinoLogger),
    fatal: pinoLogger.fatal.bind(pinoLogger),

    child(bindings: Record<string, unknown>): KernelLogger {
      return wrapLogger(pinoLogger.child(bindings));
    },

    get level(): LogLevel {
      return pinoLogger.level as LogLevel;
    },

    isLevelEnabled(level: LogLevel): boolean {
      return pinoLogger.isLevelEnabled(level);
    },
  };
}

/**
 * Get or create the global logger instance.
 */
function getOrCreateGlobalLogger(): PinoLogger {
  if (!globalLogger) {
    globalLogger = pino(createPinoOptions(globalConfig));
  }
  return globalLogger;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Logger singleton for Agentick applications.
 *
 * Provides structured logging with automatic context injection from the
 * current execution context (via AsyncLocalStorage).
 *
 * @example
 * ```typescript
 * // Configure at app startup
 * Logger.configure({ level: 'debug' });
 *
 * // Get logger (context auto-injected)
 * const log = Logger.get();
 * log.info('Request received');
 *
 * // Create child logger for a component
 * const componentLog = Logger.for('MyComponent');
 * componentLog.debug('Initializing');
 *
 * // Or from an object (uses constructor name)
 * class MyTool {
 *   private log = Logger.for(this);
 * }
 * ```
 */
export const Logger = {
  /**
   * Configure the global logger.
   * Should be called once at application startup.
   *
   * @param config Logger configuration
   *
   * @example
   * ```typescript
   * Logger.configure({
   *   level: process.env.LOG_LEVEL ?? 'info',
   *   transport: {
   *     targets: [
   *       { target: 'pino-pretty', options: { colorize: true } },
   *       { target: 'pino/file', options: { destination: './logs/app.log' } },
   *     ],
   *   },
   * });
   * ```
   */
  configure(config: LoggerConfig): void {
    // Replace or merge with existing config
    if (config.replace) {
      globalConfig = config;
    } else {
      globalConfig = { ...globalConfig, ...config };
    }

    // Handle contextFields composition
    if (config.contextFields) {
      globalConfig.contextFields = composeContextFields(defaultContextFields, config.contextFields);
    } else if (!globalConfig.contextFields) {
      globalConfig.contextFields = defaultContextFields;
    }

    globalLogger = pino(createPinoOptions(globalConfig));
  },

  /**
   * Get the global logger instance.
   * Context is automatically injected into every log.
   *
   * @returns KernelLogger instance
   *
   * @example
   * ```typescript
   * const log = Logger.get();
   * log.info('Processing', { items: 5 });
   * // Output includes executionId, userId, trace_id, etc.
   * ```
   */
  get(): KernelLogger {
    return wrapLogger(getOrCreateGlobalLogger());
  },

  /**
   * Create a child logger scoped to a component or name.
   *
   * @param nameOrComponent Component name or object (uses constructor.name)
   * @returns Child logger with component binding
   *
   * @example
   * ```typescript
   * // With string name
   * const log = Logger.for('CalculatorTool');
   *
   * // With object (uses class name)
   * class MyAgent {
   *   private log = Logger.for(this);
   * }
   * ```
   */
  for(nameOrComponent: string | object): KernelLogger {
    const name =
      typeof nameOrComponent === "string" ? nameOrComponent : nameOrComponent.constructor.name;
    return wrapLogger(getOrCreateGlobalLogger().child({ component: name }));
  },

  /**
   * Create a child logger with custom bindings.
   *
   * @param bindings Key-value pairs to include in every log
   * @returns Child logger with bindings
   *
   * @example
   * ```typescript
   * const requestLog = Logger.child({ request_id: req.id });
   * requestLog.info('Handling request');
   * ```
   */
  child(bindings: Record<string, unknown>): KernelLogger {
    return wrapLogger(getOrCreateGlobalLogger().child(bindings));
  },

  /**
   * Create a standalone logger instance with custom config.
   * Does not affect the global logger.
   *
   * @param config Logger configuration
   * @returns New logger instance
   *
   * @example
   * ```typescript
   * const auditLog = Logger.create({
   *   level: 'info',
   *   transport: { target: 'pino/file', options: { destination: './audit.log' } },
   * });
   * ```
   */
  create(config: LoggerConfig = {}): KernelLogger {
    return wrapLogger(pino(createPinoOptions(config)));
  },

  /**
   * Get the current log level.
   */
  get level(): LogLevel {
    return getOrCreateGlobalLogger().level as LogLevel;
  },

  /**
   * Set the log level at runtime.
   *
   * @param level New log level
   */
  setLevel(level: LogLevel): void {
    getOrCreateGlobalLogger().level = level;
  },

  /**
   * Check if a level is enabled.
   *
   * @param level Log level to check
   * @returns true if the level is enabled
   */
  isLevelEnabled(level: LogLevel): boolean {
    return getOrCreateGlobalLogger().isLevelEnabled(level);
  },

  /**
   * Reset the global logger (mainly for testing).
   */
  reset(): void {
    globalLogger = null;
    globalConfig = {};
  },
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Compose multiple context field extractors into one.
 * Later extractors override earlier ones for the same keys.
 *
 * @example
 * ```typescript
 * import { composeContextFields, defaultContextFields } from './core';
 *
 * Logger.configure({
 *   contextFields: composeContextFields(
 *     defaultContextFields,  // Core kernel fields
 *     (ctx) => ({            // Your custom fields
 *       tenantId: ctx.user?.tenantId,
 *       threadId: ctx.metadata?.threadId,
 *       executionId: ctx.metadata?.executionId,
 *     }),
 *   ),
 * });
 * ```
 */
export function composeContextFields(
  ...extractors: ContextFieldsExtractor[]
): ContextFieldsExtractor {
  return (ctx) => {
    const result: Record<string, unknown> = {};
    for (const extractor of extractors) {
      Object.assign(result, extractor(ctx));
    }
    return result;
  };
}

/**
 * The default context fields extractor.
 * Exports core KernelContext fields only.
 * Use with composeContextFields to extend.
 */
export const defaultContextFields = defaultContextFieldsExtractor;

// Re-export types
export type { PinoLogger, TransportSingleOptions, TransportMultiOptions };
