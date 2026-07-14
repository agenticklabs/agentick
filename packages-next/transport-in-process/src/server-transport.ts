/**
 * `inProcessServerTransport()` — the {@link ServerTransport} for a
 * same-process deployment (ADR 84 §2).
 *
 * In-process is a DIRECT-CALL transport: there is no socket, no wire, nothing
 * to bind. The in-process client transport ({@link inProcessTransport}) reaches
 * the gateway through an adopter-constructed `handler` closure that calls
 * `dispatchRequest(gateway, …)` synchronously — it never looks up a bound
 * listener. So there is no server-side registration step to perform, and both
 * `listen` and `close` are honest no-ops.
 *
 * It exists so that `gateway.listen()` fan-out stays uniform and an in-process
 * deployment can list its transport alongside the network transports:
 *
 *   createGateway({ transports: [inProcessServerTransport(), webSocketServerTransport({ port })] })
 *
 * @see docs/proposals/v2/blueprint/84-gateway-lifecycle-and-transports.md §2
 */

import type { GatewayHarnessProtocol, ServerTransport } from "@agentick/spec-next";

export function inProcessServerTransport(): ServerTransport {
  return {
    id: "in-process",
    async listen(_host: GatewayHarnessProtocol): Promise<void> {
      // Nothing to bind — see module doc. In-process clients reach the
      // gateway by direct call, not through a bound listener.
    },
    async close(): Promise<void> {
      // Symmetric no-op — nothing was bound.
    },
  };
}
