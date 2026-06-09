/**
 * Factory primitive — ADR 31.
 *
 * Adopters supply substrate and harness slots to a parent harness
 * either as an INSTANCE (shared across children) or as a FACTORY
 * (constructed per-child via the recipe). One factory shape covers
 * every level of the hierarchy:
 *
 *   type Factory<R, P> = (parent: P) => R | Promise<R> | Effect<R, …>
 *
 * The parent harness carries everything a factory needs: identity
 * (`parent.id`), substrate access (`parent.bus` / `parent.journal` /
 * `parent.inbox`), lifecycle (`parent.onClose(h)` for teardown
 * registration), construction input (`parent.input` /
 * `parent.metadata`), and current runtime context
 * (`parent.runtimeContext()`).
 *
 * The discrimination at the slot is `typeof slot === "function"`:
 * substrate primitives and harness protocols are all object
 * interfaces and never callable, so any function in a slot is
 * unambiguously a factory. **No marker properties.**
 *
 * Per-resource factory aliases (`EventBusFactory`, etc.) live next to
 * their resource interfaces and are plain type aliases over this
 * shape.
 *
 * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
 */

import type { Effect } from "effect";

/**
 * The single factory shape used at every slot in the harness
 * hierarchy. The parent provides identity, substrate, lifecycle, and
 * construction context to the factory.
 *
 * Three return forms:
 *  - sync (`R`) — the simplest case
 *  - async (`Promise<R>`) — async construction (e.g., remote handshake)
 *  - Effect (`Effect<R, never, never>`) — Effect-native; yield
 *    `RuntimeContextRef` for fiber-tracked context, yield
 *    `Effect.acquireRelease` for automatic teardown
 *
 * Sync/Promise factories that need fiber-tracked context call
 * `parent.runtimeContext()` synchronously. Effect factories yield
 * directly.
 *
 * Cleanup registration: `parent.onClose(h)` registers a teardown that
 * fires when the parent harness closes. LIFO order, error-isolated.
 *
 * @example
 *   const factory: Factory<EventBus, AppHarness> = (parent) => {
 *     const bus = new LocalEventBus({ parent: parent.bus });
 *     parent.onClose(() => bus.close());
 *     return bus;
 *   };
 */
export type Factory<R, P> = (parent: P) => R | Promise<R> | Effect.Effect<R, never, never>;
