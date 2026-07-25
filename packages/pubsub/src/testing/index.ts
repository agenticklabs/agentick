/**
 * `@agentick/pubsub/testing` — test doubles per the Meszaros
 * convention. All three primitives have a `spy*` variant that wraps
 * the real implementation and records calls for assertion.
 *
 * Why only spies? The real implementations are deterministic,
 * in-memory, and fast — there's nothing to fake (`fakeNotifier()`
 * would be `createNotifier()`), nothing to stub (no canned data),
 * and no canned-answer use case. Spies cover the only real testing
 * need: asserting call patterns from collaborators.
 */

export * from "./spy-notifier.js";
export * from "./spy-keyed-notifier.js";
export * from "./spy-local-pubsub.js";
