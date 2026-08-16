/**
 * Conformance suite for malformed-generation recovery (ADR 99), end to end.
 *
 * Every link in the chain is proven on its own elsewhere — an adapter's
 * classification, the loop's fold, the session's policy, the app option. None
 * of those composes the pieces: they all inject the failure at a seam. Here the
 * failure enters where production puts it — on the wire, from the model — and
 * the assertion that matters is the PROVIDER CALL COUNT, because a retry that
 * never reaches the provider is not a retry.
 *
 * The clean-timeline invariant is asserted at the provider boundary: byte-equal
 * request payloads across the two calls. That is the strongest form of the
 * claim ADR 99 rests on — a failed tick persists nothing, so the retry is not
 * merely a second attempt but the SAME request.
 *
 * Dependency-inverted like every suite here: this file imports vitest and
 * types. The factory brings the app, the adapter, and the stub client.
 *
 * @see docs/proposals/v2/blueprint/99-tick-failure-recovery.md
 */

import { describe, expect, it } from "vitest";

import type { TickFailurePolicy } from "@agentick/spec";

// ============================================================================
// Factory contract
// ============================================================================

/**
 * One scripted provider turn: `"malformed"` is a generation the adapter must
 * classify as `MalformedModelOutput`; `"ok"` is an ordinary completion.
 */
export type RecoveryStep = "malformed" | "ok";

export interface RecoveryRunResult {
  readonly succeeded: boolean;
  /** `_tag` of the terminal failure, when the run did not succeed. */
  readonly stopCauseTag?: string;
}

export interface RecoveryRunInput {
  readonly stream?: boolean;
  readonly tickFailurePolicy?: TickFailurePolicy;
}

export interface RecoveryTickStart {
  readonly tickIndex: number;
  readonly retryOfTick?: number;
}

/**
 * A scripted app the suite can run once and then interrogate at the provider
 * boundary.
 *
 * `run` constructs and drives the app, so the policy and the stream flag can
 * differ per case while the script is fixed at factory time. The stub MUST
 * carry only the shape `run` was asked for — an adapter that takes the wrong
 * seam then fails loudly instead of quietly proving nothing.
 */
export interface RecoveryHandle {
  run(input?: RecoveryRunInput): Promise<RecoveryRunResult>;
  providerCalls(): number;
  /** JSON-comparable request payloads, in call order. */
  providerRequests(): readonly unknown[];
  tickStarts(): readonly RecoveryTickStart[];
  close(): Promise<void>;
}

export type RecoveryFactory = (script: readonly RecoveryStep[]) => Promise<RecoveryHandle>;

export interface RecoveryConformanceOptions {
  /**
   * Set `false` when the adapter has no malformed lane on its non-streaming
   * seam. The case is then reported as skipped rather than passed — silence
   * about a missing lane is how a gap survives.
   */
  readonly nonStreaming?: boolean;
}

/**
 * A projected request is a message list, not a stub artifact. Below this the
 * byte-identity assertion would be comparing two nothings.
 */
const NON_TRIVIAL_REQUEST_CHARS = 40;

// ============================================================================
// Suite
// ============================================================================

export function runRecoveryConformance(
  factory: RecoveryFactory,
  options: RecoveryConformanceOptions = {},
): void {
  const nonStreamingIt = options.nonStreaming === false ? it.skip : it;

  describe("malformed-generation recovery (ADR 99)", () => {
    it("streaming: the default policy recovers on a second provider call", async () => {
      const handle = await factory(["malformed", "ok"]);
      const result = await handle.run({ stream: true });

      expect(result.succeeded).toBe(true);

      // The load-bearing assertion: the retry went to the PROVIDER, twice.
      expect(handle.providerCalls()).toBe(2);

      const requests = handle.providerRequests();
      expect(requests).toHaveLength(2);
      const first = JSON.stringify(requests[0]);
      expect(typeof requests[0]).toBe("object");
      expect(first.length).toBeGreaterThan(NON_TRIVIAL_REQUEST_CHARS);
      // The same request — the failed tick persisted nothing.
      expect(JSON.stringify(requests[1])).toEqual(first);

      const ticks = handle.tickStarts();
      expect(ticks.map((t) => t.tickIndex)).toEqual([1, 2]);
      expect(ticks[0]!.retryOfTick).toBeUndefined();
      expect(ticks[1]!.retryOfTick).toBe(1);

      await handle.close();
    });

    it("streaming: a model that stays malformed spends the budget and stops", async () => {
      const handle = await factory(["malformed", "malformed"]);
      const result = await handle.run({ stream: true });

      expect(result.succeeded).toBe(false);
      expect(result.stopCauseTag).toBe("MalformedModelOutput");
      // The bundled policy retries ONCE — two attempts, not three.
      expect(handle.providerCalls()).toBe(2);

      await handle.close();
    });

    it("a supplied policy rules — a zero budget never reaches the provider twice", async () => {
      // Same script as the recovery case, so a suite that always retries and a
      // suite that never retries each fail one of the two.
      const handle = await factory(["malformed", "ok"]);
      const result = await handle.run({
        stream: true,
        tickFailurePolicy: { MalformedModelOutput: 0 },
      });

      expect(result.succeeded).toBe(false);
      expect(handle.providerCalls()).toBe(1);

      await handle.close();
    });

    nonStreamingIt("non-streaming: the same recovery through the non-streaming seam", async () => {
      const handle = await factory(["malformed", "ok"]);
      const result = await handle.run({ stream: false });

      expect(result.succeeded).toBe(true);
      expect(handle.providerCalls()).toBe(2);
      const requests = handle.providerRequests();
      expect(JSON.stringify(requests[1])).toEqual(JSON.stringify(requests[0]));

      await handle.close();
    });
  });
}
