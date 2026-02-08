import { isGuardError } from "@agentick/shared";

/**
 * Error categories for recovery decisions.
 *
 * Intentionally NOT `AgentickErrorCode` — categories drive recovery logic,
 * codes are structured error identity.
 */
export type ErrorCategory =
  | "NETWORK_ERROR"
  | "RATE_LIMIT_ERROR"
  | "GUARD_DENIED"
  | "AUTH_ERROR"
  | "VALIDATION_ERROR"
  | "TIMEOUT_ERROR"
  | "ABORT_ERROR"
  | "APPLICATION_ERROR"
  | "UNKNOWN_ERROR";

/**
 * Classify an error for recovery handling.
 *
 * Superset of all classification checks used across the codebase
 * (engine error middleware, tool executor, etc.).
 */
export function classifyError(error: any): ErrorCategory {
  if (!error) return "UNKNOWN_ERROR";

  // Network/timeout errors
  if (error.code === "ETIMEDOUT" || error.code === "ECONNRESET" || error.code === "ENOTFOUND") {
    return "NETWORK_ERROR";
  }

  // Rate limiting
  if (error.status === 429 || error.code === "RATE_LIMIT_EXCEEDED") {
    return "RATE_LIMIT_ERROR";
  }

  // Guard errors (from guardrails or access control)
  if (isGuardError(error)) {
    return "GUARD_DENIED";
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
export function isRecoverableError(error: any): boolean {
  const errorType = classifyError(error);

  // Network errors are usually recoverable
  if (errorType === "NETWORK_ERROR" || errorType === "TIMEOUT_ERROR") {
    return true;
  }

  // Rate limiting might be recoverable with backoff
  if (errorType === "RATE_LIMIT_ERROR") {
    return true;
  }

  // Guard errors are not recoverable (access denied)
  if (errorType === "GUARD_DENIED") {
    return false;
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
