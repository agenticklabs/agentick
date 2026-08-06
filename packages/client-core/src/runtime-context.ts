/**
 * `clientRuntimeContext` — build the {@link ClientRuntimeContext} a client
 * exposes as `client.runtime`. The TYPE lives in `@agentick/spec` (any language
 * implementing the client protocol owes this surface); this is the construction
 * half, which is runtime's to own.
 */

import type { ClientRuntimeContext } from "@agentick/spec";

import type { ClientObservability } from "./observability.js";

/**
 * Wrap an observability instance with live identity.
 *
 * Identity arrives as thunks rather than values so `connectionId` tracks
 * reconnects. The observability instance is shared rather than rebuilt, because
 * span nesting lives on it — a fresh instance per read would orphan every child
 * span.
 */
export function clientRuntimeContext(
  obs: ClientObservability,
  identity: {
    readonly clientId: () => string;
    readonly connectionId: () => string | undefined;
  },
): ClientRuntimeContext {
  return {
    get clientId() {
      return identity.clientId();
    },
    get connectionId() {
      return identity.connectionId();
    },
    log: obs.log,
    trace: obs.trace,
    metrics: obs.metrics,
    activeSpan: () => obs.activeSpan(),
  };
}
