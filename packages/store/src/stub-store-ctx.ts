/**
 * `stubStoreCtx` — a minimal {@link StoreCtx} for store tests + conformance.
 *
 * A store DATA method now takes a mandatory `ctx: StoreCtx` (the explicit
 * runtime-scope carrier across the Effect→Promise boundary). Pure in-memory
 * stores ignore it, but the call still has to pass one. This is the canned
 * `StoreCtx` every store spec + `runStoreConformance` case threads — a `stub`
 * per the Meszaros taxonomy (canned answer, no behavior).
 *
 * Override fields via the argument when a test needs a specific scope
 * (`stubStoreCtx({ sessionId: "s-1", principal: "acme/u-1" })`).
 */

import type { StoreCtx } from "@agentick/spec";

/** A minimal {@link StoreCtx} with an optional field overlay. */
export function stubStoreCtx(overrides: Partial<StoreCtx> = {}): StoreCtx {
  return { sessionId: "conformance", ...overrides };
}
