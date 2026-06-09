# 12 — Gateway (Runtime Root Harness)

**Status:** Revised 2026-06-06 (rewritten end-to-end after v1 deep-read)
**Builds on:** ADR 26 (Harness as the single shape), ADR 27 (Modular built-ins), ADR 29 (Bus overhaul), ADR 31 (Self-similar slottable harness hierarchy)
**Supersedes:** prior "Gateway as stateless front door" framing — v1's `Gateway` was never stateless, and v2's `GatewayHarness` is the harness-shaped continuation of v1's runtime root.

## TL;DR

`GatewayHarness` is the **top-level harness in the v2 hierarchy** —
`GatewayHarness` → `AppHarness` → `SessionHarness`. It owns the
substrate (bus/inbox/journal) Apps and Sessions below it inherit or
wrap. It hosts one or more Apps. It is the lifecycle root.

**Gateway is useful in every deployment tier** — local single-user
agents (OpenClaw / Hermes style), single-tenant cloud, multi-tenant
distributed cloud. The harness is the same in every tier; only the
substrate impl and the extensions differ. **No "stateless front door"
mode.** The runtime root holds state; that's its job.

Network transports (HTTP, WebSocket, SSE, MCP, OpenAI-compat) are
**extensions** on the Gateway, not the Gateway itself. The Gateway
runs without any transport (Tier 0 — embedded library); transports
plug in when adopters need network ingress.

`@agentick/cluster` provides distributed substrate implementations
(`ClusterEventBus`, `ClusterInbox`, `ClusterJournal`) that satisfy
the existing substrate protocols and plug into `GatewayHarness`'s
substrate slots. **No Gateway-side changes for cluster mode** — just
swap the substrate factories.

## Lineage — what `Gateway` actually was in v1

v1's `Gateway` class (`packages/gateway/src/gateway.ts`, ~27K LOC
across 25 files) is the original of this concept. Reading the code,
v1's Gateway:

- **Hosted multiple Apps** via `AppRegistry` — many apps registered,
  one default, routed by session key.
- **Managed sessions** across apps (`SessionManager`) — tracked
  per-client sessions, hibernation, resume.
- **Plugged in transports**: WebSocket, HTTP, SSE, Unix socket, Local,
  EmbeddedSSE. Multiple simultaneously.
- **Plugged in protocol adapters**: `mcp-server`, `openai-compat`,
  `logging` shipped in-tree; adopters added more via `GatewayPlugin`.
- **Held a method registry** — RPC-style custom methods with schemas,
  auth, namespaces.
- **Bounded auth + config** — credentials extraction, role checks,
  runtime config store.
- **Routed events** — per-client event buffers with backpressure,
  channel subscriptions, devtools shadow channel.
- **Stateful throughout** — connection tracking, channel
  subscriptions, plugin methods, client buffers, config store.

v1's Gateway was the runtime root. v2's `GatewayHarness` is the
harness-shaped continuation of the same role, reshaped through ADR 26
(everything is a harness) and ADR 31 (self-similar slottable
hierarchy).

The earlier draft of this doc described a "stateless front door"
shape — that was aspirational and at odds with both v1's reality and
what adopters want. Rewritten.

## Deployment tiers — same harness, different substrate + extensions

Every tier uses the same `GatewayHarness`. What differs:

| Tier | Use case | Substrate | Extensions | Example |
|---|---|---|---|---|
| **0 — Embedded library** | Adopter constructs a Gateway in-process, no transports | `LocalEventBus` + `MemoryJournal` + `LocalInbox` | None | Tests, CLIs, scripts |
| **1 — Local single-user agent** | Long-running agent on user's machine. Optional local transports (Unix socket, HTTP loopback). Persistent journal. | Local substrate + `SQLiteJournal` (when durable persistence needed) | Sandbox, MCP server-side, scheduler/cron, connectors (Telegram, iMessage), skills | OpenClaw / Hermes style — agent runs on your laptop, persists memory across restarts, schedules autonomous tasks, exposes MCP to other tools |
| **2 — Single-tenant cloud** | Hosted single-user / single-org agent. Network transports. Co-located with runtime. | Local substrate or single-node durable (`PostgresJournal`) | Transports (WS/HTTP/SSE), auth, rate limit, multi-app | Hosted agent for a single team; gateway IS the runtime node |
| **3 — Multi-tenant distributed cloud** | Many tenants, gateway fleet, runtime cluster | `@agentick/cluster` substrate (`ClusterEventBus`, `ClusterJournal`, `ClusterInbox` over `@effect/cluster`) | Transports + auth + tenant routing + per-tenant per-session substrate factories | Production multi-tenant SaaS — many gateway pods front a runtime cluster; sessions route to nodes; per-tenant isolation via substrate factories |

**The harness shape is invariant across all four tiers.** What an
adopter writes in Tier 0 (a few lines of code) generalises to Tier 3
(distributed deployment) by:

1. Swapping the substrate factories at the Gateway slot (cluster
   substrate replaces local).
2. Installing transport extensions for network ingress.
3. Installing auth + tenant-routing extensions.

No adopter code changes between tiers beyond construction-time
configuration.

## Anatomy

```ts
class GatewayHarness extends BaseHarness<"gateway", undefined, GatewayInput> {
  // Substrate slots — inherited from BaseHarness, accept instance | factory.
  // Default: LocalEventBus + MemoryJournal + LocalInbox.
  // Cluster mode: ClusterEventBus + ClusterJournal + ClusterInbox factories.
  readonly bus: EventBus;
  readonly inbox: MessageInbox;
  readonly journal: OperationJournal;

  // Apps — eager list or lazy factory (ADR 31).
  // Multi-app support is structural; single-app is the trivial case.
  readonly apps: Map<string, AppHarness>;

  // Extensions installed via the gateway's installer
  // (transport extensions, auth, plugins, methods).
  readonly extensions: GatewayExtensions;

  // Lifecycle
  createApp(element: ReactElement, options?: AppOptions): Promise<AppHarness>;
  app(id: string): AppHarness | undefined;
  closeGateway(): Promise<void>;

  // Observation
  events(filter?: EventQuery, options?: SubscribeOptions): AsyncIterable<ProtocolEvent>;
  metrics(): LogMetrics;
}
```

The `GatewayHarness` itself ships in `@agentick/gateway` (or the
`packages/gateway/src/v2/` subfolder during the v1 ⇄ v2 coexistence
period). It is **pure runtime root** — no transports, no protocol
adapters, no auth machinery in its core. Those are extensions.

## What Gateway owns — what it delegates

| Owned by `GatewayHarness` core | Delegated to extensions |
|---|---|
| Apps registry + lifecycle | Network transports (HTTP/WS/SSE/Unix/MCP/OpenAI-compat) |
| Substrate (bus/inbox/journal) | Auth + identity boundary |
| Cross-app event observation | Rate limiting + admission control |
| Operation framework lifecycle | Method registry / RPC surface |
| Extension installation (`AppExtension`, future `GatewayExtension`) | Per-client event buffers + resume |
| `events()` + `metrics()` cross-app substrate observability | Plugin system (MCP server, OpenAI-compat, logging) |
| Per-app substrate scoping (Apps inherit Gateway substrate by default) | Persistent storage adapters (Postgres journal, etc.) |

The runtime-root role is small. The breadth comes from extensions
hung off it.

## Composition with the cluster module

`@agentick/cluster` is the distributed-substrate package. It implements
`EventBus`, `MessageInbox`, and `OperationJournal` over
`@effect/cluster` primitives. **It does not subclass GatewayHarness or
introduce a separate harness type** — it provides substrate
implementations that satisfy the same protocols `LocalEventBus` /
`MemoryJournal` / `LocalInbox` do.

```ts
// Single-node Tier 1/2 (local substrate, default):
const gateway = createGateway({
  apps: { /* ... */ },
});

// Tier 3 distributed cluster:
const gateway = createGateway({
  apps: { /* ... */ },
  bus: ClusterEventBus.factory({ /* cluster config */ }),
  journal: ClusterJournal.factory({ /* cluster config */ }),
  inbox: ClusterInbox.factory({ /* cluster config */ }),
});
```

Per-tenant isolation in Tier 3 is achieved through the session-level
substrate slots (ADR 31): each session constructs its own substrate
wrapping the gateway-level cluster substrate with tenant-scoped
filtering. No `tenantId` field anywhere in the framework — the pattern
is emergent from substrate factories + closure capture + the
`metadata: Record<string, unknown>` bag.

## Network transports as extensions

In v1, transports were first-class on the `Gateway` class. In v2,
they're `GatewayExtension`s. Each transport package ships its own
extension factory:

```ts
import { createGateway } from "@agentick/gateway";
import { withHttpSse } from "@agentick/gateway-http-sse";
import { withWebSocket } from "@agentick/gateway-ws";

const gateway = await createGateway({
  apps: { ... },
  extensions: [
    withHttpSse({ port: 3000 }),
    withWebSocket({ port: 3001 }),
  ],
});
```

Each transport extension:
- Installs at gateway construction time
- Owns its own network resources (sockets, HTTP server, etc.)
- Routes incoming requests to gateway methods (or directly to app/session methods)
- Subscribes to relevant substrate events for outbound streaming
- Registers `onClose` to clean up

This matches the canonical extension pattern from `create-extension`
+ `create-harness` skills. Transports are big extensions — they may
own their own substrate (per-connection event buffers, sequence
counters), but they don't replace the gateway's substrate.

**Transport packages — proposed v2 layout (Phase 5+):**

```
@agentick/gateway-http-sse      → HTTP + SSE (browsers, simple REST)
@agentick/gateway-streamable    → Streamable HTTP (MCP-style)
@agentick/gateway-ws            → WebSocket (browsers, native)
@agentick/gateway-grpc          → gRPC (service-to-service)
@agentick/gateway-unix-socket   → Unix socket (same-machine IPC)
@agentick/gateway-mcp-server    → Expose Gateway over MCP wire (skip's gateway plugin in v1)
@agentick/gateway-openai-compat → OpenAI-compatible REST shim (v1 had this as a plugin)
@agentick/gateway-express       → Express middleware integration (V1-INHERITED naming)
```

Each ships independently. Adopters pick what they need. Library users
(Tier 0) install none.

## Plugin model (post-Phase-4)

V1's plugin system (`GatewayPlugin`) gave adopters a way to:
- Register custom methods
- Subscribe to gateway events
- Add HTTP routes
- Hold per-plugin state

In v2, the equivalent is the `GatewayExtension` shape (parallel to
`AppExtension` / `SessionExtension` per ADR 31). Plugins from v1
(`mcp-server`, `openai-compat`, `logging`) become extensions. Specific
extensions are listed in V1-GATEWAY-PARITY-TRACKER.md.

## Spec surface (proposed — Phase 4)

```ts
// @agentick/spec-next

export interface GatewayHarnessProtocol {
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>>;

  // Substrate (inherited from BaseHarness)
  readonly bus: EventBus;
  readonly inbox: MessageInbox;
  readonly journal: OperationJournal;

  // Apps
  createApp<P>(input: CreateAppInput<P>): Promise<AppHarnessProtocol<P>>;
  app(id: string): AppHarnessProtocol | undefined;
  apps(): readonly AppHarnessProtocol[];

  // Lifecycle
  closeGateway(): Promise<void>;
  close(): Promise<void>; // alias

  // Observation
  events(
    filter?: EventQuery,
    options?: SubscribeOptions,
  ): AsyncIterable<ProtocolEvent>;

  // Extensions
  readonly extensions: GatewayExtensions; // typed bag, augmentable via declare module
}

export interface GatewayExtension extends ExtensionBase {
  readonly target: "gateway";
  install(installer: GatewayInstaller): void | Promise<void>;
}

export interface GatewayInstaller extends BaseInstaller {
  readonly kind: "gateway";
  // Per ADR 26 BaseInstaller: hostId, substrate, registerNamespace,
  // getNamespace, onClose.
  // Gateway-specific additions TBD during Phase 4 build.
}

// Module-augmentation slot
export interface GatewayExtensions {}
```

This shape lands in Phase 4 alongside the harness impl. Spec changes
flagged as `[PROPOSAL]` until reviewed.

## Open design questions for Phase 4

1. **App router shape** — eager list vs. lazy factory vs. router predicate. ADR 31 Table line 138 lists all three as options; need to pick the canonical shape for v2 vs. defer.
2. **Method registry vs. tool dispatch** — v1's method registry overlapped with what tool dispatch does in v2. Drop methods entirely and use session.dispatch / app.dispatch? Or keep methods as gateway-level RPC?
3. **Session-key routing** — v1 `Gateway` accepted a session key that named the target app. In v2 with `gateway.app(id).createSession()` / `gateway.app(id).session(sid)`, do we keep the session-key concept or expose apps + sessions independently?
4. **Cluster substrate at gateway slots — defaults?** — should gateway slots default to `LocalEventBus.factory()` or to a "ClusterAware" wrapper that's local-only when no cluster configured?
5. **What's the runtime entry point?** — `createGateway()` (matches v1) vs. `createApp()` continues to work standalone (no gateway required, per ADR 31).

These are deliberately open in this revision. They get answered during the Phase 4 build with code in hand.

## What's deferred from Phase 4 (and to where)

| Capability | Deferred to | Rationale |
|---|---|---|
| Network transports (HTTP/WS/SSE/etc.) | Phase 5+ (per-transport packages) | Each transport is its own package; thin gateway scaffold doesn't need them |
| MCP server-side (gateway as MCP host) | Phase 5+ | v1 had this as a plugin; v2 will be a transport extension |
| OpenAI-compat shim | Phase 5+ | v1 had as plugin; v2 transport extension |
| Auth + identity | Phase 5+ | Cross-cutting; needs its own design pass |
| Per-client event buffers + resume | Phase 5+ | Tied to transports |
| Method registry / RPC | Phase 5+ or replaced by dispatch | Open design question |
| Cluster substrate (`@agentick/cluster`) | Phase D of ADR 29 | Phase 4 builds against `LocalEventBus`; Phase D ships cluster impl |
| Persistent journals (`SqliteJournal`, `PostgresJournal`) | Per-adapter packages, when needed | Out of gateway scope |

## References

- `docs/proposals/v2/blueprint/31-harness-hierarchy.md` — the harness hierarchy that frames Gateway as the runtime root
- `docs/proposals/v2/blueprint/29-bus-overhaul.md` — `EventLog<E>` substrate; cluster substrate plugs into Gateway slots
- `docs/proposals/v2/blueprint/26-harness-api-shape.md` — harness as the single shape (Gateway is one)
- `docs/proposals/v2/blueprint/27-modular-built-ins.md` — extensions ARE harnesses architecturally
- `docs/proposals/v2/V1-GATEWAY-PARITY-TRACKER.md` — explicit inventory of v1 Gateway capabilities and v2 disposition (TBD)
- `packages/gateway/src/gateway.ts` (v1) — the original Gateway implementation; ~27K LOC; read for lessons before reshaping
