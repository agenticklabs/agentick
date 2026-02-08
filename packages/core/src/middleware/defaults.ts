import { type Middleware, Context, Telemetry } from "@agentick/kernel";
import { type EngineError } from "../component/component";
import { classifyError, isRecoverableError } from "../utils/classify-error";

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
