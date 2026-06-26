/**
 * Phase 4e acceptance bar — `runClusterTransportConformance` against
 * the WebSocket wire. A `wsBroker` runs standalone on a freshly
 * allocated port per test; two `BaseClusterClient`s connect via
 * `createWsConnector`; the cluster-next conformance suite drives
 * full send / broadcast / subscription / lifecycle coverage
 * through real WebSocket upgrade + framed message delivery.
 *
 * Same suite that passes against LocalClusterTransport / TCP /
 * Unix — proves the WS wire honors the same protocol contract.
 */

import { createServer } from "node:net";

import { runClusterTransportConformance, type ClusterCodec } from "@agentick/cluster-next";
import { BaseClusterClient } from "@agentick/cluster-broker-next";

import { createWsConnector } from "../ws-connector.js";
import { wsBroker } from "../ws-cluster.js";

function makeJsonCodec(): ClusterCodec {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    encode: (v) => enc.encode(JSON.stringify(v)),
    decode: (raw) => JSON.parse(dec.decode(raw)),
  };
}

async function allocatePort(): Promise<number> {
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
    const running = await wsBroker({
      host: "127.0.0.1",
      port,
      path: "/cluster",
      codec: makeJsonCodec(),
    });
    const url = `ws://127.0.0.1:${port}/cluster`;

    const factoryA = async (parent: import("@agentick/cluster-next").ClusterParent) => {
      const client = new BaseClusterClient({
        nodeId: "node-A",
        connector: createWsConnector({ url }),
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
        connector: createWsConnector({ url }),
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
