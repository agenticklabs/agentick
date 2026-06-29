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
 * Throws POJO {@link McpServerError} on rejection at any stage. The
 * transport layer maps each tag to its HTTP-equivalent JSON-RPC code:
 *
 *   McpServerConnectionRejected  →  403  (-32000)
 *   McpServerAuthRejected        →  401
 *   McpServerAuthzDenied         →  403
 *   McpServerRateLimited         →  429  (Retry-After)
 *
 * Aligned with the v2 convention used by every other typed error in
 * the framework — no `class extends Error`. See
 * `docs/proposals/v2/blueprint/40-mcp-server-harness.md` and the
 * TODO(error-infra) note on `McpServerError` for the planned
 * AgentickError-class layering that will overlay `instanceof` checks
 * on these same `_tag` shapes.
 *
 * Ported from v1 `packages/mcp/src/server/security/pipeline.ts` with
 * v2 type substitutions + dropped the SecurityError class.
 */

import type { McpRequestContext, McpServerError } from "@agentick/spec-next";

import type { McpConnectionInfo, OperationInfo, ResolvedSecurity } from "./stages.js";

/** Trusted transport kinds — `ConnectionGuard` skipped. */
const TRUSTED_TRANSPORTS = new Set<string>(["stdio", "in-memory"]);

/**
 * Evaluate connection-level acceptance. Returns when accepted; throws
 * `McpServerConnectionRejected` when rejected. Trusted transports
 * short-circuit to accept without consulting the guard.
 */
export async function evaluateConnectionGuard(
  security: ResolvedSecurity,
  info: McpConnectionInfo,
): Promise<void> {
  if (TRUSTED_TRANSPORTS.has(info.transportKind)) return;
  const accepted = await security.connectionGuard(info);
  if (!accepted) {
    throw {
      _tag: "McpServerConnectionRejected" as const,
      reason: `Connection rejected from ${info.origin ?? info.remoteAddress ?? "unknown"}`,
    } satisfies McpServerError;
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
 * Throws POJO `McpServerError` on rejection. On success returns the
 * authenticated context + (possibly sanitized) tool input for tool
 * calls; `undefined` toolInput for non-tool operations.
 *
 * The pipeline produces a SHALLOW COPY of `ctx` with `user` populated
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
    throw {
      _tag: "McpServerAuthRejected" as const,
      reason: authn.reason || "Authentication failed",
    } satisfies McpServerError;
  }
  const authedCtx: McpRequestContext = { ...ctx, user: authn.user };

  // 2. Authorize.
  const authz = await security.authorizer(authedCtx, operation);
  if (!authz.allowed) {
    throw {
      _tag: "McpServerAuthzDenied" as const,
      reason: authz.reason || "Forbidden",
    } satisfies McpServerError;
  }

  // 3. Rate-limit.
  const rate = await security.rateLimiter(authedCtx, operation);
  if (!rate.allowed) {
    throw {
      _tag: "McpServerRateLimited" as const,
      ...(rate.retryAfterMs !== undefined ? { retryAfterMs: rate.retryAfterMs } : {}),
    } satisfies McpServerError;
  }

  // 4. Sanitize — tool calls only.
  if (operation.type === "tool_call" && toolInput !== undefined) {
    const sanitized = await security.inputSanitizer(authedCtx, operation.name ?? "", toolInput);
    return { ctx: authedCtx, toolInput: sanitized };
  }

  return { ctx: authedCtx, toolInput: undefined };
}

/**
 * Type guard for security-pipeline rejections — useful at catch sites
 * that need to distinguish security errors from other thrown values
 * before the AgentickError class hierarchy lands. Matches the four
 * tags the pipeline throws.
 */
export function isMcpSecurityError(value: unknown): value is McpServerError {
  if (value == null || typeof value !== "object") return false;
  const tag = (value as { _tag?: unknown })._tag;
  return (
    tag === "McpServerConnectionRejected" ||
    tag === "McpServerAuthRejected" ||
    tag === "McpServerAuthzDenied" ||
    tag === "McpServerRateLimited"
  );
}
