import type { Middleware, ProcedureEnvelope } from "./procedure";
import { GuardError } from "@tentickle/shared";

/**
 * Guard function that inspects the procedure envelope to decide allow/deny.
 *
 * - Return `true` to allow execution.
 * - Return `false` to deny (createGuard constructs a GuardError from config).
 * - Throw a `GuardError` directly for full control over the error.
 */
export type GuardFn = (envelope: ProcedureEnvelope<any[]>) => boolean | Promise<boolean>;

/**
 * Configuration for createGuard.
 */
export interface GuardConfig {
  /** Guard name (for debugging, telemetry, error details) */
  name?: string;

  /**
   * Denial reason when the guard fn returns `false`.
   * String or function that receives the envelope for dynamic messages.
   * Ignored when the guard fn throws its own error.
   */
  reason?: string | ((envelope: ProcedureEnvelope<any[]>) => string);

  /** Guard type discriminator (e.g., "role", "guardrail", "rate-limit") */
  guardType?: string;
}

/**
 * Create a guard middleware from a predicate function.
 *
 * The guard runs before the procedure handler:
 * - If the fn returns `true`, execution continues.
 * - If the fn returns `false`, a `GuardError` is thrown (using config for the message).
 * - If the fn throws a `GuardError`, it propagates directly (full control).
 *
 * @example Simple boolean guard
 * ```typescript
 * const adminOnly = createGuard(
 *   (envelope) => envelope.context.user?.roles?.includes("admin") ?? false,
 * );
 * ```
 *
 * @example Config with dynamic reason
 * ```typescript
 * const roleGuard = createGuard({
 *   name: "role-guard",
 *   guardType: "role",
 *   reason: (envelope) => `User ${envelope.context.user?.id} lacks required role`,
 * }, (envelope) => {
 *   return envelope.context.user?.roles?.includes("admin") ?? false;
 * });
 * ```
 *
 * @example Throwing custom GuardError for full control
 * ```typescript
 * const roleGuard = createGuard({ name: "role-guard" }, (envelope) => {
 *   const userRoles = envelope.context.user?.roles ?? [];
 *   const required = ["admin", "moderator"];
 *   if (!required.some(r => userRoles.includes(r))) {
 *     throw GuardError.role(required);
 *   }
 *   return true;
 * });
 * ```
 */
export function createGuard(fn: GuardFn): Middleware;
export function createGuard(config: GuardConfig, fn: GuardFn): Middleware;
export function createGuard(configOrFn: GuardConfig | GuardFn, maybeFn?: GuardFn): Middleware {
  const config: GuardConfig = typeof configOrFn === "function" ? {} : configOrFn;
  const fn: GuardFn = typeof configOrFn === "function" ? configOrFn : maybeFn!;

  return async (args, envelope, next) => {
    if (!(await fn(envelope))) {
      const reason =
        typeof config.reason === "function"
          ? config.reason(envelope)
          : (config.reason ?? "Guard check failed");
      throw new GuardError(
        reason,
        config.guardType ?? "custom",
        config.name ? { guard: config.name } : {},
      );
    }
    return next();
  };
}
