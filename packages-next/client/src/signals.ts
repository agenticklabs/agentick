/**
 * Runtime signal receive sugar — `onLog` / `onProgress` (ADR 64).
 *
 * A tool / harness emits ONE `log` / `progress` bus event; the gateway
 * projects matching events to subscribed clients over the existing
 * `subscribe` transport channel. These helpers wrap
 * `client.transport.subscribe(scope, logEventQuery())` (resp.
 * `progressEventQuery()`) so app code doesn't hand-roll the wildcard
 * name query + envelope→payload mapping.
 *
 * Callback style (fire the handler per event, return an `Unsubscribe`)
 * mirrors the ergonomics of the other client subscription handles; the
 * underlying `SubscriptionStream` is drained on a detached async loop
 * and torn down when the returned thunk runs.
 *
 * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
 */

// TODO(#19-react): a `useLog(scope?, opts?)` React hook (rolling log
// list) belongs in a client-React surface. There is NO client-react
// package today — `@agentick/subscriptions-next/react` is the SESSION-side
// subscription surface (`useBridges()` into the render tree), not a
// client-receive surface, so `useLog` cannot live there without lying
// about the dependency direction. When a `@agentick/client-react-next`
// package lands, wrap `onLog` in a `useSyncExternalStore`-backed hook
// there. Until then adopters call `onLog` directly.

import type {
  ClientTransport,
  EventScope,
  LogEventPayload,
  OnSignalOptions,
  ProgressEventPayload,
  ReceivedLog,
  ReceivedProgress,
  SubscriptionScope,
  Unsubscribe,
} from "@agentick/spec-next";
import { logEventQuery, progressEventQuery } from "@agentick/spec-next";

// `ReceivedLog` / `ReceivedProgress` / `OnSignalOptions` moved to
// `@agentick/spec-next/client` (they type BOTH these free functions AND the
// `ClientProtocol.onLog` / `.onProgress` methods). Re-exported here so the
// `@agentick/client-next` surface is unchanged.
export type { ReceivedLog, ReceivedProgress, OnSignalOptions } from "@agentick/spec-next";

/** Minimal client surface these helpers need. */
interface SignalClient {
  readonly transport: Pick<ClientTransport, "subscribe">;
}

/**
 * Subscribe to `log` signal events for `scope` (a session / app /
 * gateway subscription target). `handler` fires once per event with the
 * decoded {@link LogEventPayload} plus the event's origin
 * {@link EventScope}. Returns an {@link Unsubscribe} that closes the
 * underlying stream.
 *
 * Handler throws are swallowed per-event so one bad handler can't stop
 * delivery (parity with the server-side `forkBusSubscription`).
 *
 * @verifiedBy packages-next/client/src/__tests__/signals.spec.ts
 */
export function onLog(
  client: SignalClient,
  scope: SubscriptionScope,
  handler: (event: ReceivedLog) => void,
  opts?: OnSignalOptions,
): Unsubscribe {
  return subscribeSignal(client, scope, logEventQuery(), opts, (payload, evScope) => {
    handler({ ...(payload as LogEventPayload), scope: evScope });
  });
}

/**
 * Subscribe to `progress` signal events for `scope`. See {@link onLog}.
 *
 * @verifiedBy packages-next/client/src/__tests__/signals.spec.ts
 */
export function onProgress(
  client: SignalClient,
  scope: SubscriptionScope,
  handler: (event: ReceivedProgress) => void,
  opts?: OnSignalOptions,
): Unsubscribe {
  return subscribeSignal(client, scope, progressEventQuery(), opts, (payload, evScope) => {
    handler({ ...(payload as ProgressEventPayload), scope: evScope });
  });
}

function subscribeSignal(
  client: SignalClient,
  scope: SubscriptionScope,
  query: ReturnType<typeof logEventQuery>,
  opts: OnSignalOptions | undefined,
  emit: (payload: unknown, scope: EventScope) => void,
): Unsubscribe {
  const sub = client.transport.subscribe(scope, query, opts?.fromCursor);
  let closed = false;
  void (async () => {
    for await (const frame of sub) {
      if (closed) return;
      const env = frame.envelope;
      if (env.payload === undefined) continue;
      try {
        emit(env.payload, (env.scope ?? {}) as EventScope);
      } catch {
        // Isolate handler faults — never tear down the subscription.
      }
    }
  })();
  return () => {
    closed = true;
    void sub.close();
  };
}
