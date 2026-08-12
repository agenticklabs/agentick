# ADR 98 — Scoped Capability Leasing

**Status:** accepted (pattern named; shared abstraction deferred to the third consumer)

## Context

Two v2 seams — the code runtime over a session sandbox (ADR on code/sandbox
composition) and the data-layer `View` over a `Store` (`store.md`) — arrived at
the _same_ three-part shape independently. Each lets a harness declare a
capability it does not construct, bind it to the live session late, and hold it
as a narrowed handle it may use but not own.

Left unnamed, the third instance would reinvent the shape a fourth way, and the
temptation to extract a premature `Lease<T>` abstraction over two data points
would harden the wrong contract. This ADR fixes the vocabulary and the
three-element contract so the third consumer is built to the same shape — and
the extraction, when it is earned, is mechanical rather than a redesign.

This is a naming decision, not a new mechanism. Nothing here ships a type.

## The pattern

A **scoped capability lease** is a capability that a harness needs but does not
own, delivered in three moves:

### 1. Scoped provider — declared session-blind, resolved at install

The capability enters as a declarative descriptor exposing a single resolution
verb, feature-detected structurally. Construction takes no session; resolution
binds to the live `SessionInstaller`.

```ts
// packages/code/src/contract.ts
export interface RuntimeProvider {
  // No installer, no sandbox, no spawn — a placed engine reports the SAME caps
  // jailed or not. Called once at install, before resolve.
  capabilities(): CodeCapabilities | Promise<CodeCapabilities>;
  resolve(installer: SessionInstaller): Runtime | Promise<Runtime>;
}

export function isRuntimeProvider(value: unknown): value is RuntimeProvider {
  return typeof (value as { resolve?: unknown })?.resolve === "function";
}
```

The split between `capabilities()` (session-free) and `resolve(installer)`
(session-bound) is load-bearing: capabilities must be answerable at install
without a session, so the declarative form stays inspectable and serializable;
the live binding stays late.

### 2. Total scoped selection — `activeX(namespace, id?)`

Which instance of the capability to lease is a _total_ function from an optional
id to a handle, so no caller reimplements the selection rule: explicit id →
exact; else primary → sole → ambiguous-fails.

```ts
// packages/sandbox/src/bridge.ts
export function activeSandbox(
  bridge: SandboxBridge | undefined,
  id?: string,
): SandboxHarness | undefined {
  if (!bridge) return undefined;
  if (id !== undefined) return bridge.get(id);
  const primary = bridge.get("primary");
  if (primary) return primary;
  const only = bridge.list();
  return only.length === 1 && only[0] ? bridge.get(only[0].id) : undefined;
}
```

The selection is one rule in one place. A second consumer that hand-rolled
"primary, or the only one, else fail" would drift on the tie-break.

### 3. Attenuated lease — borrow, not own, guaranteed by the type

The resolved surface is a **narrowed** type that structurally omits the
ownership verbs. Borrow-not-own is a compile-time fact, not a runtime
convention or a comment.

```ts
// packages/sandbox/src/contract.ts — the borrow-only face of a sandbox.
export interface SandboxPlacement {
  readonly workspacePath: string;
  spawn(/* … */): /* live process */;
  // NOTE: no `destroy`. SandboxHandle has one; Placement deliberately does not.
}
```

`sandboxHost()` adopts the session's sandbox by selecting the `SandboxHarness`
with `activeSandbox`, then handing the runtime a `SandboxPlacement` — the
narrowed face. The sandbox is owned by `withSandbox`/the session; the runtime
that borrows it _cannot_ call `destroy`, because the verb is not on the type it
holds.

## The two instances

|                       | Provider (`resolve`)                                   | Selection (`activeX`)       | Attenuated lease                                                        |
| --------------------- | ------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------- |
| **Code over sandbox** | `RuntimeProvider.resolve(installer)`                   | `activeSandbox(ns, id?)`    | `SandboxPlacement` (no `destroy`)                                       |
| **Data-layer View**   | harness builds a `View(cfg)` over a `Store` at install | the harness names its store | `View` (sync cache; not the `Store` — no ownership of the async source) |

The `View` case is the same shape wearing different clothes: the `Store` is the
async owner; the harness leases a `View` — a synchronous, projected read surface
it materializes and may read, but which is not the store and cannot stand in for
it. A harness holds a `View` **iff** it needs a synchronous read of state the
store owns.

## Decision

1. **Name the pattern "scoped capability leasing"** and require its three
   elements — scoped provider, total scoped selection, attenuated lease — of any
   new seam where a harness declares a capability it binds late and borrows.

2. **Do not extract a shared `Lease<T>` / `Provider<T>` abstraction yet.** Two
   instances is a pattern, not an abstraction (ADR 27's modularity discipline,
   and "compose primitives, not subsystems" — the three-consumers rule). The
   shared type waits for the third consumer, which will prove which parts are
   truly common (the `resolve(installer)` verb and the `activeX` tie-break look
   universal; the attenuation is per-capability by construction and may not
   factor at all).

3. **Attenuate by type, never by discipline.** The lease's narrowness is a
   distinct interface that omits ownership verbs — not the owning handle passed
   with a "don't call destroy" comment. If a borrow can call `destroy`, it is not
   a lease.

## Consequences

- The third instance is a fill-in-the-blanks exercise against a named contract,
  and the extraction it triggers is mechanical.
- `capabilities()` staying session-free is a standing constraint on providers:
  a capability that _cannot_ be answered without a session is a signal the split
  is wrong, not a reason to thread a session into `capabilities()`.
- Selection tie-breaks (primary → sole → ambiguous-fails) are uniform across
  capabilities, so an author who learns one learns them all.

## Non-goals

- No runtime `Lease` base class, registry, or lifecycle manager. Leasing is a
  shape, not a subsystem.
- No generalization of the two-door provider/selection mechanism beyond the two
  instances. The model/compaction seams made the same call in ADR 97 — two
  consumers of the tree-declaration + config two-door, extract at three.
