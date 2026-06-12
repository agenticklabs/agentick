/**
 * runTransportConformance against the Unix-socket transport.
 *
 * Stands up a `net.Server` listening on a temp-dir socket path, routes
 * NDJSON-framed JSON-RPC to the test-supplied handler, exposes the
 * Unix-socket client transport. Runs the shared 13-test behavioral
 * suite.
 */

import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer as netCreateServer, type Socket } from "node:net";
import {
  runTransportConformance,
  type TestHandler,
  type TransportConformanceFactory,
} from "@agentick/spec-conformance-next";
import type { JsonRpcRequest } from "@agentick/spec-next";

import { unixSocket } from "../client/index.js";
import { NdjsonDecoder, encodeNdjson } from "../shared/ndjson.js";

function makeTestServer(handler: TestHandler, path: string) {
  return netCreateServer((socket: Socket) => {
    const decoder = new NdjsonDecoder();
    socket.on("data", async (chunk) => {
      for (const result of decoder.push(chunk)) {
        if (!result.ok) continue;
        const frame = result.frame;
        if (Array.isArray(frame)) continue;
        if (!("id" in frame) || !("method" in frame)) continue;

        const response = await handler(frame as JsonRpcRequest, (n) => {
          try {
            socket.write(encodeNdjson({ jsonrpc: "2.0", method: n.method, params: n.params }));
          } catch {
            /* swallow */
          }
        });
        try {
          socket.write(encodeNdjson(response));
        } catch {
          /* swallow */
        }
      }
    });
    socket.on("error", () => {
      /* swallow */
    });
  }).listen(path);
}

const factory: TransportConformanceFactory = {
  async setup(handler) {
    const dir = mkdtempSync(join(tmpdir(), "agentick-uds-conf-"));
    const path = join(dir, "test.sock");
    const server = makeTestServer(handler, path);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));

    const transport = unixSocket({ path });
    return {
      transport,
      teardown: async () => {
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* swallow */
        }
      },
    };
  },
};

runTransportConformance("Unix socket transport", factory);
