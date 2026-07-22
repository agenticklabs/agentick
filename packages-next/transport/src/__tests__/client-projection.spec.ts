/**
 * Bounded tool-output client projection (ROADMAP A3) — the wire boundary.
 *
 * `dispatchRequest` is the ONE funnel every client-facing frame passes
 * through. These tests prove:
 *
 *   - the pure frame projectors bound tool output in each of the four
 *     client-facing frame shapes (the no-straddle enumeration);
 *   - `dispatchRequest` applies bounding to BOTH egress vectors — the RPC
 *     response (`session/send` / `session/dispatch`) and every notification
 *     (progress + subscription) pushed via the connection's transport slot;
 *   - the projection is STRICTLY OPT-IN / default-OFF — a bare host with no
 *     policy does ZERO projection work (frames pass through by reference,
 *     unbounded — zero overhead); bounding happens only once enabled;
 *   - the gateway's `truncateToolResults` (resolved onto the internal
 *     `clientProjection` slot) raises / lowers / disables the cap;
 *   - the projector NEVER mutates its input — the object the store persisted
 *     stays full while the client gets a bounded copy;
 *   - the two-tier proof: an oversized tool result is FULL in the durable
 *     store AND FULL in the model-facing projection, BOUNDED only at the wire.
 */

import { describe, expect, it } from "vitest";
import {
  BOUNDED_METADATA_KEY,
  DEFAULT_MAX_TOOL_RESULT_BYTES,
  resolveToolOutputBounder,
  TIMELINE_APPEND_EVENT_NAME,
  type BoundedContentMarker,
  type ContentBlock,
  type GatewayHarnessProtocol,
  type JsonRpcRequest,
  type ToolOutputBounder,
  type WireExtension,
  type WireExtensionContext,
  type WireExtensionRegistry,
} from "@agentick/spec-next";
import { createWireExtensionRegistry } from "@agentick/gateway-next";
import { stubTimelineHarness } from "@agentick/timeline-next/testing";

import { dispatchRequest, type DispatchHost, type DispatchSink } from "../server/dispatch.js";
import { projectClientNotification, projectClientResult } from "../server/client-projection.js";

const OVER = DEFAULT_MAX_TOOL_RESULT_BYTES + 5000;
const big = (n = OVER): string => "x".repeat(n);
const bounder = resolveToolOutputBounder();

/** Type-safe nested reach into an opaque frame — no `any`, no fragile casts. */
function at(v: unknown, ...path: Array<string | number>): unknown {
  let cur: unknown = v;
  for (const k of path) cur = (cur as Record<string, unknown>)[k];
  return cur;
}

function markerOf(block: unknown): BoundedContentMarker | undefined {
  return (block as ContentBlock)?.metadata?.[BOUNDED_METADATA_KEY] as
    | BoundedContentMarker
    | undefined;
}

const bigTextBlock = (): ContentBlock => ({ type: "text", text: big() });
const bigToolResult = (): ContentBlock => ({
  type: "tool_result",
  toolUseId: "t1",
  name: "read_file",
  content: [bigTextBlock()],
});

// ─── Pure frame projectors — the four client-facing shapes ─────────────────

describe("projectClientResult — RPC result paths", () => {
  it("session/send — bounds output + toolResults[].content", () => {
    const result = {
      executionId: "e1",
      finalCursor: { value: 0 },
      result: {
        response: "hi",
        output: [
          { type: "tool_use", toolUseId: "t1", name: "x", input: {}, toolResult: bigToolResult() },
        ],
        toolResults: [{ toolCallId: "t1", toolName: "read_file", content: [bigTextBlock()] }],
        usage: {},
        stopReason: "end_turn",
        ticks: 1,
      },
    };
    const projected = projectClientResult("session/send", result, bounder);
    expect(projected).not.toBe(result);
    expect(
      markerOf(at(projected, "result", "output", 0, "toolResult", "content", 0))?.truncated,
    ).toBe(true);
    expect(markerOf(at(projected, "result", "toolResults", 0, "content", 0))?.truncated).toBe(true);
  });

  it("session/dispatch — bounds { content }", () => {
    const result = { content: [bigTextBlock()] };
    const projected = projectClientResult("session/dispatch", result, bounder);
    expect(projected).not.toBe(result);
    expect(markerOf(at(projected, "content", 0))?.truncated).toBe(true);
  });

  it("unknown method result passes through by reference", () => {
    const result = { content: [bigTextBlock()] };
    expect(projectClientResult("gateway/describe", result, bounder)).toBe(result);
  });

  it("does not mutate the input — the store's copy stays full", () => {
    const original = big();
    const result = { content: [{ type: "text", text: original }] as ContentBlock[] };
    projectClientResult("session/dispatch", result, bounder);
    expect((result.content[0] as { text: string }).text).toBe(original);
    expect(result.content[0]!.metadata).toBeUndefined();
  });
});

describe("projectClientNotification — notification paths", () => {
  it("notifications/subscription/event — bounds a timeline-append entry", () => {
    const params = {
      subscriptionId: "s1",
      cursor: { value: 1 },
      envelope: {
        name: TIMELINE_APPEND_EVENT_NAME,
        phase: "requested",
        payload: {
          entries: [
            { kind: "message", message: { id: "m1", role: "tool", content: [bigToolResult()] } },
          ],
        },
      },
    };
    const projected = projectClientNotification(
      "notifications/subscription/event",
      params,
      bounder,
    );
    expect(projected).not.toBe(params);
    expect(
      markerOf(
        at(projected, "envelope", "payload", "entries", 0, "message", "content", 0, "content", 0),
      )?.truncated,
    ).toBe(true);
  });

  it("subscription event that is NOT a timeline append passes through", () => {
    const params = {
      subscriptionId: "s1",
      envelope: { name: "session:channel:knobs-state", payload: { anything: big() } },
    };
    expect(projectClientNotification("notifications/subscription/event", params, bounder)).toBe(
      params,
    );
  });

  it("notifications/progress — bounds a tool-dispatch StreamEvent's content", () => {
    const params = {
      progressToken: "p1",
      cursor: { value: 1 },
      envelope: {
        payload: {
          type: "tool-dispatch",
          callId: "t1",
          name: "x",
          content: [bigTextBlock()],
          succeeded: true,
          durationMs: 1,
        },
      },
    };
    const projected = projectClientNotification("notifications/progress", params, bounder);
    expect(projected).not.toBe(params);
    expect(markerOf(at(projected, "envelope", "payload", "content", 0))?.truncated).toBe(true);
  });

  it("notifications/progress — bounds a terminal result StreamEvent", () => {
    const params = {
      progressToken: "p1",
      envelope: {
        payload: {
          type: "result",
          result: {
            output: [],
            toolResults: [{ toolCallId: "t1", toolName: "x", content: [bigTextBlock()] }],
          },
        },
      },
    };
    const projected = projectClientNotification("notifications/progress", params, bounder);
    expect(
      markerOf(at(projected, "envelope", "payload", "result", "toolResults", 0, "content", 0))
        ?.truncated,
    ).toBe(true);
  });
});

// ─── No-straddle: every client-facing (method/shape) combo is bounded ──────

describe("no-straddle — every client-facing tool-output path is bounded", () => {
  const cases: Array<{ name: string; run: () => boolean }> = [
    {
      name: "session/send result",
      run: () =>
        markerOf(
          at(
            projectClientResult(
              "session/send",
              {
                result: {
                  toolResults: [{ toolCallId: "t", toolName: "x", content: [bigTextBlock()] }],
                },
              },
              bounder,
            ),
            "result",
            "toolResults",
            0,
            "content",
            0,
          ),
        )?.truncated === true,
    },
    {
      name: "session/dispatch result",
      run: () =>
        markerOf(
          at(
            projectClientResult("session/dispatch", { content: [bigTextBlock()] }, bounder),
            "content",
            0,
          ),
        )?.truncated === true,
    },
    {
      name: "subscription timeline-append notification",
      run: () =>
        markerOf(
          at(
            projectClientNotification(
              "notifications/subscription/event",
              {
                envelope: {
                  name: TIMELINE_APPEND_EVENT_NAME,
                  payload: {
                    entries: [{ kind: "message", message: { content: [bigToolResult()] } }],
                  },
                },
              },
              bounder,
            ),
            "envelope",
            "payload",
            "entries",
            0,
            "message",
            "content",
            0,
            "content",
            0,
          ),
        )?.truncated === true,
    },
    {
      name: "progress tool-dispatch notification",
      run: () =>
        markerOf(
          at(
            projectClientNotification(
              "notifications/progress",
              { envelope: { payload: { type: "tool-dispatch", content: [bigTextBlock()] } } },
              bounder,
            ),
            "envelope",
            "payload",
            "content",
            0,
          ),
        )?.truncated === true,
    },
  ];

  for (const c of cases) {
    it(`bounds: ${c.name}`, () => {
      expect(c.run()).toBe(true);
    });
  }
});

// ─── dispatchRequest integration — the real wire funnel ────────────────────

function fakeGateway(
  extensions: readonly WireExtension[],
  opts: { readonly clientProjection?: ToolOutputBounder } = {},
): DispatchHost {
  const registry: WireExtensionRegistry = createWireExtensionRegistry();
  for (const ext of extensions) registry.register(ext);
  registry.seal();
  return {
    id: "fake-gateway",
    metadata: {},
    ready: Promise.resolve(),
    app: () => undefined,
    apps: () => [],
    listen: async () => {},
    close: async () => {},
    authorize: () => Promise.resolve({ allowed: true }),
    accept: () => Promise.resolve(),
    events: () => ({ [Symbol.asyncIterator]: async function* () {} }),
    runWireDispatch: (_m: unknown, _p: unknown, run: () => Promise<unknown>) => run(),
    wireExtensions: () => registry,
    ...(opts.clientProjection ? { clientProjection: opts.clientProjection } : {}),
  } as unknown as GatewayHarnessProtocol;
}

function spySink(): DispatchSink & {
  readonly notifications: Array<{ method: string; params?: unknown }>;
} {
  const notifications: Array<{ method: string; params?: unknown }> = [];
  return {
    notifications,
    sendNotification: (n) => notifications.push(n),
    registerSubscription: () => {},
    unregisterSubscription: () => {},
    registerInFlight: () => {},
    unregisterInFlight: () => {},
  };
}

// Hand-rolled so the synthetic handlers reuse the real `session/*` method
// names the projector keys on, WITHOUT redeclaring their (real) WireMethods
// signatures. Registered + resolved structurally; the dispatcher stores the
// handler as `(params, ctx) => Promise<unknown>`.
const sendExt = {
  name: "@test/session",
  namespace: "session",
  version: "0.1.0",
  methods: {
    "session/send": async (_params: unknown, ctx: WireExtensionContext) => {
      // Fan out oversized notifications through the transport slot — exactly
      // the real send handler's egress (subscription + progress).
      const sub = ctx.transport.registerSubscription(async () => {});
      sub.publish({
        name: TIMELINE_APPEND_EVENT_NAME,
        payload: { entries: [{ kind: "message", message: { content: [bigToolResult()] } }] },
      });
      ctx.transport.progress("p1").push({
        payload: { type: "tool-dispatch", content: [bigTextBlock()] },
      });
      return {
        executionId: "e1",
        finalCursor: { value: 0 },
        result: { toolResults: [{ toolCallId: "t", toolName: "x", content: [bigTextBlock()] }] },
      };
    },
    "session/dispatch": async () => ({ content: [bigTextBlock()] }),
  },
} as unknown as WireExtension;

function req(method: string, id = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params: {} };
}

describe("dispatchRequest — client projection applied at the wire funnel", () => {
  it("default-OFF: a bare host does NOT bound the RPC result NOR the notifications", async () => {
    const sink = spySink();
    const resp = await dispatchRequest(fakeGateway([sendExt]), req("session/send"), sink);
    // RPC-result path: full bytes, no marker — nothing bounded.
    expect(markerOf(at(resp, "result", "result", "toolResults", 0, "content", 0))).toBeUndefined();
    expect(
      (at(resp, "result", "result", "toolResults", 0, "content", 0, "text") as string).length,
    ).toBe(OVER);
    // Both notification paths: unbounded.
    expect(sink.notifications).toHaveLength(2);
    const subFrame = sink.notifications.find(
      (n) => n.method === "notifications/subscription/event",
    )!;
    expect(
      markerOf(
        at(
          subFrame.params,
          "envelope",
          "payload",
          "entries",
          0,
          "message",
          "content",
          0,
          "content",
          0,
        ),
      ),
    ).toBeUndefined();
    const progFrame = sink.notifications.find((n) => n.method === "notifications/progress")!;
    expect(markerOf(at(progFrame.params, "envelope", "payload", "content", 0))).toBeUndefined();
  });

  it("OFF (default): zero overhead — RPC result + notification content pass through by reference", async () => {
    // Distinct references the handler emits; when OFF, neither projectClientResult
    // nor projectClientNotification runs, so the SAME references reach the client.
    const resultBlock = bigTextBlock();
    const handlerResult = { content: [resultBlock] };
    const progBlock = bigTextBlock();
    const zeroExt = {
      name: "@test/zero",
      namespace: "session",
      methods: {
        "session/dispatch": async (_p: unknown, ctx: WireExtensionContext) => {
          ctx.transport
            .progress("p1")
            .push({ payload: { type: "tool-dispatch", content: [progBlock] } });
          return handlerResult;
        },
      },
    } as unknown as WireExtension;

    const sink = spySink();
    const resp = await dispatchRequest(fakeGateway([zeroExt]), req("session/dispatch"), sink);

    // RPC result returned BY REFERENCE — projectClientResult never ran.
    expect(at(resp, "result")).toBe(handlerResult);
    expect(markerOf(resultBlock)).toBeUndefined();
    // Notification content block passed BY REFERENCE — projectClientNotification never ran.
    const progFrame = sink.notifications.find((n) => n.method === "notifications/progress")!;
    expect(at(progFrame.params, "envelope", "payload", "content", 0)).toBe(progBlock);
    expect(markerOf(progBlock)).toBeUndefined();
  });

  it("session/dispatch result is bounded WHEN ENABLED", async () => {
    const resp = await dispatchRequest(
      fakeGateway([sendExt], { clientProjection: bounder }),
      req("session/dispatch"),
      spySink(),
    );
    expect(markerOf(at(resp, "result", "content", 0))?.truncated).toBe(true);
  });

  it("session/send is bounded on all paths WHEN ENABLED", async () => {
    const sink = spySink();
    const resp = await dispatchRequest(
      fakeGateway([sendExt], { clientProjection: bounder }),
      req("session/send"),
      sink,
    );
    expect(markerOf(at(resp, "result", "result", "toolResults", 0, "content", 0))?.truncated).toBe(
      true,
    );
    const subFrame = sink.notifications.find(
      (n) => n.method === "notifications/subscription/event",
    )!;
    expect(
      markerOf(
        at(
          subFrame.params,
          "envelope",
          "payload",
          "entries",
          0,
          "message",
          "content",
          0,
          "content",
          0,
        ),
      )?.truncated,
    ).toBe(true);
    const progFrame = sink.notifications.find((n) => n.method === "notifications/progress")!;
    expect(markerOf(at(progFrame.params, "envelope", "payload", "content", 0))?.truncated).toBe(
      true,
    );
  });

  it("enabled with an Infinity ceiling ({ maxBytes: Infinity }) passes everything through", async () => {
    const off = resolveToolOutputBounder({ maxToolResultBytes: Infinity });
    const sink = spySink();
    const resp = await dispatchRequest(
      fakeGateway([sendExt], { clientProjection: off }),
      req("session/send"),
      sink,
    );
    const block = at(resp, "result", "result", "toolResults", 0, "content", 0);
    expect(markerOf(block)).toBeUndefined();
    expect((block as { text: string }).text.length).toBe(OVER);
    const subFrame = sink.notifications.find(
      (n) => n.method === "notifications/subscription/event",
    )!;
    expect(
      markerOf(
        at(
          subFrame.params,
          "envelope",
          "payload",
          "entries",
          0,
          "message",
          "content",
          0,
          "content",
          0,
        ),
      ),
    ).toBeUndefined();
  });

  it("enabled but RAISED cap ({ maxBytes }) lets a large result pass", async () => {
    const raised = resolveToolOutputBounder({ maxToolResultBytes: OVER + 1 });
    const resp = await dispatchRequest(
      fakeGateway([sendExt], { clientProjection: raised }),
      req("session/dispatch"),
      spySink(),
    );
    expect(markerOf(at(resp, "result", "content", 0))).toBeUndefined();
  });
});

// ─── The two-tier proof: FULL in store + FULL to model, BOUNDED to client ──

describe("two-tier — oversized tool result is FULL in store + model, BOUNDED at the wire", () => {
  it("client copy is bounded; store + model views keep the full bytes (no mutation)", async () => {
    const timeline = stubTimelineHarness();
    const full = big();
    // Append the tool result exactly as SessionHarness.applyToolResultsBody does.
    await timeline.append({
      kind: "message",
      message: {
        id: "m1",
        role: "tool",
        ts: Date.now(),
        content: [
          {
            type: "tool_result",
            toolUseId: "t1",
            name: "read_file",
            content: [{ type: "text", text: full }],
          },
        ],
      },
    });

    // The DURABLE store view (source of truth) holds the FULL bytes.
    const persisted = timeline.readPersisted();
    expect(at(persisted, 0, "message", "content", 0, "content", 0, "text")).toBe(full);

    // The MODEL view (projection tier — what the next tick renders) is FULL too.
    const model = timeline.read().entries;
    expect(at(model, 0, "message", "content", 0, "content", 0, "text")).toBe(full);

    // The WIRE frame the client folds — the `timeline:command:append`
    // requested envelope carrying the SAME entries — is bounded.
    const projected = projectClientNotification(
      "notifications/subscription/event",
      {
        subscriptionId: "s1",
        envelope: {
          name: TIMELINE_APPEND_EVENT_NAME,
          phase: "requested",
          payload: { entries: model },
        },
      },
      bounder,
    );
    const clientBlock = at(
      projected,
      "envelope",
      "payload",
      "entries",
      0,
      "message",
      "content",
      0,
      "content",
      0,
    );
    expect(markerOf(clientBlock)?.truncated).toBe(true);
    expect((clientBlock as { text: string }).text.length).toBeLessThan(full.length);

    // Projection did NOT mutate the model/store entries — they stay full.
    expect(timeline.read().entries).toBe(model);
    expect(at(model, 0, "message", "content", 0, "content", 0, "text")).toBe(full);
  });
});
