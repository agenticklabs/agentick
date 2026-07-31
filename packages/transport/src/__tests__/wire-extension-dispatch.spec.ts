/**
 * Wire-extension dispatch — end-to-end tests for the registry lookup
 * path added by #295 Phase B.
 *
 * A dispatcher backed by a fake gateway that exposes a
 * WireExtensionRegistry populated with adopter extensions. Confirms:
 *
 *   - Registered extension methods dispatch through the registry
 *     BEFORE the hardcoded switch fires (registry wins).
 *   - Handlers receive a valid {@link WireExtensionContext} with
 *     `gateway` always present + `session`/`app` resolved from
 *     `params.sessionId` / `params.appId` when present.
 *   - `ctx.publish` fires `sink.sendNotification` for declared
 *     notifications; undeclared notifications throw.
 *   - `_extensions/list` enumerates registered extensions.
 *   - Unknown methods return `MethodNotFound`.
 *   - Handler exceptions surface as JSON-RPC error responses.
 *
 * The fake gateway is deliberately hand-rolled — the real gateway
 * lives in `@agentick/gateway` and would create an upward dep
 * cycle for a transport-package test. The hand-rolled fake shows
 * exactly what surface the dispatcher requires.
 */

import { describe, expect, it } from "vitest";
import {
  defineWireExtension,
  ErrorCode,
  WIRE_PROTOCOL_VERSION,
  type AppHarnessProtocol,
  type GatewayHarnessProtocol,
  type InitializeResult,
  type JsonRpcRequest,
  type SessionHarnessProtocol,
  type WireExtension,
  type WireExtensionRegistry,
  type WireServerDescriptor,
} from "@agentick/spec";
import { createWireExtensionRegistry } from "@agentick/gateway";

import { dispatchRequest, type DispatchHost, type DispatchSink } from "../server/dispatch.js";

// TypeScript declaration merges — the tests use synthetic method
// names ("myExt/*"). Merge them into WireMethods so the extension
// definition + registry types line up.
declare module "@agentick/spec" {
  interface WireMethods {
    "myExt/echo": { params: { message: string }; result: { echoed: string } };
    "myExt/ping": { params: object; result: { ok: true } };
    "myExt/boom": { params: object; result: never };
    "myExt/sessionOp": { params: { sessionId: string }; result: { ok: true } };
    "myExt/appOp": { params: { appId: string }; result: { ok: true } };
    "myExt/notify": { params: object; result: null };
  }
  interface WireNotifications {
    "myExt/thing-happened": { readonly at: number };
  }
}

// ---------------------------------------------------------------------------
// Fake gateway (implements only what the dispatcher touches)
// ---------------------------------------------------------------------------

interface FakeGateway extends GatewayHarnessProtocol {
  readonly _wireExtensions: WireExtensionRegistry;
  readonly _apps: ReadonlyMap<string, AppHarnessProtocol>;
  readonly _sessions: ReadonlyMap<string, SessionHarnessProtocol>;
}

function fakeGateway(
  extensions: readonly WireExtension[],
  {
    apps = new Map(),
    sessions = new Map(),
  }: {
    readonly apps?: ReadonlyMap<string, AppHarnessProtocol>;
    readonly sessions?: ReadonlyMap<string, SessionHarnessProtocol>;
  } = {},
): FakeGateway {
  const registry = createWireExtensionRegistry();
  for (const ext of extensions) registry.register(ext);
  registry.seal();

  // The fake apps map iterated by findSessionOrUndef needs each app
  // to expose getSession(id) — synthesized on the fly from `sessions`.
  const augmentedApps = new Map<string, AppHarnessProtocol>(apps);
  if (sessions.size > 0 && augmentedApps.size === 0) {
    const fakeApp = {
      id: "fake-app",
      metadata: {},
      ready: Promise.resolve(),
      getSession: (sessionId: string) => sessions.get(sessionId),
      listSessions: () => [],
      appReady: Promise.resolve(),
      closeApp: async () => {},
      close: async () => {},
      events: (() => ({
        [Symbol.asyncIterator]: async function* () {},
      })) as AppHarnessProtocol["events"],
    } as unknown as AppHarnessProtocol;
    augmentedApps.set("fake-app", fakeApp);
  }

  return {
    id: "fake-gateway",
    metadata: {},
    ready: Promise.resolve(),
    app: (appId: string) => augmentedApps.get(appId),
    apps: () => Array.from(augmentedApps.values()),
    // Session-address resolution + the gateway destroy verb: present to satisfy
    // the protocol; no test here dispatches `gateway/destroy_session`.
    appForSession: async (sessionId: string) =>
      Array.from(augmentedApps.values()).find((a) => a.getSession(sessionId) !== undefined),
    destroySession: async (sessionId: string) => ({
      sessionId,
      live: {
        found: false,
        abortedExecutions: 0,
        disposedDescendants: 0,
        cancelledDetachedTasks: 0,
      },
      record: { existed: false },
    }),
    listen: async () => {},
    close: async () => {},
    // No authorizer on this fake → the dispatch gate's policy layer never
    // reaches `authorize`; the member exists only to satisfy the protocol.
    authorize: () => Promise.resolve({ allowed: true }),
    accept: () => Promise.resolve(),
    events: () => ({ [Symbol.asyncIterator]: async function* () {} }),
    runWireDispatch: (_m, _p, _ctx, run) => run(_p),
    wireExtensions: () => registry,
    _wireExtensions: registry,
    _apps: augmentedApps,
    _sessions: sessions,
  };
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const echoExt: WireExtension = defineWireExtension({
  name: "@test/echo",
  namespace: "myExt",
  version: "0.1.0",
  methods: {
    "myExt/echo": async ({ message }) => ({ echoed: message }),
    "myExt/ping": async () => ({ ok: true as const }),
    "myExt/boom": async () => {
      throw new Error("kaboom");
    },
    "myExt/sessionOp": async ({ sessionId }, ctx) => {
      if (!ctx.session) throw new Error(`no session in ctx for sessionId=${sessionId}`);
      return { ok: true as const };
    },
    "myExt/appOp": async ({ appId }, ctx) => {
      if (!ctx.app) throw new Error(`no app in ctx for appId=${appId}`);
      return { ok: true as const };
    },
    "myExt/notify": async (_, ctx) => {
      ctx.publish("myExt/thing-happened", { at: 42 });
      return null;
    },
  },
  notifications: ["myExt/thing-happened"],
});

const echoExtEmptyNotifs: WireExtension = defineWireExtension({
  name: "@test/echo-empty-notifs",
  namespace: "otherExt",
  methods: {
    "otherExt/publishUndeclared": async (_, ctx) => {
      // Declared notifications list is `["otherExt/declared"]`; try to
      // publish something not in it — should throw.
      ctx.publish("myExt/thing-happened", { at: 99 });
      return null;
    },
  },
  notifications: ["otherExt/declared"],
});

// Extend WireMethods + WireNotifications for the second extension too.
declare module "@agentick/spec" {
  interface WireMethods {
    "otherExt/publishUndeclared": { params: object; result: null };
  }
  interface WireNotifications {
    "otherExt/declared": { readonly ok: true };
  }
}

function req(method: string, params: unknown, id = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params: params as Record<string, unknown> };
}

describe("dispatchRequest — wire extension registry integration", () => {
  it("routes registry-owned method to the extension handler", async () => {
    const gw = fakeGateway([echoExt]);
    const resp = await dispatchRequest(gw, req("myExt/echo", { message: "hello" }), stubSink());
    expect(resp).toEqual({ jsonrpc: "2.0", id: 1, result: { echoed: "hello" } });
  });

  it("returns MethodNotFound when the method isn't in the registry or builtins", async () => {
    const gw = fakeGateway([echoExt]);
    const resp = await dispatchRequest(gw, req("nonexistent/method", {}), stubSink());
    expect(resp).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: { code: ErrorCode.MethodNotFound },
    });
  });

  it("surfaces handler exceptions as JSON-RPC error responses", async () => {
    const gw = fakeGateway([echoExt]);
    const resp = await dispatchRequest(gw, req("myExt/boom", {}), stubSink());
    expect(resp).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: { code: ErrorCode.InternalError },
    });
  });

  it("_extensions/list enumerates registered extensions", async () => {
    const gw = fakeGateway([echoExt]);
    const resp = await dispatchRequest(gw, req("_extensions/list", {}), stubSink());
    expect(resp).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        extensions: [
          {
            name: "@test/echo",
            namespace: "myExt",
            version: "0.1.0",
            methods: expect.arrayContaining(["myExt/echo", "myExt/ping"]),
            notifications: ["myExt/thing-happened"],
          },
        ],
      },
    });
  });

  it("_extensions/list returns an empty list when no registry is present", async () => {
    // Simulate a gateway that doesn't implement wireExtensions() at all.
    const bareGw: DispatchHost = {
      id: "bare",
      metadata: {},
      ready: Promise.resolve(),
      app: () => undefined,
      apps: () => [],
      appForSession: async () => undefined,
      destroySession: async (sessionId: string) => ({
        sessionId,
        live: {
          found: false,
          abortedExecutions: 0,
          disposedDescendants: 0,
          cancelledDetachedTasks: 0,
        },
        record: { existed: false },
      }),
      listen: async () => {},
      close: async () => {},
      authorize: () => Promise.resolve({ allowed: true }),
      accept: () => Promise.resolve(),
      events: () => ({ [Symbol.asyncIterator]: async function* () {} }),
      runWireDispatch: (_m, _p, _ctx, run) => run(_p),
    };
    const resp = await dispatchRequest(bareGw, req("_extensions/list", {}), stubSink());
    expect(resp).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { extensions: [] },
    });
  });

  it("initialize + ping short-circuit BEFORE the registry lookup", async () => {
    // The registry-based path only runs when neither `initialize` nor
    // `ping` matches. Confirm they still work with a registry present.
    const gw = fakeGateway([echoExt]);
    const initResp = await dispatchRequest(
      gw,
      req("initialize", {
        protocolVersion: "v1",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      }),
      stubSink(),
    );
    expect(initResp).toMatchObject({ result: { protocolVersion: "v1" } });

    const pingResp = await dispatchRequest(gw, req("ping", {}), stubSink());
    expect(pingResp).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("resolves ctx.session from params.sessionId (duck-typed)", async () => {
    const fakeSession = { id: "sess-1" } as unknown as SessionHarnessProtocol;
    const gw = fakeGateway([echoExt], { sessions: new Map([["sess-1", fakeSession]]) });
    const resp = await dispatchRequest(
      gw,
      req("myExt/sessionOp", { sessionId: "sess-1" }),
      stubSink(),
    );
    expect(resp).toMatchObject({ result: { ok: true } });
  });

  it("resolves ctx.app from params.appId", async () => {
    const fakeApp = { id: "app-1" } as unknown as AppHarnessProtocol;
    const gw = fakeGateway([echoExt], { apps: new Map([["app-1", fakeApp]]) });
    const resp = await dispatchRequest(gw, req("myExt/appOp", { appId: "app-1" }), stubSink());
    expect(resp).toMatchObject({ result: { ok: true } });
  });

  it("ctx.publish routes declared notifications to the sink", async () => {
    const gw = fakeGateway([echoExt]);
    const sink = spySink();
    const resp = await dispatchRequest(gw, req("myExt/notify", {}), sink);
    expect(resp).toMatchObject({ result: null });
    expect(sink.notifications).toEqual([{ method: "myExt/thing-happened", params: { at: 42 } }]);
  });

  it("ctx.publish rejects notifications not in the extension's declared list", async () => {
    const gw = fakeGateway([echoExtEmptyNotifs]);
    const resp = await dispatchRequest(gw, req("otherExt/publishUndeclared", {}), stubSink());
    expect(resp).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: ErrorCode.InternalError,
        data: expect.objectContaining({ reason: expect.stringContaining("cannot publish") }),
      },
    });
  });

  it("ctx.publish rejects when extension declared no notifications at all", async () => {
    // Extension with NO `notifications` array = declaring "publishes
    // nothing." Attempting to publish anything must throw.
    const extNoNotifs: WireExtension = defineWireExtension({
      name: "@test/no-notifs",
      namespace: "silent",
      methods: {
        "silent/publishAttempt": async (_, ctx) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (ctx.publish as any)("silent/anything", {});
          return null;
        },
      },
    });
    // Merge the synthetic method into WireMethods for typecheck.
    declareModuleAugmentationForNoNotifsExt();
    const gw = fakeGateway([extNoNotifs]);
    const resp = await dispatchRequest(gw, req("silent/publishAttempt", {}), stubSink());
    expect(resp).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: ErrorCode.InternalError,
        data: expect.objectContaining({
          reason: expect.stringContaining("no notifications declared"),
        }),
      },
    });
  });
});

// ---------------------------------------------------------------------------
// initialize — the handshake answers with what is wired, not a constant (#252)
// ---------------------------------------------------------------------------

describe("dispatchRequest — initialize", () => {
  const clientHello = {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  };

  async function initializeAgainst(
    gw: DispatchHost,
    server?: WireServerDescriptor,
    params: unknown = clientHello,
  ) {
    const resp = await dispatchRequest(
      gw,
      req("initialize", params),
      stubSink(),
      undefined,
      server,
    );
    return resp as { result?: InitializeResult; error?: { code: number; data?: unknown } };
  }

  it("derives `subscriptions` from the registry — false with no sub/* extension", async () => {
    // The flag is a promise that `sub/subscribe` will answer. This host
    // registers only `myExt/*`, so the honest answer is no.
    const { result } = await initializeAgainst(fakeGateway([echoExt]));
    expect(result?.capabilities.subscriptions).toBe(false);
    // Not implemented anywhere on the server yet — see TODO(wire-resume).
    expect(result?.capabilities.cursorResume).toBe(false);
    expect(result?.capabilities.mcpSurface).toBe(false);
    // Dispatcher-intrinsic: `wire.progress` and `registerInFlight` are handed
    // to every handler by this dispatcher, so both hold for any host.
    expect(result?.capabilities.progress).toBe(true);
    expect(result?.capabilities.cancellation).toBe(true);
  });

  it("derives `subscriptions: true` once the sub/* methods resolve", async () => {
    const subExt = defineWireExtension({
      name: "test#sub",
      namespace: "sub",
      methods: {
        "sub/subscribe": async () => ({ subscriptionId: "s-1" }),
        "sub/unsubscribe": async () => null,
      },
    });
    const { result } = await initializeAgainst(fakeGateway([subExt]));
    expect(result?.capabilities.subscriptions).toBe(true);
  });

  it("takes serverInfo + framing flags from the SERVING transport", async () => {
    const { result } = await initializeAgainst(fakeGateway([echoExt]), {
      name: "@agentick/transport-unix-socket",
      version: "9.9.9",
      batch: true,
    });
    expect(result?.serverInfo).toEqual({
      name: "@agentick/transport-unix-socket",
      version: "9.9.9",
    });
    expect(result?.capabilities.batch).toBe(true);
    // Declared nothing about SSE ⇒ not advertised.
    expect(result?.capabilities.streamableHttp).toBe(false);
  });

  it("names the dispatcher when no transport declared itself", async () => {
    // A bare host calling `dispatchRequest` directly. The one true thing
    // available is that the dispatcher answered.
    const { result } = await initializeAgainst(fakeGateway([echoExt]));
    expect(result?.serverInfo.name).toBe("@agentick/transport");
    expect(result?.capabilities.batch).toBe(false);
  });

  it("rejects a protocolVersion it does not speak", async () => {
    const { error } = await initializeAgainst(fakeGateway([echoExt]), undefined, {
      ...clientHello,
      protocolVersion: "v2",
    });
    expect(error?.code).toBe(ErrorCode.InvalidParams);
    expect(error?.data).toMatchObject({ received: "v2", expected: WIRE_PROTOCOL_VERSION });
  });

  it("tolerates params with no protocolVersion at all", async () => {
    // Absent is not a mismatch: nothing was claimed, so nothing conflicts.
    const { result } = await initializeAgainst(fakeGateway([echoExt]), undefined, {});
    expect(result?.protocolVersion).toBe(WIRE_PROTOCOL_VERSION);
  });
});

// Local no-op — the declare-module block below lives at file scope,
// but grouping the "synthetic types for this suite" together as one
// call makes the extension body above compile without cluttering the
// module-level types section.
function declareModuleAugmentationForNoNotifsExt(): void {}
declare module "@agentick/spec" {
  interface WireMethods {
    "silent/publishAttempt": { params: object; result: null };
  }
}
