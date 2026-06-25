/**
 * `createInMemoryClusterPair()` — a `Listener` + `Connector` pair
 * built on top of `createInMemoryConnectionPair`. Lets tests spin up
 * a `BaseBroker` + N `BaseClusterClient`s in one process without
 * any real wire.
 *
 * Each `connector.connect()` allocates a fresh paired Connection;
 * the listener-side counterpart is dispatched through the
 * `onConnection` callback synchronously (within a microtask). This
 * matches the broker's expectations: the listener accept loop hands
 * the broker a `Connection` and the broker drives the handshake.
 */

import { ulid } from "@agentick/utils-next";

import type { Connection, Connector, Listener } from "../connection.js";
import { createInMemoryConnectionPair } from "./in-memory-pair.js";

export interface InMemoryClusterPair {
  readonly listener: Listener;
  /**
   * Build a fresh `Connector` that, on `connect()`, creates a paired
   * Connection and pushes the broker side through `listener.onConnection`.
   * Multiple connectors can share one listener.
   */
  createConnector(target?: string): Connector;
}

/**
 * Build a paired listener + connector factory. Tests typically:
 *
 *   const pair = createInMemoryClusterPair();
 *   const broker = new BaseBroker({ listener: pair.listener, codec });
 *   await broker.start();
 *   const clientA = new BaseClusterClient({ connector: pair.createConnector(), ... });
 *   const clientB = new BaseClusterClient({ connector: pair.createConnector(), ... });
 */
export function createInMemoryClusterPair(): InMemoryClusterPair {
  const acceptHandlers = new Set<(conn: Connection) => void>();
  let started = false;
  let closed = false;

  const listener: Listener = {
    bound: "memory://broker",
    async start() {
      if (closed) throw new Error("cluster-broker test: listener already closed");
      started = true;
    },
    onConnection(handler) {
      acceptHandlers.add(handler);
      return () => {
        acceptHandlers.delete(handler);
      };
    },
    async close() {
      closed = true;
      acceptHandlers.clear();
    },
  };

  function createConnector(target?: string): Connector {
    return {
      target: target ?? "memory://broker",
      async connect(): Promise<Connection> {
        if (!started) throw new Error("cluster-broker test: listener not started");
        if (closed) throw new Error("cluster-broker test: listener closed");
        const id = ulid();
        const [clientSide, brokerSide] = createInMemoryConnectionPair({
          idA: `mem-${id}-client`,
          idB: `mem-${id}-broker`,
        });
        // Dispatch the broker side through accept handlers on next
        // microtask so the client's `onMessage` / `onClose` wiring
        // (registered post-`connect()`) is in place before the
        // broker sends its first Welcome frame.
        queueMicrotask(() => {
          for (const handler of [...acceptHandlers]) {
            handler(brokerSide);
          }
        });
        return clientSide;
      },
    };
  }

  return { listener, createConnector };
}
