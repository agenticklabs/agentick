/**
 * Test doubles for `@agentick/credentials-next`.
 *
 * Per `feedback_test_doubles_meszaros`: `fake*` for working impls,
 * `stub*` for canned answers, `spy*` for call recorders.
 *
 * Today this subpath re-exports the in-memory adapter — which IS a
 * fake (working impl, lost-on-process-exit). When the harness lands
 * in slice 281b, this subpath will add `fakeCredentialsHarness` /
 * `stubCredentialsStore` (canned `get` responses keyed by namespace).
 */

export { inMemoryCredentialsStore as fakeCredentialsStore } from "../stores/in-memory.js";
