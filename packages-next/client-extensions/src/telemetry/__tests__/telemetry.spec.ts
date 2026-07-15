/**
 * Telemetry middleware — verifies OTel RPC semantic-convention
 * attributes are set, W3C Trace Context is propagated via
 * `_meta.traceparent` / `_meta.tracestate`, errors and durations
 * are recorded, and per-method sampling is honored.
 */

import { describe, expect, it } from "vitest";
import type { JsonRpcRequest, JsonRpcResponse } from "@agentick/spec-next";
import { createClient } from "@agentick/client-core-next";
import { inProcessTransport, withHandshake } from "@agentick/transport-in-process-next";

import {
  telemetry,
  noopAdapter,
  generateTraceparent,
  type TelemetryAdapter,
  type TelemetrySpan,
} from "../index.js";

interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  error?: string;
  ended: boolean;
}

function recordingAdapter(traceparent?: string): {
  adapter: TelemetryAdapter;
  spans: RecordedSpan[];
} {
  const spans: RecordedSpan[] = [];
  const adapter: TelemetryAdapter = {
    startSpan: (name, attributes) => {
      const rec: RecordedSpan = { name, attributes: { ...attributes }, ended: false };
      spans.push(rec);
      const span: TelemetrySpan = {
        setAttribute: (k, v) => {
          rec.attributes[k] = v;
        },
        setError: (msg) => {
          rec.error = msg;
        },
        end: () => {
          rec.ended = true;
        },
      };
      return span;
    },
    currentTraceContext: () => ({ traceparent }),
  };
  return { adapter, spans };
}

describe("telemetry middleware", () => {
  it("opens a span per logical RPC with OTel RPC semantic conventions", async () => {
    const { adapter, spans } = recordingAdapter();
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({
      jsonrpc: "2.0",
      id: req.id,
      result: {},
    });
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [telemetry({ adapter })],
    });
    await client.connect();
    await client.request("ping", {});
    await client.close();

    const pingSpan = spans.find((s) => s.name === "agentick/ping");
    expect(pingSpan).toBeDefined();
    expect(pingSpan!.attributes["rpc.system"]).toBe("jsonrpc");
    expect(pingSpan!.attributes["rpc.service"]).toBe("agentick");
    expect(pingSpan!.attributes["rpc.method"]).toBe("ping");
    expect(pingSpan!.attributes["rpc.jsonrpc.version"]).toBe("2.0");
    expect(typeof pingSpan!.attributes["rpc.duration_ms"]).toBe("number");
    expect(pingSpan!.ended).toBe(true);
    expect(pingSpan!.error).toBeUndefined();
  });

  it("propagates W3C Trace Context via _meta.traceparent", async () => {
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const { adapter } = recordingAdapter(traceparent);
    let seen: { traceparent?: unknown; tracestate?: unknown } = {};
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      const params = req.params as { _meta?: typeof seen };
      seen = params._meta ?? {};
      return { jsonrpc: "2.0", id: req.id, result: {} };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [telemetry({ adapter })],
    });
    await client.connect();
    await client.request("ping", {});
    await client.close();

    expect(seen.traceparent).toBe(traceparent);
  });

  it("generates a traceparent when the adapter doesn't supply one", async () => {
    const { adapter } = recordingAdapter(); // currentTraceContext returns {}
    let seenTraceparent: string | undefined;
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      const params = req.params as { _meta?: { traceparent?: string } };
      seenTraceparent = params._meta?.traceparent;
      return { jsonrpc: "2.0", id: req.id, result: {} };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [telemetry({ adapter })],
    });
    await client.connect();
    await client.request("ping", {});
    await client.close();

    expect(seenTraceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("records errors with message + rpc.jsonrpc.error_code", async () => {
    const { adapter, spans } = recordingAdapter();
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32011, message: "app not found" },
    });
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [telemetry({ adapter })],
    });
    await client.connect();
    spans.length = 0;
    await expect(client.request("gateway/get_app", { appId: "x" })).rejects.toBeDefined();
    await client.close();

    const span = spans[0]!;
    expect(span.error).toBe("app not found");
    expect(span.attributes["rpc.jsonrpc.error_code"]).toBe(-32011);
    expect(span.ended).toBe(true);
  });

  it("respects per-method sampling override", async () => {
    const { adapter, spans } = recordingAdapter();
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({
      jsonrpc: "2.0",
      id: req.id,
      result: {},
    });
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [telemetry({ adapter, sample: (m) => m !== "ping" })],
    });
    await client.connect();
    await client.request("ping", {});
    await client.request("gateway/list_apps", {});
    await client.close();

    expect(spans.find((s) => s.name === "agentick/ping")).toBeUndefined();
    expect(spans.find((s) => s.name === "agentick/gateway/list_apps")).toBeDefined();
  });

  it("custom serviceName flows into span name + rpc.service", async () => {
    const { adapter, spans } = recordingAdapter();
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({
      jsonrpc: "2.0",
      id: req.id,
      result: {},
    });
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [telemetry({ adapter, serviceName: "my-app" })],
    });
    await client.connect();
    spans.length = 0;
    await client.request("ping", {});
    await client.close();

    const span = spans[0]!;
    expect(span.name).toBe("my-app/ping");
    expect(span.attributes["rpc.service"]).toBe("my-app");
  });

  it("noopAdapter still propagates trace context", async () => {
    let seen: { traceparent?: string } = {};
    const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      const params = req.params as { _meta?: { traceparent?: string } };
      seen = params._meta ?? {};
      return { jsonrpc: "2.0", id: req.id, result: {} };
    };
    const client = await createClient({
      transport: inProcessTransport({ handler: withHandshake(handler) }),
      extensions: [telemetry({ adapter: noopAdapter })],
    });
    await client.connect();
    await client.request("ping", {});
    await client.close();

    expect(seen.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});

describe("generateTraceparent", () => {
  it("matches W3C Trace Context format", () => {
    const tp = generateTraceparent();
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("generates unique values", () => {
    const a = generateTraceparent();
    const b = generateTraceparent();
    expect(a).not.toBe(b);
  });
});
