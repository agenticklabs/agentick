/**
 * The top-level `telemetry` namespace — the metapackage's job under ADR 27.
 *
 * One object serves both consumers: `client.runtime`'s facets (wired by
 * client-core) and the per-RPC wire spans (wired here). They share an adapter by
 * construction, so their span trees cannot diverge.
 */

import { describe, expect, it } from "vitest";
import type { TelemetryAdapter } from "@agentick/spec";

import { createClient } from "../index.js";
import type { ClientState, ClientTransport, TransportCapabilities } from "@agentick/spec";

/** Minimal transport — the client never connects in these tests. */
function stubTransport(): ClientTransport {
  let state: ClientState = "idle";
  const listeners = new Set<(s: ClientState) => void>();
  return {
    id: "stub",
    capabilities: {
      bidirectional: true,
      streamingRequest: true,
      reconnectable: false,
      binaryFrames: false,
      media: false,
    } satisfies TransportCapabilities,
    get state() {
      return state;
    },
    async connect() {
      state = "open";
    },
    async close() {
      state = "closed";
    },
    onStateChange(fn: (s: ClientState) => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    async request() {
      return {} as never;
    },
    subscribe() {
      throw new Error("not used");
    },
    progress() {
      throw new Error("not used");
    },
  } as unknown as ClientTransport;
}

function countingAdapter(): TelemetryAdapter & { spans: string[]; logs: unknown[] } {
  const spans: string[] = [];
  const logs: unknown[] = [];
  return {
    spans,
    logs,
    startSpan: (name) => {
      spans.push(name);
      return { setAttribute() {}, setError() {}, end() {} };
    },
    currentTraceContext: () => ({}),
    log: (_level, data) => void logs.push(data),
  };
}

describe("createClient({ telemetry })", () => {
  it("feeds BOTH the ctx facets and the wire extension from one object", async () => {
    const adapter = countingAdapter();
    const client = await createClient({
      transport: stubTransport(),
      telemetry: { adapter },
    });

    // Consumer 1: the trunk, wired by client-core.
    client.runtime.log.info("hello");
    expect(adapter.logs).toEqual(["hello"]);

    await client.runtime.trace("adopter-work", () => undefined);
    expect(adapter.spans).toContain("adopter-work");

    await client.close();
  });

  it("is opt-in — no namespace, no extension, and the facets stay callable", async () => {
    const client = await createClient({ transport: stubTransport() });
    expect(() => client.runtime.log.info("x")).not.toThrow();
    await expect(client.runtime.trace("t", () => 7)).resolves.toBe(7);
    await client.close();
  });
});
