/**
 * Wire dispatch through the operation seam (ADR 83 §"Wire dispatch
 * through the seam").
 *
 * `dispatchRequest` routes the resolved handler call through the
 * gateway's `runWireDispatch`, which runs it inside `runOperation` with
 * the `wire:`-prefixed wire method as the op name. So a gateway-scoped
 * command hook fires around a wire dispatch — `deriveHookNames("wire:probe/run")`
 * Pascalizes to `WireProbeRun`, minting `onBeforeWireProbeRun` at the gateway
 * scope (the `wire:` prefix keeps it distinct from the op it delegates to).
 *
 * These tests use the REAL `GatewayHarness` (not the hand-rolled fake)
 * so the seam actually runs. They prove:
 *   - a gateway wire hook fires EXACTLY ONCE per wire dispatch,
 *   - it self-scopes by `ctx.op` (a hook on a different method never
 *     fires),
 *   - the handler result still surfaces unchanged,
 *   - authorization stays the un-waivable PRE-gate: an unauthorized
 *     request rejects BEFORE the seam, so the hook never fires.
 */

import { describe, expect, it } from "vitest";
import { defineWireExtension, type JsonRpcRequest, type WireExtension } from "@agentick/spec";
import { GatewayHarness } from "@agentick/gateway";

import { dispatchRequest, type DispatchSink } from "../server/dispatch.js";

// Synthetic wire methods for these tests. `wire:probe/run` Pascalizes to
// `WireProbeRun`; `wire:probe/other` to `WireProbeOther` — used to prove op-scoping.
declare module "@agentick/spec" {
  interface WireMethods {
    "probe/run": { params: { echo: string }; result: { echoed: string } };
    "probe/other": { params: object; result: { ok: true } };
  }
}

const probeExt: WireExtension = defineWireExtension({
  name: "@test/probe",
  namespace: "probe",
  methods: {
    "probe/run": async ({ echo }) => ({ echoed: echo }),
    "probe/other": async () => ({ ok: true as const }),
  },
});

function stubSink(): DispatchSink {
  return {
    sendNotification: () => {},
    registerSubscription: () => {},
    unregisterSubscription: () => {},
    registerInFlight: () => {},
    unregisterInFlight: () => {},
  };
}

function req(method: string, params: unknown, id = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params: params as Record<string, unknown> };
}

// Wire hooks are TYPED (ADR 83 §"Wire dispatch through the seam" + the
// `WireCommandMap` → `CommandRegistry` fold): the `probe/*` rows declared above
// mint `onBeforeWireProbeRun` / `onBeforeWireProbeOther` as real
// `CommandHooks` keys, so `gw.hook({ ... })` typechecks WITHOUT a cast — the
// before-hook input is the row's `params`.

describe("dispatchRequest — wire dispatch through the gateway operation seam", () => {
  it("fires a gateway-scoped wire hook exactly once around the dispatch", async () => {
    const gw = new GatewayHarness({ wireExtensions: [probeExt] });
    await gw.ready;

    const fired: string[] = [];
    // `onBeforeWireProbeRun` — before-hook keyed to the wire method's `wire:`-prefixed op name.
    gw.hook({
      onBeforeWireProbeRun: () => {
        fired.push("run");
      },
    });

    const resp = await dispatchRequest(gw, req("probe/run", { echo: "hi" }), stubSink());

    // Handler result surfaces unchanged.
    expect(resp).toEqual({ jsonrpc: "2.0", id: 1, result: { echoed: "hi" } });
    // Hook fired exactly once — no double-fire.
    expect(fired).toEqual(["run"]);

    await gw.close();
  });

  it("self-scopes by op: a hook on a different wire method does not fire", async () => {
    const gw = new GatewayHarness({ wireExtensions: [probeExt] });
    await gw.ready;

    const fired: string[] = [];
    // Registered for `wire:probe/other`, but we dispatch `probe/run`.
    gw.hook({
      onBeforeWireProbeOther: () => {
        fired.push("other");
      },
    });

    const resp = await dispatchRequest(gw, req("probe/run", { echo: "hi" }), stubSink());

    expect(resp).toMatchObject({ result: { echoed: "hi" } });
    expect(fired).toEqual([]); // op-scoping: WireProbeOther hook never fired on WireProbeRun

    await gw.close();
  });

  it("authorization stays the un-waivable pre-gate: unauthorized rejects BEFORE the seam", async () => {
    // Default authorizer is `unconfiguredAuthorizer` — an authenticated
    // principal against an unconfigured policy is DENIED (deny-by-default).
    const gw = new GatewayHarness({ wireExtensions: [probeExt] });
    await gw.ready;

    const fired: string[] = [];
    gw.hook({
      onBeforeWireProbeRun: () => {
        fired.push("run");
      },
    });

    const resp = await dispatchRequest(
      gw,
      req("probe/run", { echo: "hi" }),
      stubSink(),
      { principal: "alice", scopes: [] }, // authenticated → denied by unconfigured policy
    );

    // Rejected with a JSON-RPC error (Forbidden), NOT a result.
    expect(resp).toMatchObject({ jsonrpc: "2.0", id: 1, error: expect.objectContaining({}) });
    expect("result" in resp).toBe(false);
    // The hook NEVER fired — auth ran (and denied) before the seam.
    expect(fired).toEqual([]);

    await gw.close();
  });
});
