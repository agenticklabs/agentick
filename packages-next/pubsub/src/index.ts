/**
 * `@agentick/pubsub-next` — local observer / pub-sub primitives.
 *
 * Three layered factories that consolidate ~16 hand-rolled fan-out
 * implementations across the v2 codebase:
 *
 *   - `createNotifier<T = void>()` — single-channel observer.
 *   - `createKeyedNotifier<K, T = void>()` — keyed observer with
 *     optional wildcard channel.
 *   - `createLocalPubSub<T>()` — Stream-based fan-out backed by
 *     Effect's `PubSub.unbounded()`, with drain-before-shutdown
 *     semantics on `close()`.
 *
 * @see ../README.md
 */

export * from "./types.js";
export * from "./notifier.js";
export * from "./keyed-notifier.js";
export * from "./local-pubsub.js";
