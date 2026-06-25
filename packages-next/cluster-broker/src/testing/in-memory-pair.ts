/**
 * In-memory paired `Connection` — bidirectional message channel
 * that doesn't touch any real wire. Used by `cluster-broker-next`'s
 * own unit tests and by adopters writing focused broker / client
 * tests where TCP/WS setup is overkill.
 *
 *   const [a, b] = createInMemoryConnectionPair();
 *   await a.send(bytes);  // → b.onMessage handlers fire
 *   await b.send(bytes);  // → a.onMessage handlers fire
 *
 * Delivery is microtask-scheduled (matches the convention from
 * `cluster-next`'s `LocalClusterTransport`) so ordering is
 * deterministic and tests can `await flushMicrotasks()`.
 */

import { ulid } from "@agentick/utils-next";

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
  const idA = opts?.idA ?? `mem-${ulid()}-a`;
  const idB = opts?.idB ?? `mem-${ulid()}-b`;

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

function createSide(id: string): Side {
  const messageHandlers = new Set<(message: Uint8Array) => void>();
  const closeHandlers = new Set<(reason: ConnectionCloseReason) => void>();
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
        queueMicrotask(() => {
          if (!peer.conn) return;
          for (const handler of [...messageHandlersOf(peer.conn)]) {
            try {
              handler(snapshot);
            } catch {
              // Test fixtures swallow handler throws — production
              // base broker / base client have their own catches.
            }
          }
        });
      },
      onMessage(handler) {
        messageHandlers.add(handler);
        return () => {
          messageHandlers.delete(handler);
        };
      },
      onClose(handler) {
        if (closed && closeReason) {
          // Fire immediately with the recorded reason — matches the
          // Connection contract.
          queueMicrotask(() => handler(closeReason!));
          return () => {};
        }
        closeHandlers.add(handler);
        return () => {
          closeHandlers.delete(handler);
        };
      },
      async close() {
        if (closed) return;
        closed = true;
        closeReason = "local-close";
        for (const handler of [...closeHandlers]) {
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

  // Internal accessors for the close cascade.
  attachInternals(side.conn, { messageHandlers, closeHandlers, setClosed: forceClose });

  return side;
}

// ----------------------------------------------------------------------------
// Internal plumbing — let the close cascade reach the peer's handlers.
// ----------------------------------------------------------------------------

interface InMemoryInternals {
  readonly messageHandlers: Set<(message: Uint8Array) => void>;
  readonly closeHandlers: Set<(reason: ConnectionCloseReason) => void>;
  readonly setClosed: (conn: Connection, reason: ConnectionCloseReason) => void;
}

const internals = new WeakMap<Connection, InMemoryInternals>();

function attachInternals(conn: Connection, value: InMemoryInternals): void {
  internals.set(conn, value);
}

function messageHandlersOf(conn: Connection): Set<(message: Uint8Array) => void> {
  return internals.get(conn)!.messageHandlers;
}

function forceClose(conn: Connection, reason: ConnectionCloseReason): void {
  const inner = internals.get(conn);
  if (!inner) return;
  for (const handler of [...inner.closeHandlers]) {
    queueMicrotask(() => handler(reason));
  }
  // Detach so future sends throw.
  inner.closeHandlers.clear();
}
