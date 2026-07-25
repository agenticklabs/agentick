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
 * Throws subclasses of {@link McpServerError} on rejection at any
 * stage. The transport layer maps each `_tag` to its HTTP-equivalent
 * JSON-RPC code:
 *
 *   McpServerConnectionRejected  →  403  (-32000)
 *   McpServerAuthRejected        →  401
 *   McpServerAuthzDenied         →  403
 *   McpServerRateLimited         →  429  (Retry-After)
 *
 * Ported from v1 `packages/mcp/src/server/security/pipeline.ts` with
 * v2 type substitutions.
 */

import type { McpRequestContext, McpServerError } from "@agentick/spec";
import {
  McpServerAuthRejected,
  McpServerAuthzDenied,
  McpServerConnectionRejected,
  McpServerRateLimited,
} from "@agentick/spec";

import type { McpConnectionInfo, OperationInfo, ResolvedSecurity } from "./stages.js";
import { omitUndefined } from "@agentick/utils";

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
    throw new McpServerConnectionRejected({
      reason: `Connection rejected from ${info.origin ?? info.remoteAddress ?? "unknown"}`,
    });
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
 * Throws an `McpServerError` subclass on rejection. On success returns the
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
    throw new McpServerAuthRejected({
      reason: authn.reason || "Authentication failed",
    });
  }
  // ADR 43 — `user` lives under `ctx.mcp` now (was top-level pre-ADR-43).
  const authedCtx: McpRequestContext = { ...ctx, mcp: { ...ctx.mcp, user: authn.user } };

  // 2. Authorize.
  const authz = await security.authorizer(authedCtx, operation);
  if (!authz.allowed) {
    throw new McpServerAuthzDenied({
      reason: authz.reason || "Forbidden",
    });
  }

  // 3. Rate-limit.
  const rate = await security.rateLimiter(authedCtx, operation);
  if (!rate.allowed) {
    throw new McpServerRateLimited(
      omitUndefined({
        retryAfterMs: rate.retryAfterMs,
      }),
    );
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
 * that need to distinguish security errors from other thrown values.
 * Matches the four concrete classes the pipeline throws.
 */
export function isMcpSecurityError(value: unknown): value is McpServerError {
  return (
    value instanceof McpServerConnectionRejected ||
    value instanceof McpServerAuthRejected ||
    value instanceof McpServerAuthzDenied ||
    value instanceof McpServerRateLimited
  );
}
