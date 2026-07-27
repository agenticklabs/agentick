/**
 * Client-originated notifications reach the server — `notifications/cancelled`
 * in particular, which is the frame every aborted request emits.
 *
 * The in-process transport used to drop id-less frames on the floor: `sendFrame`
 * returned early unless the frame carried BOTH `id` and `method`. So aborting a
 * request rejected the client's promise while the gateway kept executing —
 * silently divergent from the socket transports, which at least put the frame
 * on the wire. This is the transport most tests run on, so the divergence was
 * invisible exactly where it mattered most.
 *
 * The observable is SERVER-side: a wire method parks until its registered
 * cancel callback fires. `ctx.wire.registerCancel` is the same seam
 * `session/send` uses to abort a real execution, reached through the real
 * gateway, the real registry, and the real `dispatchRequest` — so what holds
 * here holds for every cancellable method.
 */

import { createClient } from "@agentick/client-core";
import { createGateway } from "@agentick/gateway";
import { defineWireExtension, type WireExtension } from "@agentick/spec";
import { drainRejection, waitFor } from "@agentick/utils/testing";
import { describe, expect, it } from "vitest";

import { inProcessTransport } from "../index.js";

// Synthetic method names for the probe extension, merged so the definition and
// the registry types line up (the house pattern — see
// `@agentick/transport`'s `wire-extension-dispatch.spec.ts`).
declare module "@agentick/spec" {
  interface WireMethods {
    "cancelProbe/park": { params: { readonly tag: string }; result: { readonly ended: string } };
  }
}

interface Probe {
  readonly started: string[];
  readonly cancelled: string[];
}

/**
 * A wire method that parks until cancelled. `registerCancel` puts the abort
 * callback in the connection's in-flight registry — exactly where an inbound
 * `notifications/cancelled` has to land to reach it.
 */
function parkingExtension(probe: Probe): WireExtension {
  return defineWireExtension({
    name: "test#cancel-probe",
    namespace: "cancelProbe",
    version: "1.0.0",
    methods: {
      "cancelProbe/park": async ({ tag }, ctx) => {
        probe.started.push(tag);
        return new Promise<{ readonly ended: string }>((resolve) => {
          ctx.wire.registerCancel(() => {
            probe.cancelled.push(tag);
            resolve({ ended: tag });
          });
        });
      },
    },
  });
}

async function makeStack() {
  const probe: Probe = { started: [], cancelled: [] };
  const gateway = await createGateway({ wireExtensions: [parkingExtension(probe)] });
  await gateway.listen();
  const client = await createClient({ transport: inProcessTransport({ gateway }) });
  await client.connect();
  return {
    client,
    probe,
    cleanup: async () => {
      await client.close();
      await gateway.close();
    },
  };
}

describe("in-process transport — client-originated cancellation", () => {
  it("aborting a request ABORTS the server-side operation, not just the client promise", async () => {
    const { client, probe, cleanup } = await makeStack();

    const controller = new AbortController();
    // Never awaited before the server-side assertion: on this transport
    // `sendFrame` IS the round trip, so a parked handler parks `request()` too.
    // The whole point is that the abort must reach the server regardless.
    const parked = client
      .request("cancelProbe/park", { tag: "a" }, controller.signal)
      .then(() => "resolved" as const)
      .catch(() => "rejected" as const);
    await waitFor(() => probe.started.includes("a"), { description: "the server-side park" });

    // Nothing on the server ends this call except the cancellation reaching it.
    expect(probe.cancelled).toEqual([]);
    controller.abort();

    await waitFor(() => probe.cancelled.includes("a"), {
      description: "the server-side cancel callback",
      timeoutMs: 2_000,
    });
    expect(probe.cancelled).toEqual(["a"]);
    // And the caller's promise settles as cancelled once the server unwinds.
    expect(await parked).toBe("rejected");

    await cleanup();
  });

  it("cancels only the request it names — the in-flight registry is keyed by id", async () => {
    const { client, probe, cleanup } = await makeStack();

    const first = new AbortController();
    const second = new AbortController();
    const parkedA = client.request("cancelProbe/park", { tag: "a" }, first.signal);
    const parkedB = client.request("cancelProbe/park", { tag: "b" }, second.signal);
    void parkedA.catch(() => {});
    void parkedB.catch(() => {});
    await waitFor(() => probe.started.length === 2, { description: "both parks" });

    first.abort();
    await waitFor(() => probe.cancelled.length === 1, {
      description: "one cancel",
      timeoutMs: 2_000,
    });

    // `b` is still parked — a cancellation is routed, not broadcast.
    expect(probe.cancelled).toEqual(["a"]);

    // Release `b` so nothing is left parked on the gateway at teardown.
    second.abort();
    await waitFor(() => probe.cancelled.length === 2, {
      description: "the second cancel",
      timeoutMs: 2_000,
    });

    await cleanup();
  });

  it("a cancellation naming an unknown request id is harmless", async () => {
    const { client, cleanup } = await makeStack();

    // Nothing is in flight under this id by the time the frame lands.
    const stray = new AbortController();
    const ping = client.request("ping", {}, stray.signal);
    stray.abort();
    await drainRejection(ping);

    // An unmatched cancellation is a no-op, not a fault: the pair stays usable.
    expect(await client.request("ping", {})).toEqual({});

    await cleanup();
  });
});
