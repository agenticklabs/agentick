/**
 * `jsonCodec()` — bundled JSON codec round-trip tests. The codec
 * is the default for `defineCluster`; every transport uses it
 * unless adopters override.
 */

import { describe, expect, it } from "vitest";

import type { EventEnvelope, MessageEnvelope } from "@agentick/spec";

import { jsonCodec } from "../builtins/json-codec.js";
import type { ClusterCodec } from "../codec.js";

describe("jsonCodec", () => {
  it("round-trips a MessageEnvelope through encode → decode", () => {
    const codec = jsonCodec()({} as never) as ClusterCodec;
    const env: MessageEnvelope = {
      addressedTo: "tasks:session-x",
      type: "tasks-cancel",
      messageId: "msg-1",
      correlationId: "req:abc",
      timestamp: 1719252000000,
      payload: { taskId: "task:1", reason: "user-cancel" },
    };
    const raw = codec.encode(env);
    expect(raw).toBeInstanceOf(Uint8Array);
    const back = codec.decode(raw);
    expect(back).toEqual(env);
  });

  it("round-trips an EventEnvelope through encode → decode", () => {
    const codec = jsonCodec()({} as never) as ClusterCodec;
    const env: EventEnvelope = {
      id: "evt-1",
      surface: "tool",
      name: "tool:task:created",
      phase: "delta",
      timestamp: 1719252000000,
      scope: { sessionId: "session-x" },
      payload: { taskId: "task:1" },
    };
    const raw = codec.encode(env);
    expect(raw).toBeInstanceOf(Uint8Array);
    const back = codec.decode(raw);
    expect(back).toEqual(env);
  });

  it("encode produces bytes that round-trip through string conversion (debug-friendly)", () => {
    const codec = jsonCodec()({} as never) as ClusterCodec;
    const env: MessageEnvelope = {
      addressedTo: "test:x",
      type: "ping",
      messageId: "msg-x",
      timestamp: 0,
      payload: { hello: "world" },
    };
    const raw = codec.encode(env);
    const asString = new TextDecoder().decode(raw);
    expect(asString).toBe(JSON.stringify(env));
  });

  it("decode throws on malformed input", () => {
    const codec = jsonCodec()({} as never) as ClusterCodec;
    const garbage = new TextEncoder().encode("not json {{{");
    expect(() => codec.decode(garbage)).toThrow(/json/i);
  });

  it("each factory call produces an independent codec instance", () => {
    const factory = jsonCodec();
    const a = factory({} as never) as ClusterCodec;
    const b = factory({} as never) as ClusterCodec;
    expect(a).not.toBe(b);
    // But both decode each other's encodings — they're stateless.
    const env: MessageEnvelope = {
      addressedTo: "test:x",
      type: "ping",
      messageId: "x",
      timestamp: 0,
    };
    expect(b.decode(a.encode(env))).toEqual(env);
  });
});
