/**
 * Phase 4d acceptance bar — `runClusterTransportConformance` against
 * the Unix-socket wire. Mirror of the TCP conformance test; uses a
 * per-test temp-dir socket path so parallel test execution doesn't
 * collide.
 *
 * Same suite cluster-next/testing/local-cluster-transport.spec.ts +
 * cluster-net/conformance-against-tcp.spec.ts pass. Proves the
 * Unix-socket wire honors the same protocol contract end-to-end
 * through real filesystem-addressed sockets.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runClusterTransportConformance, type ClusterCodec } from "@agentick/cluster-next";
import { BaseClusterClient } from "@agentick/cluster-broker-next";

import { createUnixConnector } from "../unix-connector.js";
import { unixBroker } from "../unix-cluster.js";

function makeJsonCodec(): ClusterCodec {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    encode: (v) => enc.encode(JSON.stringify(v)),
    decode: (raw) => JSON.parse(dec.decode(raw)),
  };
}

async function allocateSocketPath(): Promise<{ socketPath: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cluster-net-unix-"));
  const socketPath = join(dir, "broker.sock");
  return {
    socketPath,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

runClusterTransportConformance({
  async setup() {
    const { socketPath, cleanup } = await allocateSocketPath();
    const running = await unixBroker({ socketPath, codec: makeJsonCodec() });

    const factoryA = async (parent: import("@agentick/cluster-next").ClusterParent) => {
      const client = new BaseClusterClient({
        nodeId: "node-A",
        connector: createUnixConnector({ socketPath }),
        codec: makeJsonCodec(),
        heartbeatMs: 0,
      });
      parent.onClose(() => client.close());
      await client.ready;
      return client;
    };
    const factoryB = async (parent: import("@agentick/cluster-next").ClusterParent) => {
      const client = new BaseClusterClient({
        nodeId: "node-B",
        connector: createUnixConnector({ socketPath }),
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
        await cleanup();
      },
    };
  },
});
