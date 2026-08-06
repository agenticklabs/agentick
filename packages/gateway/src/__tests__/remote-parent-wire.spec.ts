/**
 * The remote-parent policy END TO END: a caller's `_meta.traceparent` reaching a
 * real gateway, through the wire dispatch op, to spans recorded at the OTel edge.
 *
 * `remote-trace.spec.ts` proves the header → scope-field mapping in isolation.
 * This proves the half that mapping is worthless without — that the substrate
 * honours the field, and that the resulting span really does join (or not join)
 * the caller's trace. `traceId` is the discriminator: adopting a parent puts the
 * server span IN the caller's trace, linking leaves it in its own.
 *
 * @verifiedBy this file
 */

import { describe, expect, it } from "vitest";
import { createTelemetry } from "@agentick/app";
import { spyTelemetrySink } from "@agentick/runtime/testing";
import type { WireMethod } from "@agentick/spec";

import { createGateway } from "../index.js";
import { fakeWireCtx } from "./fake-wire-ctx.js";

const CALLER_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const CALLER_SPAN = "00f067aa0ba902b7";
const TRACEPARENT = `00-${CALLER_TRACE}-${CALLER_SPAN}-01`;

const method = "diag/ping" as WireMethod;

async function dispatch(
  remoteParent: "ignore" | "link" | "parent" | undefined,
  params: unknown = { _meta: { traceparent: TRACEPARENT } },
) {
  const spy = spyTelemetrySink();
  const gateway = await createGateway({
    telemetry: createTelemetry({ serviceName: "gw" }, spy),
    ...(remoteParent !== undefined ? { remoteParent } : {}),
  });
  await gateway.listen();

  await gateway.runWireDispatch(method, params, fakeWireCtx(gateway), async () => ({ ok: true }));
  await gateway.close();

  const span = spy.spans.find((s) => s.name === `wire:${method}`);
  expect(span).toBeDefined();
  return span!;
}

describe("remote parent, end to end through the wire", () => {
  it("links by default — the server span stays in its OWN trace, joinable but not adopted", async () => {
    const span = await dispatch(undefined);
    expect(span.links).toEqual([CALLER_TRACE]);
    expect(span.traceId).not.toBe(CALLER_TRACE);
  });

  it("adopts the caller's trace under `parent` — one tree end to end", async () => {
    const span = await dispatch("parent");
    expect(span.traceId).toBe(CALLER_TRACE);
    expect(span.links).toEqual([]);
  });

  it("drops it under `ignore` — neither adopted nor linked", async () => {
    const span = await dispatch("ignore");
    expect(span.traceId).not.toBe(CALLER_TRACE);
    expect(span.links).toEqual([]);
  });

  it("a caller that sends no traceparent traces normally", async () => {
    const span = await dispatch("parent", {});
    expect(span.links).toEqual([]);
  });

  it("a malformed traceparent is ignored, not an error — the request still succeeds", async () => {
    const span = await dispatch("parent", { _meta: { traceparent: "garbage" } });
    expect(span.links).toEqual([]);
  });
});
