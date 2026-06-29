/**
 * `inMemoryServerTransport()` — in-process transport pair for tests.
 *
 * Differs from the existing `InMemoryMcpTransport.createLinkedPair()`
 * in `@agentick/mcp-next/transport`: that one is a pure pair of
 * `Transport` instances for client + server. This one is a
 * `ServerTransport` (listener shape) that the harness mounts via its
 * normal `start()` path, with a `connect()` helper that gives the
 * client side back to the test.
 *
 * Drives end-to-end tests where the server harness sees a full
 * listen → accept → wire flow without spawning a subprocess.
 */

import { InMemoryMcpTransport } from "../../transport/in-memory.js";

import type { ServerTransport, AcceptHandler } from "./types.js";

/**
 * Construct an in-memory server transport plus a `connect()` helper.
 * Each `connect()` call yields a fresh linked pair: the server side
 * is handed to the harness via `accept`; the client side is returned
 * to the caller for SDK Client construction.
 */
export interface InMemoryServerTransportHandle extends ServerTransport {
  /**
   * Open a new connection: emits the server-side transport via
   * `accept`, returns the client-side transport for the test's SDK
   * Client to consume. Multiple `connect()` calls model multiple
   * concurrent connections.
   */
  readonly connect: () => Promise<InstanceType<typeof InMemoryMcpTransport>>;
}

export function inMemoryServerTransport(): InMemoryServerTransportHandle {
  let acceptCallback: AcceptHandler | null = null;
  let closed = false;

  return {
    kind: "in-memory",
    async listen(accept) {
      if (closed) {
        throw new Error("inMemoryServerTransport: cannot listen after close()");
      }
      acceptCallback = accept;
    },
    async close() {
      closed = true;
      acceptCallback = null;
    },
    async connect() {
      if (closed) {
        throw new Error("inMemoryServerTransport: closed");
      }
      if (!acceptCallback) {
        throw new Error("inMemoryServerTransport: listen() not yet called");
      }
      const [clientSide, serverSide] = InMemoryMcpTransport.createLinkedPair();
      await acceptCallback(serverSide, {
        transportKind: "in-memory",
        remoteAddress: "in-memory",
      });
      return clientSide;
    },
  };
}
