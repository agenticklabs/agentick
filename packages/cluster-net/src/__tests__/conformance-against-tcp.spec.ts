/**
 * Phase 4b acceptance bar — `runClusterTransportConformance` against
 * the real TCP wire. A broker spins up in-process on a freshly-
 * allocated loopback port per test; two `BaseClusterClient`s
 * connect to it via `createTcpConnector`; the cluster-next
 * conformance suite drives full send / broadcast / subscription /
 * lifecycle coverage end-to-end through real `net.Socket` byte
 * streams.
 *
 * Validates that the TCP wire honors the same protocol contract as
 * the in-memory `LocalClusterTransport` fixture — adopters using
 * `defineCluster + tcpClusterNode` get the same guarantees as the
 * Phase 2/3 in-process simulator.
 */

import { runClusterTransportConformance } from "@agentick/cluster/testing";
import type { ClusterCodec } from "@agentick/cluster";
import { BaseClusterClient } from "@agentick/cluster-broker";

import { createTcpConnector } from "../tcp-connector.js";
import { tcpBroker } from "../tcp-cluster.js";

function makeJsonCodec(): ClusterCodec {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    encode: (v) => enc.encode(JSON.stringify(v)),
    decode: (raw) => JSON.parse(dec.decode(raw)),
  };
}

/** Allocate a fresh loopback port by binding briefly + releasing. */
async function allocatePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        probe.close(() => resolve(port));
      } else {
        probe.close(() => reject(new Error("could not allocate port")));
      }
    });
  });
}

runClusterTransportConformance({
  async setup() {
    const port = await allocatePort();
    const running = await tcpBroker({ host: "127.0.0.1", port, codec: makeJsonCodec() });

    // Each factory invocation builds a fresh BaseClusterClient,
    // wires it to the parent's onClose, and returns it once its
    // `ready` Promise has resolved. Awaiting ready before handing
    // the transport to the conformance suite is critical for TCP —
    // unlike the in-memory simulator, the handshake involves a
    // real socket round-trip.
    const factoryA = async (parent: import("@agentick/cluster").ClusterParent) => {
      const client = new BaseClusterClient({
        nodeId: "node-A",
        connector: createTcpConnector({ host: "127.0.0.1", port }),
        codec: makeJsonCodec(),
        heartbeatMs: 0,
      });
      parent.onClose(() => client.close());
      await client.ready;
      return client;
    };
    const factoryB = async (parent: import("@agentick/cluster").ClusterParent) => {
      const client = new BaseClusterClient({
        nodeId: "node-B",
        connector: createTcpConnector({ host: "127.0.0.1", port }),
        codec: makeJsonCodec(),
        heartbeatMs: 0,
      });
      parent.onClose(() => client.close());
      await client.ready;
      return client;
    };

    return {
      factoryA,
      factoryB,
      nodeAId: "node-A",
      nodeBId: "node-B",
      async teardown() {
        await running.close();
      },
    };
  },
});
