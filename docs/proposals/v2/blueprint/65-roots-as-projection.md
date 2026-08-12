# ADR 65 — Roots are a projection over sources, NOT a harness

**Status:** ACCEPTED 2026-07-07 (Fable, for Ryan). **Superseded in part
2026-08-11:** the MCP **roots** projection (`sandboxRootsSource` /
`bindSandboxRootsToClient`) is REMOVED — MCP dropped roots support in the
stateless rewrite and it had no consumers; removing it also cleared a
`sandbox → mcp` dependency cycle. The **file-resource** projection
(`sandboxFileResolver` / `fsFileResolver` / `registerFileResolver`) is
RETAINED and moved to the mcp-free `@agentick/sandbox/files` subpath. The
decision below stands for the file-resolution half; the roots half is
historical. **Builds on:** ADR 62
(resources = read-projection seam), ADR 63 (projection ≠ registration ≠ a new
layer), the sandbox mount model (`add-mount`/`remove-mount` declared commands),
the existing `McpRootsSource` client config seam. **Decides:** how MCP roots +
the native "filesystem boundary / mount" concept are modeled in v2.

## The question

MCP **roots** are `file://` filesystem boundaries a _client_ exposes to a
_server_ (client → server; the server pulls via `roots/list`, the client pushes
`notifications/roots/list_changed`). They are advisory scoping — "operate within
these directories" — not enforced containment and not content transfer (that is
**resources**, the server → client direction, ADR 62).

Roots feel important enough to warrant a first-class harness with the built-in
harness capabilities (journal, bus, wire projection, snapshot, principal/origin).
Should roots/mounts be their own `RootsHarness`, or a projection composed over
existing primitives?

## Decision

**Compose. There is no `RootsHarness`.** Roots is a _projection_ between three
things that already exist:

1. **Mount STATE already lives in a harness — the sandbox.** `add-mount` /
   `remove-mount` are _declared commands_, so the sandbox mount table already
   journals, emits bus events, projects to the wire, carries principal/origin,
   snapshots, and enforces an ACL ceiling (`mountAllow`). Those are exactly the
   "built-in harness capabilities" a `RootsHarness` would be reached for — they
   are already present, in the layer that owns real filesystem boundaries.
2. **The read side already lives in a harness — `ResourcesHarness`** (ADR 62):
   `register(uri, resolver)` / `registerTemplate` + `list_changed`.
3. **Roots is the bridge**, and per ADR 63 a projection is not a new layer:
   - _outbound_ (we are a client): a source → the `McpRootsSource` provider fed
     to a remote server;
   - _inbound_ (we are a server): a connecting client's `roots/list` → a
     per-connection read on the request ctx.

A `RootsHarness` would be a **second owner** of state the sandbox already owns
authoritatively — a single-source-of-truth violation — in exchange for the one
thing composition does not give: a _unified, cross-source, inspectable mount
registry_. No v2.0 consumer needs that unified view; each real consumer (the
outbound provider, the file-resolver, the inbound ingest) reads exactly one
source. So the aggregation harness is speculative — YAGNI.

## Roots does not require a sandbox

Correcting an easy over-coupling: the **source is pluggable**, and the sandbox
is one option, not a prerequisite.

- **Outbound** takes any `McpRootsSource` — a **static list**
  (`[{ uri: "file:///data", name: "data" }]`, no sandbox at all), an **adopter
  provider fn**, the **sandbox adapter**, or a **plain-fs adapter**.
- **Inbound** has zero sandbox involvement — the roots belong to the connecting
  client; we only read them.

The sandbox is the **flagship** source for one reason: when a deployment _is_
sandboxed, the boundaries you _declare_ to a peer should equal the boundaries
you _enforce_, and mount changes should keep the peer in sync automatically
(sandbox mount bus events → `notifyRootsChanged()`). That "declared == enforced,
and self-syncing" property is why the sandbox adapter is the headline — but a
static list keeps roots fully usable standalone.

## Why this is safe under uncertainty (the load-bearing rationale — read this

## before ever proposing a RootsHarness)

The future importance of roots is genuinely unknown. Filesystem-oriented peers
(a coding agent + a filesystem server; a local dev tool) exercise roots
heavily; **data / API-oriented** MCP servers barely touch them (a `file://`
boundary is inert to a server that operates on a remote dataset — for those, the
relevant capability is **resources**, server → client, already shipped). We do
not need to predict which future arrives, because **this decision is reversible
and the regret is asymmetric:**

- The `McpRootsSource` **provider-fn seam is the escape hatch.** If a first-class
  registry is later warranted, the upgrade is _additive_: the provider fn starts
  reading _from_ a `RootsHarness` instead of a list/sandbox; inbound roots write
  _into_ it instead of onto the ctx; the wire enumerate/subscribe surface is
  added. Every artifact built now — the `McpRoot` type, the sandbox source, the
  file-resolver, the inbound ingest — survives unchanged; it is re-pointed at a
  store, not rewritten.
- **Regret asymmetry:** building the harness now and being wrong = a permanent
  subsystem (package, wire surface, enumerate/subscribe, snapshot, conformance,
  docs, maintenance) plus a second mount-state owner competing with the sandbox,
  which cannot be cheaply deleted. Composing now and being wrong = a bounded,
  additive refactor the provider-fn seam was built to absorb. Under genuine
  uncertainty you take the low-regret, reversible path.

## The trigger to revisit (be concrete; do not revisit on vibes)

Promote roots/mounts to a harness **only** when there is a real consumer for a
_unified, cross-source, live mount registry_ — one surface enumerating every
boundary across every source (sandbox + native dirs + inbound peer roots),
subscribable, shown in devtools / a UI. That is a legitimate product surface; it
is simply not something anything in v2.0 asks for. Absent that specific need,
composition is correct and roots stays plumbing.

The upgrade path is marked at the seam in code
(`TODO(#237-4b / ADR-65): roots-registry upgrade path`). If you are reading this
because you think roots deserves a harness: first write the concrete consumer
that needs the unified inspectable view — if you cannot, the seam already covers
your case.

## Consequences

- v2.0 ships roots as composition, **both directions**: a source-agnostic
  outbound provider (static list | fn | sandbox | fs), a file-resolver bridging
  mounts → resources, and inbound per-connection client roots on the server ctx.
- The sandbox↔external-surface adapters (`sandboxRootsSource`,
  `sandboxFileResolver`) live in an **opt-in subpath on the sandbox package**
  (deps on mcp + resources), mirroring the `/react` subpath convention — the MCP
  client core stays decoupled from the sandbox; no cycle.
- No new harness, no new mount-state owner. The sandbox remains the single
  authority for its own boundaries; resources remains the read seam; MCP is one
  projection of both.
