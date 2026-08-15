# @agentick/spec-conformance

**The executable half of the contract.** [@agentick/spec](../spec) declares the shape an implementation must have; this package declares the _behavior_ — as a runnable test suite per protocol. If you are writing a transport, a store, a model adapter, an executor, or an alternate compiler, running the matching suite is what "conforms" means here.

Internal workspace package — not published to npm. Depend on it as a `devDependency`; `vitest` is a peer, supplied by the consuming package.

## Quick start

Implement the port, then hand the suite a factory that builds a fresh instance. That is the whole integration — the suite mounts its own `describe` block, so a spec file can be four lines.

```ts
// packages/my-transport/src/__tests__/server-transport.spec.ts
import { runServerTransportConformance } from "@agentick/spec-conformance";
import type { GatewayHarnessProtocol, ServerTransport } from "@agentick/spec";

function memoryServerTransport(): ServerTransport {
  let host: GatewayHarnessProtocol | undefined;
  return {
    id: "memory",
    async listen(h) {
      host ??= h; // idempotent — a second listen while bound is a no-op
    },
    async close() {
      host = undefined; // idempotent, and re-listenable afterwards
    },
  };
}

runServerTransportConformance("memoryServerTransport", memoryServerTransport);
```

Six tests now run: a stable string `id`, bind on `listen(host)`, teardown on `close()`, `listen()` idempotence, `close()` idempotence on an unbound transport, and a clean bind → close → bind cycle. Drop the `??=` and the third one goes red.

**The factory is called per test, not per file.** Every suite builds a fresh instance for each assertion so state cannot leak between them. Close what you open — suites that need teardown take it explicitly (`setup()` returns `{ transport, teardown }`; `makeInstance()` returns `{ instance, close }`).

## What ships

| Suite                                            | Certifies                       | Proves what types cannot                                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runJournalConformance(factory)`                 | `OperationJournal`              | Append/read ordering, surface + name-prefix + scope filtering, `(opId, phase)` idempotence, tail delivery, orphan recovery                                                                                                                    |
| `runEventBusConformance(factory)`                | `EventBus`                      | Lazy fan-out to matching subscribers only, in-order batch delivery, `hasSubscriberFor` accuracy, no-op with no subscribers                                                                                                                    |
| `runInboxConformance(factory)`                   | `MessageInbox`                  | Duplicate-address rejection, address reuse after unsubscribe, `ask` timeout and handler-error surfacing, exactly-once per `messageId`                                                                                                         |
| `runWireConformance(codec)`                      | A transport's JSON-RPC codec    | Every frame kind survives encode → decode → validate in the transport's _native_ serialization; batch and malformed-frame rejection                                                                                                           |
| `runTransportConformance(name, factory)`         | `ClientTransport`               | State-machine transitions and listener notification, RPC correlation, typed `TransportError` kinds, cancellation wire emit, subscription multiplexing, progress streams                                                                       |
| `runServerTransportConformance(name, factory)`   | `ServerTransport`               | Bind/teardown, idempotence on both verbs, re-listen after close                                                                                                                                                                               |
| `runCompilerConformance(factory)`                | `CompilerProtocol`              | Mount idempotence on `mountId`, `NotMounted` on unmounted ids, render output shape, rerender, snapshot round-trip, unmount cleanup — and that lifecycle projection is an _optional_ capability                                                |
| `runToolExecutorConformance(factory)`            | `ToolExecutorProtocol`          | Registry semantics, the two doors (model vs. dispatch exposure), all three handler return currencies normalizing identically, validation and lookup failure shapes, handler errors, abort                                                     |
| `runExecutorConformance(factory, errorFixtures)` | `LanguageModelExecutor`         | Project/run phase isolation, abort, cross-adapter parity (base64 image sources, sampling params, `providerOptions` threading, the stream surface), and provider-error classification end-to-end on both the streaming and non-streaming seams |
| `runLoopExecutorConformance(factory)`            | `LoopExecutorProtocol`          | Single-tick happy path, the tool-call round trip, the max-tick stop, abort mid-loop                                                                                                                                                           |
| `runSessionConformance(factory)`                 | `SessionHarnessProtocol`        | `send` happy path, timeline integration, snapshot, the state applicator, close, lifecycle notification, execution-handle shape                                                                                                                |
| `runDataBridgeConformance(factory)`              | `DataBridge`                    | `peek`/`fetch` cache states, in-flight join on the same key, rejected-fetch replay, subscribe notification points, `invalidate` / `invalidateTag` / TTL expiry                                                                                |
| `runLoopBridgeConformance(factory)`              | `LoopBridge`                    | Both continuation verbs are callable with and without a reason                                                                                                                                                                                |
| `runAgentickErrorConformance(factory)`           | An error-class registry         | Every expected tag registered, each resolving to a real `AgentickError` subclass, codec round-trip, and unknown-tag forwarding that re-serializes under the _original_ tag                                                                    |
| `runObservabilityCtxConformance(label, factory)` | Any `Observability`-bearing ctx | The facet lands _flat_ on ctx, `log` is callable with all eight RFC-5424 levels plus the `warn` alias and `.with`, `trace` resolves the callback's value, and `log`/`metrics` never throw                                                     |
| `runOpsCtxConformance(label, factory)`           | Any `Ops`-bearing ctx           | `run` / `runner` land flat, both `run` arities execute, and `runner` leaks no publish surface                                                                                                                                                 |
| `runHarnessSlotConformance(options)`             | A `withX` slot                  | Each accepted slot form resolves to the same config, the array shorthand collapses to the declared key, and every `use:` conflict throws                                                                                                      |

The ctx-facet suites are the reason a facet stays uniform: point them at any surface that carries `ctx` — a tool handler, a wire dispatch — and the same assertions run.

```ts
import {
  fakeToolHandlerCtx,
  runObservabilityCtxConformance,
  runOpsCtxConformance,
} from "@agentick/spec-conformance";

runObservabilityCtxConformance("ToolHandlerCtx (in-process)", () => fakeToolHandlerCtx());
runObservabilityCtxConformance("ToolHandlerCtx (mcp)", () =>
  fakeToolHandlerCtx({ transport: "mcp" }),
);
runOpsCtxConformance("ToolHandlerCtx (mcp)", () => fakeToolHandlerCtx({ transport: "mcp" }));
```

## Shared fixtures

`fakeToolHandlerCtx(overrides?)` builds a complete `ToolHandlerCtx` with working defaults: `transport: "in-process"`, `task: "auto"`, no-op `setState` / `emit`, and a live observability facet. Override any field, including the transport discriminator — the MCP-side result is structurally identical to an `McpRequestContext`.

```ts
import { fakeToolHandlerCtx } from "@agentick/spec-conformance";

const ctx = fakeToolHandlerCtx({ toolCallId: "tc-1" });

const mcpCtx = fakeToolHandlerCtx({
  toolCallId: "tc-2",
  transport: "mcp",
  mcp: { user: { id: "alice", roles: ["admin"] } },
});
```

Use it in every test that needs a ctx rather than hand-rolling one. When the canonical shape gains a required field, one edit here propagates; hand-rolled literals each break independently.

`defaultSessionConformanceDeps(...)` is the matching fixture for the session suite — a full stub dependency set (journal, bus, inbox, compiler, loop, model executor, tool executor, target, agent root) that a factory can use wholesale or override field by field.

## Patterns

**One spec file per implementor, calling the matching `run*`.** Wire-specific behavior — subprotocol negotiation, peer credentials, HTTP topology, a store's SQL dialect — stays in the implementing package's own tests. The suite covers the abstraction; the package covers its wire.

**Namespace suites ship from their namespace.** Anything with its own package certifies from there, not here: `runTimelineHarnessConformance` and `runTimelineStoreConformance` from [@agentick/timeline](../timeline)`/testing`, `runKnobsHarnessConformance` from [@agentick/knobs](../knobs), and so on. This package holds the substrate and spine protocols plus the cross-cutting facets. Tests live where their dependencies live — and the error-registry suite lives here specifically so [@agentick/spec](../spec) needs no dependency on its own fixtures.

**Certify the seam, not the sugar.** `CollectionStore` and `LogStore` are profiles over one `Store` seam, so a suite written against the seam certifies both. Sugar (`get` / `put` / `list`) is derived; behavior lives underneath.

## Roadmap & known gaps

- **`runHarnessConformance` and `runRendererConformance` are signature-only.** Both throw when called. The invariants they will assert — the phase contract (exactly one `requested` and one `terminal` per command, `before` only when interceptable, `delta` strictly between), middleware nesting order, verdict-merge precedence, cancellation outcomes; and for renderers, input immutability, JSON-shaped output, and capability-declaration honesty — are documented in source and enforced today only by each implementation's own tests.
- **`runHarnessSlotConformance` has one caller.** Only the skills slot runs it, so the uniform-across-packages promise is unproven at scale.
- **No store-port suite lives here.** `Store` / `CollectionStore` / `LogStore` adapters certify against the owning namespace's suite instead; there is no archetype-level runner, despite the seam supporting one.
- **`runExecutorConformance` needs a bus it can subscribe to.** An adapter that does not expose the bus it was wired with may pass a fresh one, but the delta-envelope assertion then silently skips rather than failing.
- **The classification block needs a stub that fails on both seams.** Each fixture runs twice — once through `execute()`, once through `executeStream()` — and asserts the same tag on each rejection, because streaming is the path production takes and an adapter can classify differently there. A factory whose `throws` reaches only the non-streaming call therefore fails the streaming half rather than skipping it; the skip is reserved for an executor with no streaming seam at all (`supportsStreaming: false`), which is reported as skipped rather than passed.
- **The suites are vitest-bound.** `describe` / `it` / `expect` are imported directly, so they cannot run under another test runner.

## Verified by

- `src/__tests__/agentick-error-conformance.spec.ts` — applies `runAgentickErrorConformance` to the framework's own error registry, with an explicit constructor stub per tag, so every shipped error class is exercised for registry membership, instance shape, and codec round-trip. Adding an error class means adding a row; the suite then covers it automatically.
- `src/__tests__/observability-conformance.spec.ts` — applies both ctx-facet suites to `fakeToolHandlerCtx` in _both_ transports, proving the shared fixture is itself conformant, so every downstream test that builds a ctx through it inherits a conformant surface.
- `src/__tests__/client-entry-browser-safety.spec.ts`, `client-entry-channel-names.spec.ts`, `subpath-augment-anti-rot.spec.ts`, `side-effects-registration.spec.ts`, `types-versions-node10.spec.ts` — the workspace-wide anti-rot sweeps. They are filesystem- and manifest-driven, so a new package is covered the moment it exists: no `node:*` builtin reachable through any browser entry, every channel name a package declares re-exported from its `/client` barrel (so a browser bundle never reaches for the root barrel to get one), every subpath barrel importing the augment that declares the slot it reads, every subpath whose whole job is a side effect listed in its package's `sideEffects` allowlist, and every published subpath carrying its node10 `typesVersions` fallback.
- Every other suite is verified by its consumers, which is the point. Journal, bus, and inbox run in [@agentick/runtime](../runtime); compiler, data-bridge, and loop-bridge in [@agentick/compiler-react](../compiler-react); the executor suite in [@agentick/model-executor](../model-executor), [@agentick/model-anthropic](../model-anthropic), [@agentick/model-openai](../model-openai), [@agentick/model-google](../model-google), and [@agentick/model-ai-sdk](../model-ai-sdk); the loop suite in [@agentick/loop-executor](../loop-executor); the tool-executor suite in [@agentick/tool-executor](../tool-executor); the session suite in [@agentick/session](../session); the slot suite in [@agentick/skills](../skills); wire, transport, and server-transport across [@agentick/transport-http](../transport-http), [@agentick/transport-websocket](../transport-websocket), [@agentick/transport-unix-socket](../transport-unix-socket), [@agentick/transport-in-process](../transport-in-process), and [@agentick/gateway](../gateway); and the ctx-facet suites additionally in [@agentick/gateway](../gateway) against a real wire dispatch context.
