# 20 — Pluggability Charter

**Status:** Locked 2026-05-15 · the protocol-first principle in engineering terms

This is the load-bearing principle behind every v2 decision. Read this
before designing a new interface, choosing between an abstract class
and a concrete one, or arguing about where a feature should live.

> If `01-harness-principle.md` is _how_ harnesses are shaped, and
> `19-foundation.md` is _what_ sits underneath them, then this doc is
> _why_ we draw the lines where we do.

## The thesis

**The product is the contract surface, not the bytes that satisfy it.**

The artifacts with long-term value:

```
1. @agentick/spec-next               wire shapes + protocol interfaces
2. The harness model            5 surfaces × N harnesses
3. @agentick/spec-conformance-next   executable definition of "conforming"
```

The artifacts with tactical value (replaceable any time without breaking
adopters):

```
- @agentick/runtime-next             MemoryJournal, LocalEventBus, LocalInbox, BaseHarness
- @agentick/reconciler-react-next    the React-based reconciler harness
- Every executor adapter        OpenAI, Anthropic, Google, AI SDK, …
- Every formatter               Markdown, XML, Text, JSON, …
- Every persistence impl        Postgres, SQLite, Redis, …
- Every transport impl          local, cluster, gateway, …
```

Defaults exist to (a) prove the protocol is implementable, (b) give
adopters something that works on day one. They are reference
implementations, not the product.

## Why this matters more than the implementations

When a framework's value is in its concrete code, replacing a part means
forking. When the value is in its contracts, replacing a part means
implementing an interface. The first model produces lock-in; the second
produces an ecosystem.

**`[V1-REPLACED]`** of the v1 approach where infrastructure choices
(EventEmitter, in-memory session store, sync renderers) were baked into
classes. v2 makes the same choices in the default impl but exposes them
behind interfaces that _any_ backing technology can satisfy.

## The strongest counterargument (and our mitigation)

Taken to its limit, "shapes matter more than implementations" produces
frameworks that look elegant on paper, ship nothing, and die because the
first author couldn't dogfood them. Two practices keep us out of that
ditch:

1. **Ship a reference impl with every spec surface, concurrent with the
   spec.** No protocol enters the blueprint without at least one
   conforming impl planned in the same phase. `@agentick/spec-next` and
   `@agentick/runtime-next` landed in the same workspace; future protocols
   follow the same rule.
2. **Treat the conformance suite as the load-bearing artifact.** Prose
   in `docs/proposals/v2/blueprint/` is documentation. The vitest
   suite in `@agentick/spec-conformance-next` is the _contract_. What passes
   is conformant; what fails is not.

## The ten engineering rules

### 1. Every cross-cutting concern is an interface

Durability, observability, addressability, transport, persistence,
distribution, sandbox execution, formatting, tool dispatch — each is a
protocol with one or more reference impls.

| Concern             | Protocol                | Reference impl                    | Other plausible impls                                     |
| ------------------- | ----------------------- | --------------------------------- | --------------------------------------------------------- |
| Durable record      | `OperationJournal`      | `MemoryJournal`                   | `PostgresJournal`, `RedisStreamsJournal`, `SqliteJournal` |
| Live observation    | `EventBus`              | `LocalEventBus`                   | `ClusterEventBus`, NATS-backed                            |
| Addressable inbound | `MessageInbox`          | `LocalInbox`                      | `ClusterInbox` (Effect.cluster, etc.)                     |
| JSX evaluation      | `ReconcilerProtocol`    | `@agentick/reconciler-react-next` | Vue/Solid hosts (theoretical)                             |
| Content formatting  | `FormatterProtocol`     | Markdown / XML / Text             | Custom application formatters                             |
| Provider execution  | `LanguageModelExecutor` | `@agentick/openai`, etc.          | Any HTTP-shaped LLM API                                   |
| Tool dispatch       | `ToolExecutorProtocol`  | (Phase 4a)                        | MCP-backed, RPC-backed                                    |
| Sandbox execution   | `SandboxProvider`       | `sandbox-local`, `sandbox-docker` | Firecracker, Cloudflare Workers                           |

If a concern feels load-bearing, it gets a protocol.

### 2. The spec firewall is enforced structurally, not by review

Anything that crosses a harness boundary is JSON-shaped. No function
references, no live SDK clients, no React fibers, no `Effect` refs.

This is what makes remote, cluster, and gateway implementations
substitutable for local ones with zero call-site changes. It's why
`SemanticNode.formatter: Formatter` became `rendererRef?: FormatterRef`
(see `02-data-model.md`). It's why `ToolDeclaration.handlerRef: string`
is a name resolved by the runtime, not an executable function.

When a protocol fails the firewall test, the protocol is wrong — not
the firewall.

### 3. Default impls pay the abstraction tax willingly

`MemoryJournal.append` returns `Promise<void>` even though it could be
synchronous. `tail()` is an `AsyncIterable` even though a callback
would be simpler. `LocalInbox.send` rejects with tagged-union
`InboxError` even though it could throw plain `Error`.

Cost: microscopic ergonomic hit in the default.
Benefit: every other impl fits the same shape without translation glue.

This trade is non-negotiable. Defaults conform; they don't dictate.

### 4. Conformance suites are the executable form of the spec

The blueprint is documentation. `@agentick/spec-conformance-next` is the
contract. Every protocol gets a suite _before_ a second impl is allowed
to claim conformance.

Status:

| Protocol             | Suite                      | Status      |
| -------------------- | -------------------------- | ----------- |
| `OperationJournal`   | `runJournalConformance`    | Phase 2 ✓   |
| `MessageInbox`       | `runInboxConformance`      | Phase 2 ✓   |
| `EventBus`           | `runEventBusConformance`   | Phase 2.5 ✗ |
| `BaseHarness`        | `runHarnessConformance`    | Phase 3 ✗   |
| `ReconcilerProtocol` | `runReconcilerConformance` | Phase 3 ✗   |
| `FormatterProtocol`  | `runFormatterConformance`  | Phase 4a ✗  |
| Each executor family | `runExecutorConformance`   | Phase 4c ✗  |

A second impl that hasn't been driven through the suite is not
conformant — it's a hypothesis.

### 5. Pluggability has tiers and we name them

Not everything is or should be user-pluggable. State the tier
explicitly in each protocol README.

| Tier                      | Who plugs it                | Example                                                                                       |
| ------------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| **T1 User-pluggable**     | App developers in user code | `OperationJournal`, `MessageInbox`, `EventBus`, `Formatter`, `SandboxProvider`                |
| **T2 Vendor-pluggable**   | Adapter authors             | Executor adapters, MCP servers, persistence backends                                          |
| **T3 Framework-internal** | Forking required            | The reconciler is React. Pluggability is at `ReconcilerProtocol`, not at "swap React for Vue" |

Pretending T3 things are T1 produces hollow abstractions. Pretending T1
things are T3 produces lock-in. Stating the tier prevents both.

### 6. Protocols are minimal by construction

Five surfaces is already a lot. Resist the urge to make every internal
a surface. New optional capabilities go behind opt-in capability
interfaces, not protocol-mandatory methods.

```ts
// Required protocol — every impl must satisfy this.
interface OperationJournal {
  append(...): Promise<void>;
  appendBatch(...): Promise<void>;
  read(...): AsyncIterable<ProtocolEvent>;
  tail(...): AsyncIterable<ProtocolEvent>;
  lookupTerminal(...): Promise<Maybe<TerminalEvent>>;
  findOrphaned(...): Promise<readonly OrphanedOperation[]>;
}

// Optional capability — impls MAY implement and consumers feature-detect.
interface JournalDiagnostics {
  totalAppended(): number;
  retentionBytes(): number;
}
```

If the default needs something the protocol shouldn't mandate, that
something is a capability or a class method on the default — not a new
protocol method.

### 7. Wire compatibility is the test of protocol integrity

A clean smell test for protocol leakage: "can this serialize over a
socket?"

- `journal.append(envelope)` works identically against in-memory ring
  and Postgres `INSERT`? Protocol is sound.
- `inbox.send(addr, msg)` works identically against `LocalInbox` and a
  cluster's RPC fabric? Protocol is sound.
- `reconciler.renderTree(input)` returns a JSON-shaped `RenderedTree`
  regardless of who's running React? Protocol is sound.

If the answer is "well, in cluster mode we'd need to also pass…",
you've found leakage. Fix the protocol, not the implementation.

### 8. Reference impls are intentionally library-first

The defaults are in-process, dependency-light, zero-config. No
Postgres, no Redis, no Kafka. This isn't laziness — it's the adoption
gradient that every successful framework has used (Express, Fastify,
NestJS, Prisma's SQLite default).

```
day 1: npm install agentick → works
day 30: swap MemoryJournal for PostgresJournal → still works
day 90: swap LocalInbox for ClusterInbox → still works
```

If the adoption gradient breaks, the protocol is wrong.

### 9. Naming reflects the boundary, not the technology

Package and protocol names describe what they _are_, not what they're
_made of_:

```
@agentick/runtime-next         (not @agentick/memory-substrate)
@agentick/reconciler-react-next (React is the impl detail; reconciler is the role)
@agentick/persistence-postgres  (when it lands)
@agentick/transport-grpc        (when it lands)
```

The technology suffix is allowed because there will be siblings
(`persistence-sqlite`, `transport-ws`). The role prefix is canonical.

### 10. When work conflicts, the protocol wins

```
"Did we expose this as a protocol?"  beats  "Did we ship the fastest impl?"
"Can a third party implement this    beats  "Did we cover every edge case
 in 200 lines?"                              in the default?"
"Is this part of the wire spec        beats  "Where does the file live?"
 or behind it?"
```

When the default needs something the spec doesn't allow, the default
gives way. When the protocol needs something for a real impl that the
default doesn't need, the protocol takes it.

## What this charter rules out

- **No "magic registries" hidden in default impls.** If discovery exists,
  it's a protocol method.
- **No "the framework calls back into your code via a magic prop."** All
  user code reaches the framework through a documented protocol surface.
- **No "in-memory only" fast paths that don't survive serialization.**
  Either the protocol allows the fast path explicitly, or the fast path
  doesn't exist.
- **No "this only works with our adapter."** Adapters implement protocols;
  the framework treats all conforming adapters identically.
- **No method whose contract reads "implementations should…".** Either
  the protocol enforces it (typed, conformance-tested) or it isn't a
  rule.

## What this charter does NOT mean

- **Not "delay implementations indefinitely."** The opposite: ship one
  reference impl as fast as possible to discover protocol flaws.
- **Not "every method becomes an extension point."** Resist surface
  growth. Five harness surfaces is the budget, not the floor.
- **Not "abstract everything."** Tier-3 things are intentionally
  concrete. The JSX reconciler is React. Replacing React is a fork.
- **Not "future-proof every decision."** Solve today's problem with a
  shape that admits tomorrow's impl. Don't try to admit all tomorrows.

## How to use this charter

When designing a new feature or interface, in order:

1. **Find the protocol.** Which `@agentick/spec-next` interface does this
   belong to? If none exists, decide whether you're adding a protocol
   or a capability on an existing protocol.
2. **Find the tier.** T1/T2/T3. State it explicitly.
3. **Design the shape.** JSON-shaped wire types only; no function
   references across boundaries; minimal surface; readonly everywhere.
4. **Write the conformance entry.** What invariants does a conforming
   impl satisfy? If you can't write the test, you can't ship the
   protocol.
5. **Implement the default.** It pays the abstraction tax. It is
   library-first. It does not dictate.
6. **Document.** README states purpose, tier, conformance entry, and
   the reference impl(s).

## Cross-references

- `00-overview.md` — the four pillars, of which this is pillar 2 made
  explicit
- `01-harness-principle.md` — the harness shape every protocol surface
  rides on
- `13-package-graph.md` — the package home for each protocol/impl
- `19-foundation.md` — the substrate that this principle applies to
  first
- `17-open-questions.md` — open questions about specific protocols
- `@agentick/spec-conformance-next` — the executable form of the principle
