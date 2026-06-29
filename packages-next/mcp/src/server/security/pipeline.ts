/**
 * Security pipeline runner.
 *
 * Two entry points:
 *
 *  - `evaluateConnectionGuard(security, info)` — once per transport
 *    connection. Trusted transports (stdio, in-memory) skip the guard.
 *  - `evaluateRequestPipeline(security, ctx, op, toolInput?)` — per
 *    request. Runs authenticate → authorize → rate-limit → sanitize.
 *
 * Throws `SecurityError` on rejection at any stage. Each error carries
 * an HTTP-equivalent code (401/403/429) the transport layer maps to
 * the appropriate JSON-RPC error code.
 *
 * Ported from v1 `packages/mcp/src/server/security/pipeline.ts` with
 * v2 type substitutions (`McpRequestContext`, `OperationInfo`).
 */

import type { McpRequestContext } from "@agentick/spec-next";

import type { McpConnectionInfo, OperationInfo, ResolvedSecurity } from "./stages.js";

/**
 * Thrown when a security stage rejects. The `code` mirrors HTTP
 * semantics for adopter ergonomics (and what v1 chose); the transport
 * layer maps it to the appropriate JSON-RPC error code.
 */
export class SecurityError extends Error {
  readonly code: number;
  readonly retryAfterMs?: number;
  constructor(code: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "SecurityError";
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** Trusted transport kinds — `ConnectionGuard` skipped. */
const TRUSTED_TRANSPORTS = new Set<string>(["stdio", "in-memory"]);

/**
 * Evaluate connection-level acceptance. Returns when accepted; throws
 * `SecurityError(403)` when rejected. Trusted transports short-circuit
 * to `true`.
 */
export async function evaluateConnectionGuard(
  security: ResolvedSecurity,
  info: McpConnectionInfo,
): Promise<void> {
  if (TRUSTED_TRANSPORTS.has(info.transportKind)) return;
  const accepted = await security.connectionGuard(info);
  if (!accepted) {
    throw new SecurityError(
      403,
      `Connection rejected from ${info.origin ?? info.remoteAddress ?? "unknown"}`,
    );
  }
}

/**
 * Run the full per-request pipeline. Order:
 *
 *   1. Authenticator   — populates `ctx.user`
 *   2. Authorizer      — checks the operation against the user
 *   3. RateLimiter     — checks the per-key budget
 *   4. InputSanitizer  — tool calls only; sanitizes input
 *
 * Throws `SecurityError` on rejection. On success returns the
 * (possibly sanitized) tool input for tool calls; `undefined` for
 * non-tool operations.
 *
 * The pipeline mutates a SHALLOW COPY of `ctx` to populate `user`
 * from the authenticator's result. The original ctx is unchanged.
 */
export async function evaluateRequestPipeline(
  security: ResolvedSecurity,
  ctx: McpRequestContext,
  operation: OperationInfo,
  toolInput?: Readonly<Record<string, unknown>>,
): Promise<{
  readonly ctx: McpRequestContext;
  readonly toolInput: Record<string, unknown> | undefined;
}> {
  // 1. Authenticate.
  const authn = await security.authenticator(ctx);
  if (!authn.authenticated) {
    throw new SecurityError(401, authn.reason || "Authentication failed");
  }
  const authedCtx: McpRequestContext = { ...ctx, user: authn.user };

  // 2. Authorize.
  const authz = await security.authorizer(authedCtx, operation);
  if (!authz.allowed) {
    throw new SecurityError(403, authz.reason || "Forbidden");
  }

  // 3. Rate-limit.
  const rate = await security.rateLimiter(authedCtx, operation);
  if (!rate.allowed) {
    throw new SecurityError(429, "Rate limit exceeded", rate.retryAfterMs);
  }

  // 4. Sanitize — tool calls only.
  if (operation.type === "tool_call" && toolInput !== undefined) {
    const sanitized = await security.inputSanitizer(authedCtx, operation.name ?? "", toolInput);
    return { ctx: authedCtx, toolInput: sanitized };
  }

  return { ctx: authedCtx, toolInput: undefined };
}
