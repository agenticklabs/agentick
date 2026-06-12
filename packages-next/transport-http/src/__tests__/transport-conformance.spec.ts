/**
 * runTransportConformance against the Streamable HTTP transport.
 *
 * Mirrors the real server adapter's session-state sharing between POST
 * and GET handlers — notifications emitted by the handler during a
 * non-streaming RPC fan out to the per-session GET notification stream.
 */

import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  runTransportConformance,
  type TestHandler,
  type TransportConformanceFactory,
} from "@agentick/spec-conformance-next";
import type { JsonRpcFrame, JsonRpcRequest } from "@agentick/spec-next";

import { http } from "../client/index.js";
import { encodeSseFrame } from "../shared/sse.js";

function makeTestServer(handler: TestHandler) {
  // Per-session GET notification streams (sessionId → ServerResponse).
  const notificationStreams = new Map<string, ServerResponse>();

  const httpSrv = createServer(async (req, res) => {
    const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? "test-session";
    res.setHeader("Mcp-Session-Id", sessionId);

    if (req.method === "GET") {
      const accept = req.headers.accept ?? "";
      if (!accept.includes("text/event-stream")) {
        res.statusCode = 406;
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      res.write(": connected\n\n");
      notificationStreams.set(sessionId, res);
      req.on("close", () => {
        if (notificationStreams.get(sessionId) === res) {
          notificationStreams.delete(sessionId);
        }
      });
      return;
    }

    if (req.method === "DELETE") {
      const existing = notificationStreams.get(sessionId);
      if (existing) {
        try {
          existing.end();
        } catch {
          /* swallow */
        }
        notificationStreams.delete(sessionId);
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const bodyChunks: Buffer[] = [];
    for await (const chunk of req) bodyChunks.push(chunk as Buffer);
    const text = Buffer.concat(bodyChunks).toString("utf8");
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(text);
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }

    if ("method" in frame && !("id" in frame)) {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (!("id" in frame) || !("method" in frame)) {
      res.statusCode = 400;
      res.end();
      return;
    }

    const params = (frame as JsonRpcRequest).params as
      | { _meta?: { progressToken?: string } }
      | undefined;
    const streaming = typeof params?._meta?.progressToken === "string";

    // sendNotification routes to the right place:
    //   - streaming POST  → write to the POST's SSE response
    //   - non-streaming   → write to the session's GET notification stream
    const sendToStream = (target: ServerResponse, n: { method: string; params?: unknown }) => {
      try {
        target.write(encodeSseFrame({ jsonrpc: "2.0", method: n.method, params: n.params }));
      } catch {
        /* swallow */
      }
    };

    if (streaming) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      const response = await handler(frame as JsonRpcRequest, (n) => sendToStream(res, n));
      res.write(encodeSseFrame(response));
      res.end();
      return;
    }

    const response = await handler(frame as JsonRpcRequest, (n) => {
      const stream = notificationStreams.get(sessionId);
      if (stream) sendToStream(stream, n);
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });

  return {
    server: httpSrv,
    notificationStreams,
  };
}

const factory: TransportConformanceFactory = {
  async setup(handler) {
    const { server, notificationStreams } = makeTestServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const transport = http({ url: `http://127.0.0.1:${port}` });

    return {
      transport,
      teardown: async () => {
        for (const stream of notificationStreams.values()) {
          try {
            stream.end();
          } catch {
            /* swallow */
          }
        }
        notificationStreams.clear();
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        );
      },
    };
  },
};

runTransportConformance("Streamable HTTP transport", factory);
