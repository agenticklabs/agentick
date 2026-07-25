/**
 * Reason-string normalisation + Exit unwrapping.
 *
 * Every long-running harness in v2 needs to convert an unknown error
 * value (or an Effect {@link Cause.Cause} / {@link Exit.Exit}) into
 * either:
 *
 *   1. a single-line reason string for terminal events / UI / logs, or
 *   2. a thrown value at the harness-protocol boundary that preserves
 *      typed-failure information from Effect.fail while collapsing
 *      defects / interrupts into a regular `Error`.
 *
 * Before this module each site rolled its own. Five of those impls
 * were nearly identical; two diverged in observable ways
 * (`elicitation/stringifyReason` dropped the `{_tag}` branch, so an
 * `Effect.fail({_tag:"X"})` value became `'{"_tag":"X"}'` there but
 * `"X"` elsewhere). One canonical set lives here; all sites import.
 *
 * Conventions:
 *
 *   - `reasonOf(value)` — the lowest-level conversion. Order is
 *     `string` → `Error.message` → `{_tag: string}` (Effect-tagged
 *     errors) → `JSON.stringify` → `String()`. Returns a single line.
 *   - `reasonOfCause(cause)` — typed-failure wins over defect wins
 *     over interrupt-only. Mirrors the historical
 *     `tasks/causeToReason` shape so behaviour is unchanged at the
 *     migrated call sites.
 *   - `unwrapExit(exit)` — the Promise-boundary unwrap used by
 *     `RequestResponseRegistry` and `runHarnessProtocol`. Typed
 *     failures rethrow the typed value AS-IS so callers can pattern-
 *     match on `_tag`; defects throw `new Error(Cause.pretty(cause))`.
 *     Note: this is NOT a string-only "throw Error" reducer — it
 *     deliberately preserves typed-failure identity, which is what
 *     the harness protocol contract requires.
 *
 * `@verifiedBy` packages/utils/src/__tests__/cause.spec.ts
 */

import { Cause, Exit, Option } from "effect";

// ============================================================================
// Reason-of-value
// ============================================================================

/**
 * Reduce an unknown error value to a single-line reason string.
 *
 * Resolution order, first match wins:
 *
 *   1. Already a `string` → returned verbatim.
 *   2. `Error` instance → `.message`.
 *   3. Object with a `_tag: string` (the Effect tagged-error shape) →
 *      the tag.
 *   4. Anything `JSON.stringify`-able → JSON.
 *   5. Fallback: `String(value)`.
 *
 * The result is a single line — callers that want richer detail
 * should reach for {@link Cause.pretty} directly.
 */
export function reasonOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    typeof (value as { _tag: unknown })._tag === "string"
  ) {
    return (value as { _tag: string })._tag;
  }
  try {
    const json = JSON.stringify(value);
    // JSON.stringify returns `undefined` for `undefined`, functions, and
    // symbols — fall back to String() so reasonOf always returns a string.
    if (json !== undefined) return json;
  } catch {
    // Cyclic structures throw — drop to String().
  }
  return String(value);
}

// ============================================================================
// Reason-of-cause
// ============================================================================

/**
 * Reduce an Effect {@link Cause.Cause} to a single-line reason string.
 *
 * Resolution order:
 *
 *   1. Typed failure (`Effect.fail(E)`) — first failure via
 *      {@link Cause.failureOption}, fed to {@link reasonOf}.
 *   2. Defect (`Effect.die(unknown)`) — first defect via
 *      {@link Cause.defects}, fed to {@link reasonOf}.
 *   3. Otherwise (interrupt-only, empty, exotic) — first line of
 *      {@link Cause.pretty}, falling back to `"unknown"`.
 */
export function reasonOfCause<E>(cause: Cause.Cause<E>): string {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) return reasonOf(failure.value);
  const defects = Array.from(Cause.defects(cause));
  if (defects.length > 0) return reasonOf(defects[0]);
  return Cause.pretty(cause).split("\n")[0] ?? "unknown";
}

// ============================================================================
// Cause-of-cause — extract the originating value WITHOUT stringifying
// ============================================================================

/**
 * Extract the originating value from an Effect {@link Cause.Cause}
 * WITHOUT stringifying. Mirrors {@link reasonOfCause}'s precedence
 * but returns the typed value (or the defect) so adopters can branch
 * on structured failure shapes (`_tag` discrimination, error payloads,
 * etc.) at the consumer boundary.
 *
 * Resolution order:
 *
 *   1. Typed failure (`Effect.fail(E)`) — `Cause.failureOption(cause)`.
 *      Returns `E` AS-IS so callers retain pattern-match identity.
 *   2. Defect (`Effect.die(unknown)`) — first defect via
 *      `Cause.defects(cause)`.
 *   3. Otherwise (interrupt-only, empty, exotic) — returns `undefined`.
 *      Callers wanting a string fall back to {@link reasonOfCause}.
 *
 * Use {@link reasonOfCause} when you need a string summary; use this
 * when you need the structured value for downstream pattern matching.
 */
export function causeValue<E>(cause: Cause.Cause<E>): unknown | undefined {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) return failure.value;
  const defects = Array.from(Cause.defects(cause));
  if (defects.length > 0) return defects[0];
  return undefined;
}

// ============================================================================
// Exit unwrap
// ============================================================================

/**
 * Unwrap an Effect {@link Exit.Exit} at a Promise-typed harness
 * protocol boundary.
 *
 *   - Success → returns `exit.value`.
 *   - Typed failure (`Effect.fail(E)`) → throws `E` AS-IS. Application
 *     code can pattern-match on `_tag` without unwrapping a
 *     `FiberFailure`.
 *   - Defect / interrupt-only / empty cause → throws
 *     `new Error(Cause.pretty(cause))`.
 *
 * This is the canonical shape used by `RequestResponseRegistry` and
 * `runHarnessProtocol` — both deliberately preserve typed-failure
 * identity rather than collapsing every failure to a stringified
 * `Error`. Do not "simplify" this to a single `throw new Error(...)`
 * branch; that change is a behavioural regression.
 */
export function unwrapExit<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  throw new Error(Cause.pretty(exit.cause));
}
