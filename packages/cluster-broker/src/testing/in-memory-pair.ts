/**
 * In-memory paired `Connection` — bidirectional message channel
 * that doesn't touch any real wire. Used by `@agentick/cluster-broker`'s
 * own unit tests and by adopters writing focused broker / client
 * tests where TCP/WS setup is overkill.
 *
 *   const [a, b] = createInMemoryConnectionPair();
 *   await a.send(bytes);  // → b.onMessage handler fires
 *   await b.send(bytes);  // → a.onMessage handler fires
 *
 * Delivery is microtask-scheduled (matches the convention from
 * `@agentick/cluster`'s `LocalClusterTransport`) so ordering is
 * deterministic and tests can `await flushMicrotasks()`.
 *
 * Single-handler `onMessage` semantics per the Connection contract
 * (Phase 4a.2) — attempting to register a second handler while one
 * is active throws.
 */

import { generateId } from "@agentick/utils";

import type { Connection, ConnectionCloseReason } from "../connection.js";

/**
 * Create a pair of `Connection` instances that deliver messages to
 * each other. Closing either side propagates a `remote-graceful`
 * reason to the other side.
 */
export function createInMemoryConnectionPair(opts?: {
  readonly idA?: string;
  readonly idB?: string;
}): readonly [Connection, Connection] {
  const idA = opts?.idA ?? `mem-${generateId()}-a`;
  const idB = opts?.idB ?? `mem-${generateId()}-b`;

  const a = createSide(idA);
  const b = createSide(idB);
  a.peer = b;
  b.peer = a;

  return [a.conn, b.conn];
}

interface Side {
  readonly conn: Connection;
  peer?: Side;
}

interface SideInternals {
  messageHandler: ((message: Uint8Array) => void) | null;
  readonly closeHandlers: Set<(reason: ConnectionCloseReason) => void>;
}

const internals = new WeakMap<Connection, SideInternals>();

function createSide(id: string): Side {
  const state: SideInternals = {
    messageHandler: null,
    closeHandlers: new Set<(reason: ConnectionCloseReason) => void>(),
  };
  let closed = false;
  let closeReason: ConnectionCloseReason | undefined;

  const side: Side = {
    conn: {
      id,
      remote: undefined,
      async send(message) {
        if (closed) {
          throw new Error(`cluster-broker test: send on closed connection ${id}`);
        }
        const peer = side.peer;
        if (!peer) {
          throw new Error(`cluster-broker test: connection ${id} has no peer`);
        }
        // Snapshot the bytes so callers can reuse the buffer.
        const snapshot = message.slice();
        const peerInternals = internals.get(peer.conn);
        queueMicrotask(() => {
          const handler = peerInternals?.messageHandler;
          if (!handler) return;
          try {
            handler(snapshot);
          } catch {
            // Test fixtures swallow handler throws — production
            // base broker / base client have their own catches.
          }
        });
      },
      onMessage(handler) {
        if (state.messageHandler !== null) {
          throw new Error(
            `cluster-broker test: connection ${id} already has a message handler attached`,
          );
        }
        state.messageHandler = handler;
        return () => {
          if (state.messageHandler === handler) state.messageHandler = null;
        };
      },
      onClose(handler) {
        if (closed && closeReason) {
          // Fire immediately with the recorded reason — matches the
          // Connection contract.
          queueMicrotask(() => handler(closeReason!));
          return () => {};
        }
        state.closeHandlers.add(handler);
        return () => {
          state.closeHandlers.delete(handler);
        };
      },
      async close() {
        if (closed) return;
        closed = true;
        closeReason = "local-close";
        for (const handler of [...state.closeHandlers]) {
          queueMicrotask(() => handler("local-close"));
        }
        // Notify peer with remote-graceful.
        const peer = side.peer;
        if (peer && peer.conn) {
          const peerSide = peer;
          queueMicrotask(() => {
            peerSide.peer = undefined;
            forceClose(peerSide.conn, "remote-graceful");
          });
        }
      },
    },
  };

  internals.set(side.conn, state);
  return side;
}

function forceClose(conn: Connection, reason: ConnectionCloseReason): void {
  const inner = internals.get(conn);
  if (!inner) return;
  for (const handler of [...inner.closeHandlers]) {
    queueMicrotask(() => handler(reason));
  }
  inner.closeHandlers.clear();
  inner.messageHandler = null;
}
