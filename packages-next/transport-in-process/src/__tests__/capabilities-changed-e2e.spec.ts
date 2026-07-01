/**
 * Control-plane emit seam end-to-end (ADR 47).
 *
 * Proves the SERVER-side + wire mechanism that `emitCapabilitiesChanged`
 * relies on:
 *   gateway.emitCapabilitiesChanged()
 *     → bus.append(gateway:capabilities:changed on surface "gateway")
 *     → subscriptionsWireExtension drain (a gateway-scope subscription)
 *     → notifications/subscription/event over the in-process transport
 *     → subscriber receives the frame
 *
 * The CLIENT does NOT auto-react to this today. Runtime capability
 * re-sync (the client keeping its own `capabilities` fresh when the
 * extension set mutates) is deferred to #308 — the registry is sealed
 * at gateway construction, so `gateway:capabilities:changed` cannot
 * fire in normal operation yet. This test drives the emit directly and
 * consumes it via a manual subscription, exactly as the #308-era
 * client self-maintenance will. See ADR 47.
 */

import { createClient } from "@agentick/client-next";
import { createGateway } from "@agentick/gateway-next";
import {
  GATEWAY_CAPABILITIES_CHANGED,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@agentick/spec-next";
import { dispatchRequest, type DispatchSink } from "@agentick/transport-next";
import { describe, expect, it, vi } from "vitest";

import { inProcessTransport } from "../index.js";
import { withHandshake } from "../handshake.js";

async function setup(): Promise<{
  readonly gateway: Awaited<ReturnType<typeof createGateway>>;
  readonly client: Awaited<ReturnType<typeof createClient>>;
  readonly cleanup: () => Promise<void>;
}> {
  const gateway = await createGateway();

  const handler = async (
    req: JsonRpcRequest,
    sendNotification: (n: { method: string; params?: unknown }) => void,
  ): Promise<JsonRpcResponse> => {
    // sub/subscribe + everything else routes through the real gateway
    // dispatch; the sink's sendNotification MUST be the transport's
    // callback so subscription-event frames reach the subscriber.
    const sink: DispatchSink = {
      sendNotification,
      registerSubscription: () => {},
      unregisterSubscription: () => {},
      registerInFlight: (_id: JsonRpcId, _abort: () => void) => {},
      unregisterInFlight: () => {},
    };
    return dispatchRequest(gateway, req, sink);
  };

  const client = await createClient({
    transport: inProcessTransport({ handler: withHandshake(handler) }),
  });
  await client.connect();

  return {
    gateway,
    client,
    cleanup: async () => {
      await client.close();
      await gateway.close();
    },
  };
}

describe("control-plane emit seam end-to-end (ADR 47)", () => {
  it("emitCapabilitiesChanged delivers gateway:capabilities:changed over sub/subscribe", async () => {
    const { gateway, client, cleanup } = await setup();

    // Manual gateway-scope subscription — the shape the #308 client
    // self-maintenance will open internally.
    const stream = client.transport.subscribe({ kind: "gateway" }, { surface: "gateway" });
    const received: string[] = [];
    void (async () => {
      for await (const frame of stream) {
        if (frame.envelope?.name) received.push(frame.envelope.name);
      }
    })();

    // Emit inside the poll: `sub/subscribe` establishes the bus
    // subscriber asynchronously, and bus subscriptions start at the
    // current head — an event appended before the subscriber attaches
    // is missed. Re-emitting until one lands sidesteps the
    // subscribe-then-emit race (a test-only concern; real capability
    // changes happen long after connect).
    await vi.waitFor(() => {
      gateway.emitCapabilitiesChanged!();
      expect(received).toContain(GATEWAY_CAPABILITIES_CHANGED);
    });

    await stream.close();
    await cleanup();
  });

  it("fans to every gateway-scope subscriber", async () => {
    const { gateway, client, cleanup } = await setup();

    const s1 = client.transport.subscribe({ kind: "gateway" }, { surface: "gateway" });
    const s2 = client.transport.subscribe({ kind: "gateway" }, { surface: "gateway" });
    const r1: string[] = [];
    const r2: string[] = [];
    void (async () => {
      for await (const f of s1) if (f.envelope?.name) r1.push(f.envelope.name);
    })();
    void (async () => {
      for await (const f of s2) if (f.envelope?.name) r2.push(f.envelope.name);
    })();

    // Emit inside the poll — see the race note in the first test.
    await vi.waitFor(() => {
      gateway.emitCapabilitiesChanged!();
      expect(r1).toContain(GATEWAY_CAPABILITIES_CHANGED);
      expect(r2).toContain(GATEWAY_CAPABILITIES_CHANGED);
    });

    await s1.close();
    await s2.close();
    await cleanup();
  });
});
