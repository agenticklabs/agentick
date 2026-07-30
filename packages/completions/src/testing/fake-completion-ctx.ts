/**
 * `fakeCompletionCtx` — a real branded {@link CompletionCtx} for exercising a
 * resolver directly in a test, without a harness. Routes through
 * `deriveTestContext` (the ADR 91 test deriver), so the trunk and the lazy
 * facets are the genuine article, not a hand-assembled bag.
 */

import type { CompletionCtx } from "@agentick/spec";
import { deriveTestContext } from "@agentick/runtime/testing";

export interface FakeCompletionCtxOptions {
  /** Sibling arguments already filled. Defaults to `{}`. */
  readonly resolvedArguments?: Readonly<Record<string, string>>;
  /** Latest-wins cancellation, when the test exercises abort behavior. */
  readonly signal?: AbortSignal;
}

export function fakeCompletionCtx(options: FakeCompletionCtxOptions = {}): CompletionCtx {
  return {
    ...deriveTestContext(),
    resolvedArguments: options.resolvedArguments ?? {},
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
}
