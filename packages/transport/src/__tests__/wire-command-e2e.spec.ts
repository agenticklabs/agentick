/**
 * "Wire extensions are commands" — the end-to-end citizenship proof (ADR
 * "wire extensions are commands", Deliverable 3). ONE adopter wire-extension
 * method, dispatched over a REAL `GatewayHarness` through the transport
 * `dispatchRequest`, proving a wire method is a first-class command across
 * every surface a domain op has:
 *
 *   (a) it creates a JOURNALED `wire:<method>` op (requested → terminal),
 *   (b) a TYPED `onBeforeWire<...>` gateway hook fires and TRANSFORMS the params,
 *   (c) a DEFINE-TIME guard's veto / defer terminates the op with the verdict
 *       honored at the JSON-RPC edge (veto → Forbidden, defer → RateLimited),
 *   (d) DEFINE-TIME middleware observes the dispatch (brackets `next`),
 *   (e) `spanAttributes` land on the exported `wire:<method>` op span,
 *   (f) the handler's ctx facets (`log` / `metrics`) are live (metric exported).
 *
 * The guard / middleware / spanAttributes are authored on the method via the
 * ADR-42 rich config arm; `defineWireExtension` normalizes them; the gateway
 * composes them onto the wire op via the existing tier-4 call-scoped seam.
 *
 * @verifiedBy this file
 */

import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  type EventQuery,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ProtocolEvent,
  type SubscribeOptions,
  type WireExtension,
  defineWireExtension,
} from "@agentick/spec";
import { createGateway, GatewayHarness } from "@agentick/gateway";
import { createTelemetry } from "@agentick/app";
import { spyTelemetrySink } from "@agentick/runtime/testing";

import { dispatchRequest, type DispatchSink } from "../server/dispatch.js";

// The adopter's wire row — declared exactly as an adopter would (declaration
// merge). `crm/deleteContact` Pascalizes to `WireCrmDeleteContact` at the
// gateway boundary, minting the typed `onBeforeWireCrmDeleteContact` hook.
declare module "@agentick/spec" {
  interface WireMethods {
    "crm/deleteContact": {
      params: { sessionId: string; contactId: string };
      result: { deleted: boolean; contactId: string };
    };
  }
}

/** Record of everything the define-time middleware observed, across dispatches. */
const observed: string[] = [];

function crmExtension(): WireExtension {
  return defineWireExtension({
    name: "adopter:crm",
    namespace: "crm",
    methods: {
      // The ADR-42 RICH arm: handler + define-time guard + middleware + span attrs.
      "crm/deleteContact": {
        handler: async ({ contactId }, ctx) => {
          // (f) ctx facets are live — `log` + `metrics` resolve to the enriched
          // wire-op facets (metric reaches the gateway meter, asserted below).
          ctx.log.info({ msg: "crm.delete", contactId });
          ctx.metrics.count("crm.deletes", 1);
          return { deleted: true, contactId };
        },
        guard: ({ contactId }) => {
          // Verdict taxonomy, keyed by the (pre-hook) contactId prefix.
          if (contactId.startsWith("locked")) return { kind: "veto", reason: "contact locked" };
          if (contactId.startsWith("busy")) return { kind: "defer", retryAfter: 1000 };
          // else proceed (void).
        },
        middleware: async (params, next) => {
          observed.push(`before:${params.contactId}`);
          const result = await next(params);
          observed.push(`after:${params.contactId}`);
          return result;
        },
        spanAttributes: { "crm.tier": "premium" },
      },
    },
  });
}

function stubSink(): DispatchSink {
  return {
    sendNotification: () => {},
    registerSubscription: () => {},
    unregisterSubscription: () => {},
    registerInFlight: () => {},
    unregisterInFlight: () => {},
  };
}

function req(params: unknown, id = 1): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "crm/deleteContact",
    params: params as Record<string, unknown>,
  };
}

/** Collect up to `n` events from a live bus iterable (emit-then-subscribe pattern). */
async function collect(
  iterable: AsyncIterable<ProtocolEvent>,
  n: number,
  ms = 500,
): Promise<ProtocolEvent[]> {
  const out: ProtocolEvent[] = [];
  const iter = iterable[Symbol.asyncIterator]();
  while (out.length < n) {
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms));
    const step = await Promise.race([iter.next(), timeout]);
    if (step === "timeout" || step.done) break;
    out.push(step.value);
  }
  await iter.return?.();
  return out;
}

const FROM_START: SubscribeOptions = { fromCursor: { value: 0 } };
const GATEWAY_Q: EventQuery = { surface: "gateway" };

describe("wire extensions are commands — full citizenship e2e", () => {
  it("happy path: journaled op + typed hook transform + middleware + span attrs + live facets", async () => {
    observed.length = 0;
    const spy = spyTelemetrySink();
    const gw = await createGateway({
      wireExtensions: [crmExtension()],
      telemetry: createTelemetry({ serviceName: "crm-gw" }, spy),
    });
    await gw.listen();

    // (b) TYPED gateway wire hook — no cast; transforms the params. The handler
    // (and span) see the transformed contactId; the result echoes it back.
    gw.hook({
      onBeforeWireCrmDeleteContact: (input) => ({
        ...input,
        contactId: `${input.contactId}-hooked`,
      }),
    });

    const resp = await dispatchRequest(gw, req({ sessionId: "s1", contactId: "c-1" }), stubSink());

    // Handler ran and returned; the hook's param transform reached the handler.
    expect(resp).toMatchObject({ result: { deleted: true, contactId: "c-1-hooked" } });

    // (d) DEFINE-TIME middleware bracketed the dispatch (it runs OUTSIDE the
    // param-transform hook, so it observes the pre-transform contactId).
    expect(observed).toEqual(["before:c-1", "after:c-1"]);

    // (a) JOURNALED op: the wire op emitted `requested` and `terminal` phases on
    // the gateway bus under the `wire:crm/deleteContact` name.
    const phases = (await collect(gw.events(GATEWAY_Q, FROM_START), 20))
      .filter((e) => e.name === "wire:crm/deleteContact")
      .map((e) => e.phase);
    expect(phases).toContain("requested");
    expect(phases).toContain("terminal");

    // (e) `spanAttributes` landed on the exported `wire:crm/deleteContact` span.
    const span = spy.spans.find((s) => s.name === "wire:crm/deleteContact");
    expect(span).toBeDefined();
    expect(span!.attributes.get("crm.tier")).toBe("premium");

    // (f) ctx facets live: the handler's `ctx.metrics.count` reached the gateway
    // meter and exported (proves the in-fiber facet enrichment ran).
    const metric = (await spy.collectMetrics()).find((m) => m.name === "agentick.crm.deletes");
    expect(metric).toBeDefined();

    await gw.close();
  });

  it("(c) define-time guard VETO → Forbidden at the JSON-RPC edge; handler never runs", async () => {
    observed.length = 0;
    const gw = new GatewayHarness({ wireExtensions: [crmExtension()] });
    await gw.gatewayReady;

    const resp: JsonRpcResponse = await dispatchRequest(
      gw,
      req({ sessionId: "s1", contactId: "locked-42" }),
      stubSink(),
    );

    // The verdict is honored on the wire: veto → Forbidden, no result frame.
    expect("result" in resp).toBe(false);
    expect(resp).toMatchObject({ error: { code: ErrorCode.Forbidden } });
    // Guard short-circuited outermost — middleware + handler never ran.
    expect(observed).toEqual([]);

    await gw.close();
  });

  it("(c) define-time guard DEFER → RateLimited at the JSON-RPC edge", async () => {
    const gw = new GatewayHarness({ wireExtensions: [crmExtension()] });
    await gw.gatewayReady;

    const resp: JsonRpcResponse = await dispatchRequest(
      gw,
      req({ sessionId: "s1", contactId: "busy-7" }),
      stubSink(),
    );

    expect("result" in resp).toBe(false);
    expect(resp).toMatchObject({ error: { code: ErrorCode.RateLimited } });

    await gw.close();
  });
});
