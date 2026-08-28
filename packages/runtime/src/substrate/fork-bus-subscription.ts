/**
 * `forkBusSubscription(bus, filter, listener)` — drive a callback
 * listener from an `EventBus`'s `Stream`-based subscription, with the
 * two properties every installer needs baked in:
 *
 * 1. **Per-event error isolation.** A throwing / rejecting listener
 *    must NOT tear down the stream — otherwise one bad event silently
 *    stops all future delivery on that subscription. (`Effect.promise`
 *    is the trap here: it treats a listener rejection as a defect and
 *    kills the fiber. This helper uses `Effect.tryPromise` +
 *    `catchAll`.)
 * 2. **Atomic teardown.** Unsubscribe is a single `Fiber.interrupt` —
 *    upon interruption the fiber receives no further values, with no
 *    microtask leak (the failure mode of the older AsyncIterable +
 *    `aborted`-boolean pattern).
 *
 * Extracted from triplicated copies in the `AppInstaller`,
 * `SessionInstaller` (`@agentick/app`), and `GatewayInstaller`
 * (`@agentick/gateway`) `subscribeBus` implementations — which had
 * already diverged once (the gateway copy shipped the `Effect.promise`
 * defect above). One source of truth; the next installer is correct by
 * default.
 *
 * @see ./bus-async-iterator.ts — the pull-based sibling (same
 *   fork/interrupt skeleton, iterator surface instead of a callback).
 */

import { Effect, Fiber, Stream } from "effect";
import { runDetached } from "./run-detached.js";

import type { EventBus, EventQuery, ProtocolEvent, Unsubscribe } from "@agentick/spec";

/**
 * Fork a fiber that delivers every bus event matching `filter` to
 * `listener`, sequentially (a slow listener back-pressures its own
 * subscription, never the bus). Each call opens a fresh subscription;
 * the substrate bus is multi-subscriber by design.
 *
 * The returned {@link Unsubscribe} interrupts the fiber. Interruption
 * is fire-and-forget from the caller's perspective (the thunk is
 * synchronous); the fiber is guaranteed to deliver no event that the
 * bus publishes after interruption completes.
 */
export function forkBusSubscription(
  bus: EventBus,
  filter: EventQuery,
  listener: (event: ProtocolEvent) => void | Promise<void>,
): Unsubscribe {
  const fiber = Effect.runFork(
    Stream.runForEach(bus.subscribe(filter), (event) =>
      Effect.tryPromise({
        // Swallow listener errors so one subscriber can't kill its own
        // subscription (per-event error isolation).
        try: () => Promise.resolve(listener(event)),
        catch: () => undefined,
      }).pipe(Effect.catchAll(() => Effect.void)),
    ),
  );
  return () => {
    runDetached(Fiber.interrupt(fiber));
  };
}
