/**
 * `fanIn` threading — client handle → `session/send` params.
 *
 * The option is wire-only by construction (`ClientSendInput`, not `SendInput`):
 * it configures the OBSERVATION channel the wire opens alongside the turn, and
 * an in-process caller holds the handle itself. So the only thing to pin on
 * this side is that it reaches the request body when asked for, and leaves no
 * trace when not — a `fanIn: undefined` key on the params would be a behavior
 * change to every existing caller's request the moment a server starts reading
 * it with `in`.
 *
 * What `fanIn` MEANS is pinned end-to-end in
 * `@agentick/transport-in-process/__tests__/progress-fan-in-e2e.spec.ts`.
 */

import { describe, expect, it } from "vitest";
import { WIRE_PROTOCOL_VERSION } from "@agentick/spec";
import type {
  ClientState,
  ClientTransport,
  ProgressStream,
  SubscriptionStream,
  TransportCapabilities,
  WireMethod,
} from "@agentick/spec";

import { createClient } from "../client.js";

/** Records the params of every `session/send`; the send itself never resolves. */
function recordingTransport() {
  const sends: Array<Record<string, unknown>> = [];
  let state: ClientState = "idle";
  const listeners = new Set<(s: ClientState) => void>();
  const transport: ClientTransport = {
    id: "fake",
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
      for (const l of listeners) l(state);
    },
    async close() {
      state = "closed";
    },
    request: (async (method: WireMethod, params: unknown) => {
      if (method === "session/send") {
        sends.push(params as Record<string, unknown>);
        return new Promise<never>(() => {});
      }
      if (method === "initialize") {
        return {
          protocolVersion: WIRE_PROTOCOL_VERSION,
          capabilities: {},
          serverInfo: { name: "fake", version: "0" },
        };
      }
      if (method === "_extensions/list") return { extensions: [] };
      return {};
    }) as ClientTransport["request"],
    subscribe(): SubscriptionStream {
      throw new Error("subscribe not used by this fixture");
    },
    progress: (token: string): ProgressStream => ({
      progressToken: token,
      async close() {},
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
    }),
    onStateChange(h) {
      listeners.add(h);
      return () => listeners.delete(h);
    },
  };
  return { transport, sends };
}

describe("client send — fanIn", () => {
  it("rides the send params when asked for, and is absent when not", async () => {
    const { transport, sends } = recordingTransport();
    const client = await createClient({ transport });
    await client.connect();

    client.session("s1").send({ messages: [{ role: "user", content: "hi" }] });
    client.session("s1").send({ messages: [{ role: "user", content: "hi" }], fanIn: true });

    expect(sends).toHaveLength(2);
    // Absent, not `undefined` — the pre-fanIn request body, byte for byte.
    expect("fanIn" in sends[0]!).toBe(false);
    expect(sends[1]!.fanIn).toBe(true);
    // Nothing else moved: the token still rides `_meta`, where the gateway
    // reads it to decide whether to open a progress fan at all.
    expect((sends[1]!._meta as { progressToken: string }).progressToken).toEqual(
      expect.any(String),
    );

    await client.close();
  });
});
