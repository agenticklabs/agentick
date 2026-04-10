import type {
  MCPRequestContext,
  OperationInfo,
  MCPHandlerExtra,
  MCPServerOptions,
} from "../../protocol/types.js";
import { sanitizeErrorMessage } from "../../protocol/errors.js";
import type { ResolvedSecurity } from "./defaults.js";

// ============================================================================
// Pipeline Error Types
// ============================================================================

/** Thrown when a security check rejects a request. */
export class SecurityError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SecurityError";
  }
}

// ============================================================================
// Connection Pipeline
// ============================================================================

/**
 * Evaluate the connection guard. Returns true if allowed, throws SecurityError if rejected.
 * Not invoked for in-process or stdio transports (trusted by definition).
 */
export async function evaluateConnectionGuard(
  security: ResolvedSecurity,
  info: import("../../protocol/types.js").ConnectionInfo,
): Promise<boolean> {
  // Trusted transports skip the guard entirely
  if (info.transport === "in-process" || info.transport === "stdio") {
    return true;
  }

  const allowed = await security.connectionGuard(info);
  if (!allowed) {
    throw new SecurityError(
      403,
      `Connection rejected from ${info.origin ?? info.remoteAddress ?? "unknown"}`,
    );
  }
  return true;
}

// ============================================================================
// Request Pipeline
// ============================================================================

/**
 * Build the request context from the SDK's RequestHandlerExtra.
 * Uses the consumer's contextProvider if configured, otherwise returns a minimal context.
 */
export async function buildRequestContext(
  extra: MCPHandlerExtra,
  contextProvider?: MCPServerOptions["contextProvider"],
): Promise<MCPRequestContext> {
  if (contextProvider) {
    return contextProvider(extra);
  }
  return {
    signal: extra.signal,
  };
}

/**
 * Run the full request-level security pipeline.
 * Order: authenticator → authorizer → rateLimiter → inputSanitizer
 *
 * Throws SecurityError on rejection at any stage.
 * Returns sanitized input (for tool calls) or undefined (for non-tool operations).
 */
export async function evaluateRequestPipeline(
  security: ResolvedSecurity,
  ctx: MCPRequestContext,
  operation: OperationInfo,
  toolInput?: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  // 1. Authenticate
  const authn = await security.authenticator(ctx);
  if (!authn.authenticated) {
    throw new SecurityError(401, sanitizeErrorMessage(authn.reason, "Authentication failed"));
  }

  // 2. Authorize
  const authz = await security.authorizer(ctx, operation);
  if (!authz.allowed) {
    throw new SecurityError(403, sanitizeErrorMessage(authz.reason, "Forbidden"));
  }

  // 3. Rate limit
  const rateLimit = await security.rateLimiter(ctx, operation);
  if (!rateLimit.allowed) {
    throw new SecurityError(429, "Rate limit exceeded", rateLimit.retryAfterMs);
  }

  // 4. Sanitize input (only for tool calls)
  if (operation.type === "tool_call" && toolInput !== undefined) {
    return security.inputSanitizer(ctx, operation.name ?? "", toolInput);
  }

  return toolInput;
}
