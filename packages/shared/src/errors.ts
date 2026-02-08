/**
 * Tentickle Error Hierarchy
 *
 * Structured error classes for consistent error handling across the framework.
 * All errors extend TentickleError which provides:
 * - Unique error codes for programmatic handling
 * - Rich metadata for debugging
 * - Serialization support for client/server communication
 * - Type guards for catching specific error types
 *
 * @example Throwing errors
 * ```typescript
 * throw new NotFoundError('model', 'gpt-4', 'Model not found in registry');
 * throw new ValidationError('messages', 'array', 'Messages must be an array');
 * throw new AbortError('User cancelled operation');
 * ```
 *
 * @example Catching specific errors
 * ```typescript
 * try {
 *   await engine.execute(input);
 * } catch (error) {
 *   if (isAbortError(error)) {
 *     // Handle cancellation
 *   } else if (isNotFoundError(error)) {
 *     // Handle missing resource
 *   } else if (isTentickleError(error)) {
 *     // Handle any Tentickle error
 *     console.log(error.code, error.toJSON());
 *   }
 * }
 * ```
 */

// =============================================================================
// Base Error
// =============================================================================

/**
 * Error codes for programmatic error handling.
 * Format: CATEGORY_SPECIFIC (e.g., ABORT_CANCELLED, NOT_FOUND_MODEL)
 */
export type TentickleErrorCode =
  // Abort/Cancellation
  | "ABORT_CANCELLED"
  | "ABORT_TIMEOUT"
  | "ABORT_SIGNAL"
  // Not Found
  | "NOT_FOUND_MODEL"
  | "NOT_FOUND_TOOL"
  | "NOT_FOUND_AGENT"
  | "NOT_FOUND_EXECUTION"
  | "NOT_FOUND_RESOURCE"
  // Validation
  | "VALIDATION_REQUIRED"
  | "VALIDATION_TYPE"
  | "VALIDATION_FORMAT"
  | "VALIDATION_CONSTRAINT"
  // State/Lifecycle
  | "STATE_INVALID"
  | "STATE_TRANSITION"
  | "STATE_NOT_READY"
  | "STATE_ALREADY_COMPLETE"
  // Transport/Network
  | "TRANSPORT_TIMEOUT"
  | "TRANSPORT_CONNECTION"
  | "TRANSPORT_RESPONSE"
  | "TRANSPORT_PARSE"
  // Adapter/Provider
  | "ADAPTER_RESPONSE"
  | "ADAPTER_RATE_LIMIT"
  | "ADAPTER_AUTH"
  | "ADAPTER_CONTENT_FILTER"
  | "ADAPTER_CONTEXT_LENGTH"
  // Context
  | "CONTEXT_NOT_FOUND"
  | "CONTEXT_INVALID"
  // Guard/Access Control
  | "GUARD_DENIED"
  // Reactivity
  | "REACTIVITY_CIRCULAR"
  | "REACTIVITY_DISPOSED";

/**
 * Serialized error format for transport
 */
export interface SerializedTentickleError {
  name: string;
  code: TentickleErrorCode;
  message: string;
  details?: Record<string, unknown>;
  cause?: SerializedTentickleError | { message: string; name?: string };
  stack?: string;
}

/**
 * Base class for all Tentickle errors.
 * Provides consistent structure, serialization, and type identification.
 */
export class TentickleError extends Error {
  /** Unique error code for programmatic handling */
  readonly code: TentickleErrorCode;

  /** Additional error details */
  readonly details: Record<string, unknown>;

  /** Original error that caused this error */
  readonly cause?: Error;

  constructor(
    code: TentickleErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    cause?: Error,
  ) {
    super(message);
    this.name = "TentickleError";
    this.code = code;
    this.details = details;
    this.cause = cause;

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, new.target.prototype);

    // Capture stack trace (V8 engines - Node.js specific)
    const ErrorWithCapture = Error as typeof Error & {
      captureStackTrace?: (target: object, constructor?: Function) => void;
    };
    if (typeof ErrorWithCapture.captureStackTrace === "function") {
      ErrorWithCapture.captureStackTrace(this, new.target);
    }
  }

  /**
   * Serialize error for transport (JSON-safe)
   */
  toJSON(): SerializedTentickleError {
    const serialized: SerializedTentickleError = {
      name: this.name,
      code: this.code,
      message: this.message,
    };

    if (Object.keys(this.details).length > 0) {
      serialized.details = this.details;
    }

    if (this.cause) {
      if (this.cause instanceof TentickleError) {
        serialized.cause = this.cause.toJSON();
      } else if (this.cause instanceof Error) {
        serialized.cause = {
          message: this.cause.message,
          name: this.cause.name,
        };
      }
    }

    if (this.stack) {
      serialized.stack = this.stack;
    }

    return serialized;
  }

  /**
   * Create error from serialized format
   */
  static fromJSON(json: SerializedTentickleError): TentickleError {
    const cause = json.cause
      ? (json.cause as SerializedTentickleError).code
        ? TentickleError.fromJSON(json.cause as SerializedTentickleError)
        : new Error((json.cause as { message: string }).message)
      : undefined;

    return new TentickleError(json.code, json.message, json.details, cause);
  }
}

// =============================================================================
// Abort/Cancellation Errors
// =============================================================================

/**
 * Error thrown when an operation is aborted or cancelled.
 *
 * @example
 * ```typescript
 * throw new AbortError('User cancelled the operation');
 * throw new AbortError('Operation timed out', 'ABORT_TIMEOUT', { timeoutMs: 30000 });
 * ```
 */
export class AbortError extends TentickleError {
  constructor(
    message: string = "Operation aborted",
    code: "ABORT_CANCELLED" | "ABORT_TIMEOUT" | "ABORT_SIGNAL" = "ABORT_CANCELLED",
    details: Record<string, unknown> = {},
    cause?: Error,
  ) {
    super(code, message, details, cause);
    this.name = "AbortError";
  }

  /**
   * Create from an AbortSignal's reason
   */
  static fromSignal(signal: AbortSignal): AbortError {
    const reason = signal.reason;
    if (reason instanceof AbortError) {
      return reason;
    }
    const message =
      reason instanceof Error ? reason.message : String(reason || "Operation aborted");
    return new AbortError(
      message,
      "ABORT_SIGNAL",
      {},
      reason instanceof Error ? reason : undefined,
    );
  }

  /**
   * Create a timeout abort error
   */
  static timeout(timeoutMs: number): AbortError {
    return new AbortError(`Operation timed out after ${timeoutMs}ms`, "ABORT_TIMEOUT", {
      timeoutMs,
    });
  }
}

// =============================================================================
// Not Found Errors
// =============================================================================

/**
 * Resource types that can be "not found"
 */
export type ResourceType =
  | "model"
  | "tool"
  | "agent"
  | "execution"
  | "channel"
  | "session"
  | "procedure"
  | "mcp-client"
  | "scope"
  | "resource";

/**
 * Error thrown when a required resource cannot be found.
 *
 * @example
 * ```typescript
 * throw new NotFoundError('model', 'gpt-4');
 * throw new NotFoundError('tool', 'search', 'Tool not found in registry');
 * throw new NotFoundError('execution', 'exec-123', 'Parent execution not found');
 * ```
 */
export class NotFoundError extends TentickleError {
  /** Type of resource that was not found */
  readonly resourceType: ResourceType;

  /** Identifier of the resource */
  readonly resourceId: string;

  constructor(resourceType: ResourceType, resourceId: string, message?: string, cause?: Error) {
    const codeMap: Record<ResourceType, TentickleErrorCode> = {
      model: "NOT_FOUND_MODEL",
      tool: "NOT_FOUND_TOOL",
      agent: "NOT_FOUND_AGENT",
      execution: "NOT_FOUND_EXECUTION",
      channel: "NOT_FOUND_RESOURCE",
      session: "NOT_FOUND_RESOURCE",
      procedure: "NOT_FOUND_RESOURCE",
      "mcp-client": "NOT_FOUND_RESOURCE",
      scope: "NOT_FOUND_RESOURCE",
      resource: "NOT_FOUND_RESOURCE",
    };

    super(
      codeMap[resourceType],
      message || `${resourceType} '${resourceId}' not found`,
      { resourceType, resourceId },
      cause,
    );
    this.name = "NotFoundError";
    this.resourceType = resourceType;
    this.resourceId = resourceId;
  }
}

// =============================================================================
// Validation Errors
// =============================================================================

/**
 * Error thrown when input validation fails.
 *
 * @example
 * ```typescript
 * throw new ValidationError('messages', 'Messages are required');
 * throw new ValidationError('handler', 'Handler function required', { expected: 'function' });
 * throw new ValidationError('input.model', 'Model identifier must be provided');
 * ```
 */
export class ValidationError extends TentickleError {
  /** Field or parameter that failed validation */
  readonly field: string;

  /** Expected type or format (optional) */
  readonly expected?: string;

  /** Actual value received (optional) */
  readonly received?: string;

  constructor(
    field: string,
    message: string,
    options: {
      expected?: string;
      received?: string;
      code?:
        | "VALIDATION_REQUIRED"
        | "VALIDATION_TYPE"
        | "VALIDATION_FORMAT"
        | "VALIDATION_CONSTRAINT";
    } = {},
    cause?: Error,
  ) {
    const code = options.code || "VALIDATION_REQUIRED";

    super(
      code,
      message,
      {
        field,
        ...(options.expected && { expected: options.expected }),
        ...(options.received && { received: options.received }),
      },
      cause,
    );
    this.name = "ValidationError";
    this.field = field;
    this.expected = options.expected;
    this.received = options.received;
  }

  /**
   * Create a "required" validation error
   */
  static required(field: string, message?: string): ValidationError {
    return new ValidationError(field, message || `${field} is required`, {
      code: "VALIDATION_REQUIRED",
    });
  }

  /**
   * Create a "type mismatch" validation error
   */
  static type(field: string, expected: string, received?: string): ValidationError {
    const msg = received
      ? `${field} must be ${expected}, received ${received}`
      : `${field} must be ${expected}`;
    return new ValidationError(field, msg, {
      expected,
      received,
      code: "VALIDATION_TYPE",
    });
  }
}

// =============================================================================
// State/Lifecycle Errors
// =============================================================================

/**
 * Error thrown when an operation is attempted in an invalid state.
 *
 * @example
 * ```typescript
 * throw new StateError('streaming', 'completed', 'Cannot send message to completed execution');
 * throw new StateError('initializing', 'ready', 'Engine is still initializing');
 * ```
 */
export class StateError extends TentickleError {
  /** Current state */
  readonly current: string;

  /** Expected/required state (optional) */
  readonly expectedState?: string;

  constructor(
    current: string,
    expectedState: string | undefined,
    message: string,
    code:
      | "STATE_INVALID"
      | "STATE_TRANSITION"
      | "STATE_NOT_READY"
      | "STATE_ALREADY_COMPLETE" = "STATE_INVALID",
    cause?: Error,
  ) {
    super(code, message, { current, ...(expectedState && { expectedState }) }, cause);
    this.name = "StateError";
    this.current = current;
    this.expectedState = expectedState;
  }

  /**
   * Create error for "not ready" state
   */
  static notReady(component: string, current: string): StateError {
    return new StateError(
      current,
      "ready",
      `${component} is not ready (current state: ${current})`,
      "STATE_NOT_READY",
    );
  }

  /**
   * Create error for "already complete" state
   */
  static alreadyComplete(operation: string): StateError {
    return new StateError(
      "complete",
      undefined,
      `Cannot ${operation}: already complete`,
      "STATE_ALREADY_COMPLETE",
    );
  }
}

// =============================================================================
// Transport/Network Errors
// =============================================================================

/**
 * Error thrown for network/transport failures.
 *
 * @example
 * ```typescript
 * throw new TransportError('timeout', 'Request timed out after 30000ms');
 * throw new TransportError('connection', 'SSE connection error');
 * throw new TransportError('response', 'No response body');
 * ```
 */
export class TransportError extends TentickleError {
  /** Type of transport error */
  readonly transportCode: "timeout" | "connection" | "response" | "parse";

  /** HTTP status code if applicable */
  readonly statusCode?: number;

  constructor(
    transportCode: "timeout" | "connection" | "response" | "parse",
    message: string,
    options: {
      statusCode?: number;
      url?: string;
      method?: string;
    } = {},
    cause?: Error,
  ) {
    const codeMap = {
      timeout: "TRANSPORT_TIMEOUT",
      connection: "TRANSPORT_CONNECTION",
      response: "TRANSPORT_RESPONSE",
      parse: "TRANSPORT_PARSE",
    } as const;

    super(
      codeMap[transportCode],
      message,
      {
        transportCode,
        ...(options.statusCode && { statusCode: options.statusCode }),
        ...(options.url && { url: options.url }),
        ...(options.method && { method: options.method }),
      },
      cause,
    );
    this.name = "TransportError";
    this.transportCode = transportCode;
    this.statusCode = options.statusCode;
  }

  /**
   * Create a timeout error
   */
  static timeout(timeoutMs: number, url?: string): TransportError {
    return new TransportError("timeout", `Request timeout after ${timeoutMs}ms`, { url });
  }

  /**
   * Create a connection error
   */
  static connection(message: string, url?: string, cause?: Error): TransportError {
    return new TransportError("connection", message, { url }, cause);
  }

  /**
   * Create an HTTP error (non-2xx response)
   */
  static http(statusCode: number, url: string, message?: string): TransportError {
    return new TransportError("response", message || `HTTP ${statusCode}`, {
      statusCode,
      url,
    });
  }
}

// =============================================================================
// Adapter/Provider Errors
// =============================================================================

/**
 * Error thrown by model adapters for provider-specific errors.
 *
 * @example
 * ```typescript
 * throw new AdapterError('openai', 'No message in response', 'ADAPTER_RESPONSE');
 * throw new AdapterError('google', 'Rate limit exceeded', 'ADAPTER_RATE_LIMIT', { retryAfter: 60 });
 * throw new AdapterError('anthropic', 'Content blocked', 'ADAPTER_CONTENT_FILTER');
 * ```
 */
export class AdapterError extends TentickleError {
  /** Provider name (openai, google, anthropic, etc.) */
  readonly provider: string;

  /** Provider-specific error code */
  readonly providerErrorCode?: string;

  constructor(
    provider: string,
    message: string,
    code:
      | "ADAPTER_RESPONSE"
      | "ADAPTER_RATE_LIMIT"
      | "ADAPTER_AUTH"
      | "ADAPTER_CONTENT_FILTER"
      | "ADAPTER_CONTEXT_LENGTH" = "ADAPTER_RESPONSE",
    details: Record<string, unknown> = {},
    cause?: Error,
  ) {
    super(code, message, { provider, ...details }, cause);
    this.name = "AdapterError";
    this.provider = provider;
    this.providerErrorCode = details["providerErrorCode"] as string | undefined;
  }

  /**
   * Create a rate limit error
   */
  static rateLimit(provider: string, retryAfter?: number): AdapterError {
    return new AdapterError(
      provider,
      retryAfter ? `Rate limit exceeded. Retry after ${retryAfter}s` : "Rate limit exceeded",
      "ADAPTER_RATE_LIMIT",
      { retryAfter },
    );
  }

  /**
   * Create a content filter error
   */
  static contentFiltered(provider: string, reason?: string): AdapterError {
    return new AdapterError(
      provider,
      reason || "Content was filtered by provider",
      "ADAPTER_CONTENT_FILTER",
      { reason },
    );
  }

  /**
   * Create a context length error
   */
  static contextLength(
    provider: string,
    maxTokens: number,
    requestedTokens?: number,
  ): AdapterError {
    return new AdapterError(
      provider,
      `Context length exceeded. Max: ${maxTokens}${requestedTokens ? `, Requested: ${requestedTokens}` : ""}`,
      "ADAPTER_CONTEXT_LENGTH",
      { maxTokens, requestedTokens },
    );
  }
}

// =============================================================================
// Context Errors
// =============================================================================

/**
 * Error thrown when context is missing or invalid.
 *
 * @example
 * ```typescript
 * throw new ContextError('Context not found. Ensure you are running within Context.run()');
 * throw new ContextError('Invalid context: missing required field', 'CONTEXT_INVALID');
 * ```
 */
export class ContextError extends TentickleError {
  constructor(
    message: string,
    code: "CONTEXT_NOT_FOUND" | "CONTEXT_INVALID" = "CONTEXT_NOT_FOUND",
    details: Record<string, unknown> = {},
    cause?: Error,
  ) {
    super(code, message, details, cause);
    this.name = "ContextError";
  }

  /**
   * Create "context not found" error with helpful message
   */
  static notFound(): ContextError {
    return new ContextError(
      "Context not found. Ensure you are running within a Context.run() block or using a Kernel Procedure.",
      "CONTEXT_NOT_FOUND",
    );
  }
}

// =============================================================================
// Reactivity Errors
// =============================================================================

/**
 * Error thrown for reactivity/signal system issues.
 *
 * @example
 * ```typescript
 * throw new ReactivityError('Circular dependency detected in computed signal');
 * throw new ReactivityError('Attempted to set disposed signal', 'REACTIVITY_DISPOSED');
 * ```
 */
export class ReactivityError extends TentickleError {
  constructor(
    message: string,
    code: "REACTIVITY_CIRCULAR" | "REACTIVITY_DISPOSED" = "REACTIVITY_CIRCULAR",
    details: Record<string, unknown> = {},
    cause?: Error,
  ) {
    super(code, message, details, cause);
    this.name = "ReactivityError";
  }

  /**
   * Create circular dependency error
   */
  static circular(signalName?: string): ReactivityError {
    return new ReactivityError(
      signalName
        ? `Circular dependency detected in computed signal '${signalName}'`
        : "Circular dependency detected in computed signal",
      "REACTIVITY_CIRCULAR",
      { signalName },
    );
  }
}

// =============================================================================
// Guard/Access Control Errors
// =============================================================================

/**
 * Error thrown when a guard denies access to a procedure or resource.
 *
 * @example
 * ```typescript
 * throw GuardError.role(['admin', 'moderator']);
 * throw GuardError.denied('Insufficient permissions', { resource: 'settings' });
 * ```
 */
export class GuardError extends TentickleError {
  /** Type of guard that denied access */
  readonly guardType?: string;

  constructor(
    message: string,
    guardType?: string,
    details: Record<string, unknown> = {},
    cause?: Error,
  ) {
    super("GUARD_DENIED", message, { ...details, ...(guardType && { guardType }) }, cause);
    this.name = "GuardError";
    this.guardType = guardType;
  }

  /**
   * Create a role-based guard error
   */
  static role(roles: string[]): GuardError {
    return new GuardError(`Requires one of roles [${roles.join(", ")}]`, "role", { roles });
  }

  /**
   * Create a custom guard denied error
   */
  static denied(reason: string, details?: Record<string, unknown>): GuardError {
    return new GuardError(reason, "custom", details);
  }
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if error is any Tentickle error
 */
export function isTentickleError(error: unknown): error is TentickleError {
  return error instanceof TentickleError;
}

/**
 * Check if error is an AbortError
 */
export function isAbortError(error: unknown): error is AbortError {
  return error instanceof AbortError;
}

/**
 * Check if error is a NotFoundError
 */
export function isNotFoundError(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError;
}

/**
 * Check if error is a ValidationError
 */
export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

/**
 * Check if error is a StateError
 */
export function isStateError(error: unknown): error is StateError {
  return error instanceof StateError;
}

/**
 * Check if error is a TransportError
 */
export function isTransportError(error: unknown): error is TransportError {
  return error instanceof TransportError;
}

/**
 * Check if error is an AdapterError
 */
export function isAdapterError(error: unknown): error is AdapterError {
  return error instanceof AdapterError;
}

/**
 * Check if error is a ContextError
 */
export function isContextError(error: unknown): error is ContextError {
  return error instanceof ContextError;
}

/**
 * Check if error is a ReactivityError
 */
export function isReactivityError(error: unknown): error is ReactivityError {
  return error instanceof ReactivityError;
}

/**
 * Check if error is a GuardError
 */
export function isGuardError(error: unknown): error is GuardError {
  return error instanceof GuardError;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Ensure a value is an Error, wrapping if necessary.
 * Useful for catch blocks that might receive non-Error values.
 */
export function ensureError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value));
}

/**
 * Wrap any error as an Tentickle error if it isn't already.
 */
export function wrapAsTentickleError(
  error: unknown,
  defaultCode: TentickleErrorCode = "STATE_INVALID",
): TentickleError {
  if (error instanceof TentickleError) {
    return error;
  }
  const err = ensureError(error);
  return new TentickleError(defaultCode, err.message, {}, err);
}
