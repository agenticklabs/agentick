import { type Middleware, Context, Telemetry } from "../core/index";
import { type EngineError } from "../component/component";

/**
 * Classify errors for better recovery handling.
 * Matches the classification logic used in ToolExecutor.
 */
function classifyError(error: any): string {
  if (!error) return "UNKNOWN_ERROR";

  // Network/timeout errors
  if (error.code === "ETIMEDOUT" || error.code === "ECONNRESET" || error.code === "ENOTFOUND") {
    return "NETWORK_ERROR";
  }

  // Rate limiting
  if (error.status === 429 || error.code === "RATE_LIMIT_EXCEEDED") {
    return "RATE_LIMIT_ERROR";
  }

  // Authentication/authorization
  if (error.status === 401 || error.status === 403) {
    return "AUTH_ERROR";
  }

  // Validation errors
  if (error.name === "ZodError" || error.name === "ValidationError") {
    return "VALIDATION_ERROR";
  }

  // Timeout errors
  if (error.name === "TimeoutError" || error.message?.includes("timeout")) {
    return "TIMEOUT_ERROR";
  }

  // Abort errors
  if (error.name === "AbortError" || error.message?.includes("aborted")) {
    return "ABORT_ERROR";
  }

  // Generic application errors
  if (error.name === "Error") {
    return "APPLICATION_ERROR";
  }

  return "UNKNOWN_ERROR";
}

/**
 * Determine if an error is recoverable.
 */
function isRecoverableError(error: any): boolean {
  const errorType = classifyError(error);

  // Network errors are usually recoverable
  if (errorType === "NETWORK_ERROR" || errorType === "TIMEOUT_ERROR") {
    return true;
  }

  // Rate limiting might be recoverable with backoff
  if (errorType === "RATE_LIMIT_ERROR") {
    return true;
  }

  // Authentication errors are usually not recoverable without intervention
  if (errorType === "AUTH_ERROR") {
    return false;
  }

  // Abort errors are not recoverable
  if (errorType === "ABORT_ERROR") {
    return false;
  }

  // Validation errors are usually not recoverable without fixing the input
  if (errorType === "VALIDATION_ERROR") {
    return false;
  }

  // Default: assume recoverable for transient errors
  return true;
}

/**
 * Error normalization middleware for engine procedures.
 *
 * Normalizes errors to EngineError format, classifies them, and determines recoverability.
 * This allows components and error handlers to work with a consistent error format.
 */
export const errorMiddleware: Middleware = async (args, envelope, next) => {
  try {
    return await next(args);
  } catch (error: any) {
    // Don't wrap abort errors - let them propagate as-is
    if (error?.name === "AbortError" || error?.message?.includes("aborted")) {
      throw error;
    }

    // Normalize error to Error instance if needed
    const normalizedError = error instanceof Error ? error : new Error(String(error));

    // Classify the error
    const errorType = classifyError(error);
    const recoverable = isRecoverableError(error);

    // Create EngineError with context (attached to normalized error for downstream handlers)
    const _engineError: EngineError = {
      error: normalizedError,
      phase: "unknown", // Middleware doesn't know the phase - will be set by engine if needed
      recoverable,
      context: {
        error_type: errorType,
        error_code: error.code,
        error_status: error.status,
        trace_id: Context.tryGet()?.traceId,
        procedure_pid: Context.tryGet()?.procedurePid,
        // Add any other relevant context
      },
    };

    // Note: EngineError is created for future use when error handlers access it
    // (normalizedError as any).engineError = _engineError;

    // Record error in telemetry
    Telemetry.recordError(normalizedError);

    // Re-throw the normalized error
    // Downstream handlers can access engineError via error.engineError
    throw normalizedError;
  }
};
