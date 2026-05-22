# ADR 26 — Harness as the single shape

**Status:** Proposed — 2026-05-22 (rewritten from the namespacing-focused draft)
**Touches:** Every harness protocol interface in `@agentick/spec` (`SessionHarnessProtocol`, `AppHarnessProtocol`, `ReconcilerProtocol`, `ToolExecutorProtocol`, `LoopExecutorProtocol`, sandbox + MCP harness protocols), `HookBridges` (which becomes a bag of harnesses), the concrete implementations across the workspace (`@agentick/app`, `@agentick/session`, `@agentick/reconciler-react`, `@agentick/tool-executor`, `@agentick/executor`, `@agentick/loop-executor`, `@agentick/sandbox/v2`), every conformance suite, every example, every test.
**Driver:** v2 grew two parallel concepts — "bridges" (pluggable sync state accessors reached from React) and "harnesses" (substrate-bound operational units with journaled Operations) — and the line between them became friction. Working through the cluster case (admin dashboard mutating a knob on a remote session) showed the bridge concept doesn't survive distributed deployment. Collapsing to one concept resolves the friction and aligns with v2's substrate-uniformity instinct.

## Decision

**Everything that lives in v2's harness world is a harness.** Knobs, gates, state, timeline, snapshot, tools, sandbox, MCP, sessions, apps, reconcilers, executors — all extend `BaseHarness`, all have identity + lifecycle + substrate access + inbox + Operation machinery, all install onto host harnesses via a single uniform Extension protocol.

The thing that varies between harnesses is their protocol — specifically, **which methods are synchronous local accessors and which are async Operations**. A harness can mix both. The choice is per-method, not per-harness.

The "bridge" name retires. The synchronous-accessor methods we used to call bridges are just the sync portion of a harness's protocol.

## Why this shape

### What forces the answer

1. **Cluster deployment.** An admin dashboard on node B wants to flip a knob on a session running on node A. That mutation crosses the network. Crossing the network requires an addressable receiver. The receiver must validate, mutate, emit audit, reply. That's not Map.set — that's an inbox-addressed Operation with full envelope through the substrate. **Knobs need inboxes. Knobs need Operations.** Same for state. Same for gates. Same for any other "bridge" we previously kept light because single-process operations are cheap.

2. **Audit symmetry.** Today's model-side `set_knob` mutations are journaled (the tool dispatch path emits envelopes). Host-side mutations through a bridge would not be — they'd be Map.set with optional bus events. Asymmetric audit trail. Making writes Operations gives uniform audit shape.

3. **Substrate uniformity.** v2's substrate (journal/bus/inbox) is the same machinery everywhere — local in single-process, distributed in cluster. Making knobs a full harness means cluster deployment Just Works with substrate swapped. Keeping knobs as a bridge means cluster deployment requires retrofitting all the missing infrastructure later.

4. **One concept is teachable; two with a fuzzy boundary is not.** Adopters can read "everything is a harness" and have a complete mental model. The bridge/harness binary required learning where the line was and why.

### What it costs

1. **More ceremony per knob mutation in single-process.** Operation envelope allocation + bus publish + journal append (if policy says so) per `set`. Estimated 10x slowdown on absolute terms — microseconds instead of nanoseconds. Nobody notices.

2. **Bigger spec surface.** Every "thing that holds state" now has a HarnessProtocol interface, a conformance suite, a base implementation. More to maintain.

3. **Conceptually heavier "harness."** Things we'd colloquially call "just a state accessor" are now full harnesses with inboxes and operation runners. The name "harness" gets stretched.

The tradeoff is overwhelmingly toward the unified shape. The cluster case alone justifies it; the audit and teachability wins are bonus.

## The core model

### Base contract — every harness has

From `BaseHarness<Surface>` (already exists at `packages/runtime/src/substrate/base-harness.ts`, doesn't need rebuilding):

- **Identity.** `address = ${surface}:${scopeId}`. The inbox routing key.
- **Lifecycle.** `ready: Promise<void>` (resolves after inbox registration); `close(): Promise<void>` (unregisters).
- **Substrate access.** `journal`, `bus`, `inbox` passed at construction. Shared with host by default.
- **Five surfaces:**
  - **① Commands** — `runOperation<I, R, E>(op, body)` with phase contract (`requested → before → middleware → body → terminal`), idempotency replay, OTel spans, lifecycle verdicts (`veto/replace/defer/proceed`).
  - **② Inbox** — `handleMessage(msg)` (concrete subclass implements); `request(channel, payload)` for correlated request/response.
  - **③ Lifecycle handlers** — registered via `this.handlers.register(key, handler)`, fired at phase boundaries.
  - **④ Middleware** — `this.use(mw)` for around-style wrappers; composes outer→inner.
  - **⑤ Events** — `emit / emitLazy / emitDelta / emitDeltaLazy` for non-Operation envelopes.

### Protocol shape — mixed per method

A harness's protocol picks sync or async per method, based on what makes sense:

```ts
export interface KnobsHarnessProtocol {
  readonly id: string;
  readonly status: HarnessStatus;
  readonly ready: Promise<void>;

  // Sync — served from local state; no envelope; no inbox traffic
  get(id: string): KnobPrimitive | undefined;
  has(id: string): boolean;
  list(): readonly KnobDescriptor[];
  subscribe(id: string, listener: () => void): Unsubscribe;
  subscribeAll(listener: () => void): Unsubscribe;

  // Async Operations — journaled, traversable, inbox-addressable
  set(input: { id: string; value: KnobPrimitive }): Promise<void>;
  register(input: { id: string; descriptor: KnobRegistration }): Promise<void>;
  dispatch(input: SetKnobInput): Promise<readonly ContentBlock[]>; // validated set

  close(): Promise<void>;
}
```

Reads are sync because they're high-frequency, latency-sensitive, and served from local replicated state. Writes are async Operations because they need to be authoritative, journaled, and addressable across nodes.

Other harnesses follow the same pattern:

- **TimelineHarness**: sync `read` / `subscribe`; async `append` / `compact`.
- **StateHarness**: sync `get` / `list` / `subscribe` / `subscribeAll`; async `set` / `delete`.
- **GatesHarness**: sync `list` / `get` / `engaged` / `isEngaged`; async `clear` / `defer` / `activate` (each is an Operation that internally calls KnobsHarness.set).
- **SnapshotHarness**: async-only — `export()` / `import()` / `hibernate()`.
- **ToolsHarness**: async-only — `list()` / `register()` / `dispatch()`.
- **SandboxHarness**: async-only, streaming — `exec()` / `readFile()` / `writeFile()` / `editFile()` / `stat()` / `readdir()` / `destroy()`.
- **SessionHarness**: async terminal verbs (`send` / `render` / `queue` / `close`) — each is an Operation that orchestrates calls to its sub-harnesses.
- **AppHarness**: async — `sessions.create` / `runOnce` / `close`.

### Distributed-by-default

Every harness's writes go through `runOperation`. The Operation emits envelopes through the substrate bus, journals per policy, propagates across nodes when the substrate is clustered. The same code is correct in both deployment modes:

- **Single-process**: in-memory bus, in-memory journal, in-memory inbox. Operation envelopes are local function calls and Map allocations. Cheap.
- **Cluster**: clustered bus (Redis pub/sub, NATS, whatever), distributed journal (durable log), routed inbox (cross-node addressing). Operation envelopes traverse the network. Standard.

No conditional `if (cluster) journal-through-network` logic in harness code. The substrate abstracts deployment topology entirely.

### Substrate sharing

Default: every harness uses the host's `journal/bus/inbox`. The host harness's substrate flows down to its sub-harnesses at install time:

```ts
withKnobs() — install: (installer) =>
  new KnobsHarness(
    `${installer.hostId}:knobs`,
    installer.substrate.journal,
    installer.substrate.bus,
    installer.substrate.inbox,
  )
```

Optional: a harness can hold its own substrate when isolation is required (e.g., a redis-backed knobs harness with its own write-ahead log separate from the session's). Implementation detail of that specific harness; doesn't change the shape.

### Audit shape

Writes ARE the audit. Every async Operation emits `requested` and `terminal` envelopes (and optionally `delta` during execution). Adopters subscribing to `bus.events({ surface: "knobs", phase: "terminal" })` see every knob mutation as a span.

Sync reads emit nothing. There's nothing to audit — a read doesn't change state. Subscribers to `knobs.subscribe(id, listener)` are notified locally; the subscription is a render-loop trigger, not an audit event.

The "knob-changed event" idea from earlier discussion drops out. We don't need a separate change-event surface; the Operation envelope IS the change event, in span form.

## Extension protocol

Uniform across all harnesses. The Extension type is a discriminated union by `target`:

```ts
export type HarnessKind = "app" | "session" | "reconciler" | (string & {});

interface ExtensionBase {
  readonly name: string;
  readonly target: HarnessKind;
}

export interface AppExtension extends ExtensionBase {
  readonly target: "app";
  install(installer: AppInstaller): void | Promise<void>;
}

export interface SessionExtension extends ExtensionBase {
  readonly target: "session";
  install(installer: SessionInstaller): void | Promise<void>;
}

export type Extension = AppExtension | SessionExtension;
// Open via (string & {}) — new harness packages declare new variants
// without changing the base.
```

Multi-target extensions return a tuple of single-target extensions sharing state via factory closure:

```ts
export function withSandbox(opts?: SandboxOptions): readonly Extension[] {
  const shared = makeSharedConfig(opts); // closure-captured state
  return [
    {
      name: "sandbox",
      target: "app",
      install: (i) => {
        /* register app-level */
      },
    },
    {
      name: "sandbox",
      target: "session",
      install: (i) => {
        /* register session-level using shared */
      },
    },
  ];
}

// adopter: extensions: [...withSandbox(), withKnobs(), withMCP()]
```

Spread is invisible at the call site.

### Installer contracts

Per-harness. Each harness package documents its installer interface as its extensibility surface.

```ts
export interface BaseInstaller {
  readonly hostId: string;
  readonly substrate: AppSubstrate;
  registerNamespace<T>(name: string, harness: T): void;
  getNamespace<T>(name: string): T | undefined; // lazy peer lookup
  onClose(handler: () => void | Promise<void>): void;
}

export interface AppInstaller extends BaseInstaller {
  readonly kind: "app";
}
export interface SessionInstaller extends BaseInstaller {
  readonly kind: "session";
  readonly app: AppHarnessRef;
}
```

Minimal surface. Add lifecycle hooks only when actually needed (current first-order extensions don't need anything beyond `onClose`).

### Required vs optional surfaces

The framework's API contract per harness declares which sub-harnesses are guaranteed at the type level:

```ts
export interface SessionHarnessProtocol {
  readonly id: string;
  readonly status: SessionStatus;
  readonly ready: Promise<void>;

  // The framework's required surface — guaranteed present
  readonly timeline: TimelineHarness;
  readonly tools: ToolsHarness;
  readonly knobs: KnobsHarness;
  readonly gates: GatesHarness;
  readonly state: StateHarness;
  readonly snapshot: SnapshotHarness;

  // Adopter additions — augmentable via module declaration
  readonly extensions: Readonly<SessionExtensions>;

  // Terminal verbs (Operations at the session level)
  send(input: SendInput): Promise<SendResult>;
  render(input: RenderInput): Promise<RenderResult>;
  queue(messages: readonly SessionMessage[]): void;
  close(): Promise<void>;
}

export interface SessionExtensions {} // adopters augment via declare module
```

Required surfaces are auto-installed by the framework via default factories (`withTimelineDefault()`, `withKnobsDefault()`, etc.) and pulled up to top-level harness fields at construction.

Adopters can replace required implementations by passing a configured factory (`extensions: [withKnobs({ store: redisStore })]`) — last-writer-wins on slot name. Adopters cannot REMOVE required surfaces; the slot will be filled by the default if nothing else claims it.

The framework's required-set per harness is part of the harness protocol; changes only with major versions.

## Inbox addressing

Every harness registers at `${surface}:${scopeId}`. Composite harnesses (Session, App) use a path-extending convention for their sub-harnesses:

```
inbox://app:my-app
inbox://session:s_xyz
inbox://knobs:s_xyz:knobs         # sub-harness of session s_xyz
inbox://state:s_xyz:state
inbox://timeline:s_xyz:timeline
inbox://sandbox:s_xyz:sb_primary  # session's primary sandbox
inbox://reconciler:r_main
inbox://reconciler:r_main:mount:m_42
```

Cross-process actors (admin dashboards, slash commands, webhooks) address messages by this URL. The cluster substrate routes to the owning node. In single-process, the inbox is a Map.

The `scopeId` portion encodes ownership: `knobs:s_xyz:knobs` is owned by session `s_xyz`. Closing the session closes its sub-harnesses, unregistering their addresses.

## Per-harness inventory

What becomes a harness (concrete list):

### Required on SessionHarness (auto-installed)

| Harness           | Sync methods                                   | Async Operations               |
| ----------------- | ---------------------------------------------- | ------------------------------ |
| `KnobsHarness`    | get, has, list, subscribe, subscribeAll        | set, register, dispatch        |
| `StateHarness`    | get, has, list, subscribe, subscribeAll        | set, delete                    |
| `GatesHarness`    | list, get, engaged, isEngaged (composes Knobs) | clear, defer, activate         |
| `TimelineHarness` | read, subscribe                                | append, compact, importEntries |
| `SnapshotHarness` | (none — async-only)                            | export, import, hibernate      |
| `ToolsHarness`    | list, get                                      | register, unregister, dispatch |

### Required on AppHarness

| Harness           | Methods                                        |
| ----------------- | ---------------------------------------------- |
| `SessionsHarness` | sync: get, list; async: create, runOnce, close |

(AppHarness mostly composes; few required sub-harnesses.)

### Optional (adopter-installed via Extension)

`SandboxHarness`, `MCPConnectionHarness`, `SubscriptionsHarness`, third-party.

### Existing v2 harnesses (already align)

`ReconcilerHarness`, `ToolExecutorHarness`, `ExecutorHarness`, `LoopExecutorHarness`, `SessionHarness`, `AppHarness` — already extend `BaseHarness`. The bridges they reference become first-class sub-harnesses.

## Considered and rejected

The architectural cul-de-sacs we walked through to land here:

### Bridges and harnesses as two protocol kinds

Earlier draft kept "bridge" as a distinct protocol shape (sync, no envelopes) vs "harness" (async, journaled). Made the line per-harness.

**Rejected because** the cluster case forces every state-mutating surface to be inbox-addressable and audit-emitting. That's harness machinery. Keeping bridges as a distinct kind would require retrofitting cluster support; making them harnesses from the start handles cluster transparently.

### Capability interfaces (Stateful / Operational / Streaming / Hosting)

Considered formalizing the "what shape is this harness" question via mix-in capability interfaces.

**Rejected as overengineering.** The character isn't per-harness — it's per-method. A KnobsHarness has sync reads AND async writes. The protocol declares that per method; we don't need a type-level taxonomy on top. Capabilities would add ceremony without clarifying anything the protocol doesn't already express.

### Named-method base on Extension

Earlier draft had `Extension { app?, session?, reconciler? }` with optional per-harness install hooks.

**Rejected because** the base interface would grow every time a new harness type appears. Discriminated union by `target` decouples — adding a new variant doesn't touch existing variants.

### Flat-top-level for "internal" extensions

Considered carving out a privileged class where `@agentick/sandbox` shows up as `app.sandbox` (top-level) while third-party extensions go under `app.extensions.foo`.

**Rejected.** "Internal" vs "third-party" is fuzzy and shifts over time. Naming conflicts proliferate. The cleaner line is _required vs optional_: required is top-level (guaranteed by framework API contract), optional is under `.extensions`. Same machinery for both; difference is who guarantees presence.

### `dependsOn` field on Extensions

Considered explicit dependency declaration for cross-extension prerequisites.

**Rejected as YAGNI.** Only current case is gates → knobs, handled by framework default install order. If real third-party-on-third-party dependencies emerge, add it then.

### Per-method `decorate` style augmentation

Considered Fastify-style `installer.decorate("myMethod", value)` for ad-hoc method attachment.

**Rejected.** Silent clobbers; type drift; debugging pain. Extensions install harnesses; harnesses have protocols; that's the contract.

### Chained handles (`session.knobs.get(name).subscribe()`)

Considered `get(name)` returning a handle object with methods.

**Rejected.** Object-per-call allocation + nullable branch for marginal DX gain. Flat methods match the harness protocol 1:1.

## Migration plan

Stepped, bottom-up. Each step is one commit; no flat-method shims (per CLAUDE.md "no backwards compatibility").

```
Step 0  — This ADR. (Now landing.)

Step 1  — Spec: Extension protocol + per-harness Installer interfaces.
          New types in @agentick/spec/protocol/extension.ts:
            HarnessKind, ExtensionBase, AppExtension, SessionExtension,
            Extension, BaseInstaller, AppInstaller, SessionInstaller,
            AppExtensions, SessionExtensions, SessionHarnessProtocol
            (with required-harness fields).

Step 2  — Extract KnobsHarness. New private workspace
          packages/knobs/. Implements KnobsHarnessProtocol via
          BaseHarness extension. withKnobs() factory. KnobsHarness
          conformance suite. Existing useKnob hook reaches via
          useBridges().knobs (still typed; just a different concrete
          class behind the slot).

Step 3  — Extract StateHarness. Pattern repeat. Migrate useSessionState.

Step 4  — Extract GatesHarness. Composes KnobsHarness; same pattern.

Step 5  — Extract TimelineHarness. Sync read, async append (existing
          flow stays; just the type identity changes). Migrate
          useTimeline.

Step 6  — Extract SnapshotHarness. Reaches peer harnesses via
          installer.getNamespace.

Step 7  — Extract ToolsHarness. Composes ToolExecutorHarness.

Step 8  — SessionHarness refactor. Auto-install required harnesses
          via framework defaults. Pull required surfaces to top-level
          fields. Adopter extensions under .extensions. Terminal
          verbs (send, render, queue) orchestrate sub-harnesses.

Step 9  — AppHarness refactor. SessionsHarness sub-harness.
          app.extensions for adopter additions.

Step 10 — Sandbox refactor to align with the slot pattern.

Step 11 — MCP harness extraction (was already harness-shaped per
          ADR 23; align to new Extension protocol).

Step 12 — Sweep. STATUS.md update. IMPLEMENTATION-PLAN.md update.
          README updates per package. Drop "bridge" terminology from
          docs.
```

Estimated 12 commits, ~2000-3000 LOC of churn, mostly mechanical once Step 1 lands. The big risk is Step 8 (SessionHarness refactor) — that's the integration point.

## Test graph (proving the plumbing)

Before Step 8, build a small integration test that proves the substrate plumbing works as designed:

1. **Construct three harnesses** sharing a local substrate (journal/bus/inbox):
   - A `KnobsHarness` at address `knobs:test-session:knobs`
   - A `SessionHarness` at address `session:test-session`
   - A simulated "external actor" (just an inbox client) on a fourth address

2. **Cross-harness addressed messaging**: external actor sends `{ type: "set", payload: { id: "verbose", value: true } }` to `knobs:test-session:knobs`. Assert:
   - The KnobsHarness receives the message.
   - The `set` Operation runs; envelopes (`requested → terminal`) appear in the journal.
   - `knobs.get("verbose")` reflects the new value.
   - The Operation's terminal envelope is published on the bus.

3. **Operation hooks**: install a middleware on KnobsHarness via `knobs.use(mw)`. Send the same message. Assert the middleware fires before the body executes.

4. **Lifecycle handler**: register a `before` handler on KnobsHarness. Send the message. Assert the handler runs, can veto, and the veto produces a `terminal:vetoed` envelope.

5. **Session terminal verb composition**: call `session.send({ messages: [...] })`. Assert the resulting envelope tree shows session's Operation as the parent, with timeline.append and any other sub-Operations as children (via `parentOpId` linkage from BaseHarness's automatic FiberRef threading).

6. **Sender address in envelopes**: every envelope already carries `surface`, `name`, `scope.sessionId`, `opId`, `parentOpId`. Confirm this is enough to reconstruct "who sent what." If we need explicit `from` / `replyTo` addressing for some scenarios, add it to the envelope schema in spec.

7. **Substrate swap for "distributed" simulation**: replace LocalEventBus + LocalInbox with a routing bus + routing inbox that simulates two-node deployment. Run the same test; assert behavior identical. Proves cluster-readiness without standing up actual nodes.

This is a focused integration test that validates the assumptions the rewrite makes. Cost: ~300-500 LOC of test code. Can land between Step 1 (spec types) and Step 2 (first harness extraction) to fail-fast if assumptions are wrong.

## Open questions

1. **Does `useBridges()` rename?** Today's `HookBridges` becomes "a bag of harness instances" — the name doesn't fit. Probably `SessionHarnesses` or `MountHarnesses` or just `Bridges` kept as historical alias. Decide before Step 2.

2. **`session.dispatch` → `session.tools.dispatch`** is a breaking rename. Confirmed acceptable per CLAUDE.md special window.

3. **Where does `session.events` live?** Subscribing to bus events filtered to a session. Could be a sub-harness or just a typed accessor over the substrate bus. Leans accessor (no real state to manage); not a sub-harness.

4. **Streaming-by-default for some operations.** `sandbox.exec` streams stdout deltas; `executor.execute` streams tokens. The protocol declares `Operation<I, R, E>` for the terminal; streaming is via `emitDelta` from the body. Worth documenting per-harness which methods stream and what delta payload they emit.

5. **Self-substrate harnesses.** When does a harness want its own journal/bus/inbox vs sharing host's? Cluster-isolated knobs is one case (separate audit log). Bench-only sandboxes another. Doc as opt-in pattern; not part of base contract.

6. **Sender address on envelopes.** Today `ProtocolEvent` doesn't carry an explicit `from` field — sender identity is encoded in `surface` + `scope`. Sufficient for current cases. If cross-actor messaging needs explicit sender tracking (auditing "who told this session to change knobs"), add `metadata.from` convention or first-class field. Defer to test-graph findings.

## Notes

This rewrite supersedes the namespacing-first framing of the previous ADR 26 draft. The core insight: trying to keep bridges as a separate lightweight concept stops working when you take cluster deployment seriously. Once writes need to be addressable, journaled, and traversable across nodes, "bridge" becomes "harness with sync reads." Collapse the distinction and the framework gets simpler.

The substrate machinery (`BaseHarness`, journal, bus, inbox) already supports this. We're not building new infrastructure — we're applying existing infrastructure uniformly to surfaces we'd previously treated as exceptions.

The next ADR (ADR 27) will tackle whether `session.timeline.append` becomes the entry point for inbound messages (replacing `session.send` as the primitive). That builds naturally on ADR 26's "everything is a harness, addressable, with mixed sync+async methods" foundation.
