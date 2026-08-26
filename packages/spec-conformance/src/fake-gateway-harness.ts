/**
 * `fakeGatewayHarness()` — a working, simplified {@link GatewayHarnessProtocol}
 * for tests that need a gateway only as a collaborator: a wire method resolving
 * a session through `apps()`, a transport dispatcher routing a frame, a
 * subscription extension asking where an identity's sessions live.
 *
 * A **fake** by the Meszaros taxonomy, not a stub: `apps` / `app` /
 * `appForSession` / `destroySession` really answer from the apps handed in, and
 * `runWireDispatch` really invokes the handler. What it simplifies away is
 * policy — no authorization, no interceptor fold, no substrate.
 *
 * It exists because the alternative is `as unknown as GatewayHarnessProtocol`,
 * which pins nothing: a protocol member added later (the ADR 102 node-resolution
 * seams were three at once) leaves every cast-through double silently missing
 * it, and the double fails at RUNTIME in whichever test happens to reach the
 * member. Typed against spec, the same addition breaks compilation here, once.
 *
 * Home is `@agentick/spec-conformance` rather than `@agentick/gateway` because
 * the protocol is spec's and the consumers are leafward of the gateway —
 * `@agentick/gateway` itself dev-depends on this package, so a fake living
 * there could not reach the harness packages that need it without a cycle.
 *
 * ```ts
 * const gateway = fakeGatewayHarness({ apps: [app] });
 * const gateway = fakeGatewayHarness({ apps: [app], sessionNodeFor: () => ["t"] });
 * ```
 */

import type {
  Connectors,
  AppHarnessProtocol,
  ConnectionInfo,
  DestroySessionInput,
  EventBus,
  EventQuery,
  GatewayDestroySessionResult,
  GatewayHarnessProtocol,
  GatewaySessionRecord,
  IdentityScopedGateway,
  IngressIdentity,
  ProtocolEvent,
  ScopeNodeLease,
  SessionStoreQuery,
  WireExtensionContext,
  WireMethod,
} from "@agentick/spec";

/**
 * Every override is the protocol member itself, so a test that needs bespoke
 * behavior writes the real signature and the compiler checks it.
 *
 * `apps` is the one departure: the array, not the accessor. It powers `apps()`,
 * `app(id)`, `appForSession(id)` and `destroySession(id)` together — the shape
 * every call site was hand-rolling.
 */
export interface FakeGatewayHarnessOptions extends Partial<Omit<GatewayHarnessProtocol, "apps">> {
  /** Apps this gateway hosts. Resolved by `id` on lookup. */
  readonly apps?: readonly AppHarnessProtocol[];
  /** Backs the default `attachScopeNode` lease. Omit and the seam throws. */
  readonly bus?: EventBus;
}

const EMPTY_EVENTS: AsyncIterable<ProtocolEvent> = {
  async *[Symbol.asyncIterator]() {},
};

/** Inert `gateway.connectors` — no connectors registered, verbs are no-ops. */
export function emptyConnectors(): Connectors {
  return {
    register: () => Promise.resolve(),
    unregister: () => Promise.resolve(),
    get: () => undefined,
    list: () => [],
    status: () => undefined,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

export function fakeGatewayHarness(
  options: FakeGatewayHarnessOptions = {},
): GatewayHarnessProtocol {
  const hosted = options.apps ?? [];
  const app = options.app ?? ((appId: string) => hosted.find((a) => a.id === appId));

  const appForSession =
    options.appForSession ??
    (async (sessionId: string) => hosted.find((a) => a.getSession(sessionId) !== undefined));

  return {
    id: options.id ?? "fake-gateway",
    metadata: options.metadata ?? {},
    ready: options.ready ?? Promise.resolve(),

    app,
    apps: () => hosted,
    connectors: options.connectors ?? emptyConnectors(),
    as:
      options.as ??
      ((identity: IngressIdentity): IdentityScopedGateway => ({
        identity,
        // No authorization here — see the docblock. The scoped view resolves
        // the same apps, which is what a projection test asks of it.
        app: () => undefined,
      })),

    sessionNodeFor: options.sessionNodeFor ?? (() => []),
    attachableNodesFor: options.attachableNodesFor ?? (() => [[]]),
    attachScopeNode:
      options.attachScopeNode ??
      ((path: readonly string[]): ScopeNodeLease => {
        if (options.bus === undefined) {
          throw new Error(
            "fakeGatewayHarness: attachScopeNode needs a `bus` option or its own override",
          );
        }
        return { path, bus: options.bus, release: () => {} };
      }),

    appForSession,
    destroySession:
      options.destroySession ??
      (async (sessionId: string, opts?: DestroySessionInput) => {
        const owner = await appForSession(sessionId);
        if (owner === undefined) {
          return {
            sessionId,
            live: {
              found: false,
              abortedExecutions: 0,
              disposedDescendants: 0,
              cancelledDetachedTasks: 0,
            },
            record: { existed: false },
          } satisfies GatewayDestroySessionResult;
        }
        const result = await owner.destroySession(sessionId, opts);
        return { ...result, appId: owner.id };
      }),
    listSessions:
      options.listSessions ??
      (async (_query?: SessionStoreQuery) => ({ items: [] as readonly GatewaySessionRecord[] })),

    authorize: options.authorize ?? (async () => ({ allowed: true })),
    accept: options.accept ?? (async (_info: ConnectionInfo) => {}),
    listen: options.listen ?? (async () => {}),
    close: options.close ?? (async () => {}),
    events: options.events ?? ((_filter?: EventQuery) => EMPTY_EVENTS),

    runWireDispatch:
      options.runWireDispatch ??
      (<R>(
        _method: WireMethod,
        params: unknown,
        _ctx: WireExtensionContext,
        run: (params: unknown) => Promise<R>,
      ) => run(params)),

    ...(options.authorizer !== undefined ? { authorizer: options.authorizer } : {}),
    ...(options.clientProjection !== undefined
      ? { clientProjection: options.clientProjection }
      : {}),
    ...(options.remoteParent !== undefined ? { remoteParent: options.remoteParent } : {}),
    ...(options.wireExtensions !== undefined ? { wireExtensions: options.wireExtensions } : {}),
    ...(options.emitCapabilitiesChanged !== undefined
      ? { emitCapabilitiesChanged: options.emitCapabilitiesChanged }
      : {}),
    ...(options.emitAdmissionFailure !== undefined
      ? { emitAdmissionFailure: options.emitAdmissionFailure }
      : {}),
  };
}
