/**
 * `stubElicitation()` — canned-answer double, no real round-trip.
 *
 * Returns an object that satisfies {@link ElicitationHarnessProtocol}
 * and answers every `elicit(...)` call with a pre-baked result. Use
 * this when the system-under-test interacts with the protocol surface
 * but doesn't need the bus + inbox round-trip exercised.
 *
 * The `elicit` method is properly generic — the caller's
 * `StandardSchemaV1<unknown, TOutput>` flows through to the result's
 * `value` type. The canned `result` is cast at the boundary; callers
 * supplying mismatched fixtures get a type error at the test site
 * (not a silent runtime cast).
 */

import type {
  ElicitationHarnessProtocol,
  ElicitationRequest,
  ElicitationResult,
  ElicitationResponse,
  StandardSchemaV1,
} from "@agentick/spec-next";

type InferOutput<S extends StandardSchemaV1> =
  S extends StandardSchemaV1<unknown, infer O> ? O : never;

export interface StubElicitationOptions {
  /**
   * Canned result returned by every `elicit(...)` call. Defaults to
   * `{ outcome: "declined", reason: "stub-elicitation default" }` so
   * tests are forced to opt-in to specific accepted/declined shapes.
   *
   * Typed as `ElicitationResult<unknown>` — supply concrete typed
   * fixtures (`{ outcome: "accepted", value: ... }`) and the stub
   * narrows it to the caller's schema output at the boundary.
   */
  readonly result?: ElicitationResult;
  /**
   * Optional hook fired on every `elicit(...)` invocation. Useful for
   * spying on call shape from a test.
   */
  readonly onElicit?: (
    request: ElicitationRequest<StandardSchemaV1>,
    opts: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ) => void;
  /** Override the harness id surfaced via `.id`. */
  readonly id?: string;
}

export function stubElicitation(options: StubElicitationOptions = {}): ElicitationHarnessProtocol {
  const cannedResult: ElicitationResult = options.result ?? {
    outcome: "declined",
    reason: "stub-elicitation default",
  };

  return {
    id: options.id ?? "stub-elicitation",
    ready: Promise.resolve(),
    elicit<TSchema extends StandardSchemaV1>(
      request: ElicitationRequest<TSchema>,
      opts: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
    ): Promise<ElicitationResult<InferOutput<TSchema>>> {
      options.onElicit?.(request as ElicitationRequest<StandardSchemaV1>, opts);
      return Promise.resolve(cannedResult as ElicitationResult<InferOutput<TSchema>>);
    },
    async respond(_response: ElicitationResponse): Promise<void> {
      // no-op — the stub doesn't track in-flight elicitations.
    },
    async close(): Promise<void> {
      // no-op
    },
  };
}
