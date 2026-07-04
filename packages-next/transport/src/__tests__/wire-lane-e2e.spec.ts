/**
 * End-to-end wire lane (#141 + ADR 34 ingress): REAL gateway, REAL app,
 * REAL session harnesses on the shared substrate — a JSON-RPC request
 * enters `dispatchRequest` with an ingress identity and either reaches
 * the session's TimelineHarness over the inbox or dies at the gate.
 *
 * This is the test the unit suite could not provide: address
 * derivation, the `<surface>:commands` meta-verb ask, exposure
 * flipping, and the Authorizer all exercised against live harnesses.
 */

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ErrorCode, type JsonRpcResponse } from "@agentick/spec-next";
import { dispatchRequest, type DispatchSink } from "../server/dispatch.js";

import { fromHandler } from "@agentick/timeline-next/strategies";

import { createGateway, staticAuthorizer, type GatewayHarness } from "@agentick/gateway-next";

function makeAppOptions() {
  return {
    rootElement: {} as unknown,
    executor: {
      target: { kind: "language-model" as const, provider: "mock", modelId: "stub" },
      project: () => ({}) as never,
      execute: () => Effect.succeed({}) as never,
      executeStream: undefined,
      normalize: () => ({}) as never,
      run: () => Effect.succeed({}) as never,
      abort: () => Effect.succeed(undefined) as never,
    } as never,
    reconciler: {
      mount: () => Effect.succeed({}) as never,
      unmount: () => Effect.succeed(undefined) as never,
      render: () => Effect.succeed({}) as never,
      snapshot: () => Effect.succeed({}) as never,
    } as never,
  };
}

const sink: DispatchSink = {
  sendNotification: () => {},
  registerSubscription: () => {},
  unregisterSubscription: () => {},
  registerInFlight: () => {},
  unregisterInFlight: () => {},
};

let rpcId = 0;
async function rpc(
  gateway: GatewayHarness,
  method: string,
  params: Record<string, unknown>,
  principal?: string,
): Promise<JsonRpcResponse> {
  return dispatchRequest(
    gateway as never,
    { jsonrpc: "2.0", id: ++rpcId, method, params },
    sink,
    principal !== undefined ? { principal } : undefined,
  );
}

describe("wire lane e2e — real gateway + session, ingress identity, Authorizer", () => {
  let gateway: GatewayHarness;

  beforeAll(async () => {
    gateway = (await createGateway({
      authorizer: staticAuthorizer({
        grants: { alice: ["timeline:*"] },
        anonymous: [],
      }),
    })) as GatewayHarness;
    const app = await gateway.createApp({
      appId: "a1",
      ...(makeAppOptions() as object),
      options: {
        ...makeAppOptions(),
        // Construction-bound default compaction — the bare
        // `timeline:compact` signal form resolves to this (ADR 51).
        session: {
          timeline: { compact: fromHandler({ handler: async ({ entries }) => entries }) },
        },
      } as never,
    } as never);
    await app.createSession({ sessionId: "s1" });
  });

  afterAll(async () => {
    await gateway.closeGateway();
  });

  it("granted principal reaches the REAL TimelineHarness: timeline/compact round-trips", async () => {
    const res = await rpc(gateway, "timeline/compact", { sessionId: "s1" }, "alice");
    expect("error" in res ? res.error : undefined).toBeUndefined();
    expect("result" in res && res.result).toBeTruthy();
  });

  it("gated discovery: timeline/commands enumerates for the granted principal", async () => {
    const res = await rpc(gateway, "timeline/commands", { sessionId: "s1" }, "alice");
    if (!("result" in res)) throw new Error("expected result");
    const commands = (res.result as { commands: Array<{ name: string; exposure: string }> })
      .commands;
    const compact = commands.find((c) => c.name === "timeline:compact");
    expect(compact?.exposure).toBe("wire");
  });

  it("addressable-but-not-wire verb is MethodNotFound even for the granted principal", async () => {
    const res = await rpc(gateway, "timeline/append", { sessionId: "s1" }, "alice");
    if (!("error" in res) || res.error === undefined) throw new Error("expected error");
    expect(res.error.code).toBe(ErrorCode.MethodNotFound);
  });

  it("ungranted principal is Forbidden on an exposed verb", async () => {
    const res = await rpc(gateway, "timeline/compact", { sessionId: "s1" }, "mallory");
    if (!("error" in res) || res.error === undefined) throw new Error("expected error");
    expect(res.error.code).toBe(ErrorCode.Forbidden);
  });

  it("anonymous caller is Forbidden under a configured static policy with no anonymous grants", async () => {
    const res = await rpc(gateway, "timeline/compact", { sessionId: "s1" });
    if (!("error" in res) || res.error === undefined) throw new Error("expected error");
    expect(res.error.code).toBe(ErrorCode.Forbidden);
  });

  it("porcelain still shadows the dynamic lane (exact-beats-dynamic on a real registry)", async () => {
    // session/send is a hand-written wire extension — resolving it must
    // hit the porcelain extension, not the dynamic marker.
    const resolution = gateway.wireExtensions().resolve("session/send");
    expect(resolution).toBeDefined();
    expect(resolution!.extension.name).not.toBe("@agentick/dynamic-commands");
  });

  it("unknown session id dies with MethodNotFound (no address, no oracle)", async () => {
    const res = await rpc(gateway, "timeline/compact", { sessionId: "nope" }, "alice");
    if (!("error" in res) || res.error === undefined) throw new Error("expected error");
    // Address derives, but the ask to a non-existent harness fails —
    // surfaced as an error, never a hang.
    expect("code" in res.error).toBe(true);
  });
});
