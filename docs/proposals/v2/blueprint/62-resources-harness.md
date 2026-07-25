# ADR 62 — Resources as a read-projection seam; roots as the sandbox's projection

**Status:** PROPOSED 2026-07-07, **REFRAMED 2026-07-07** (Fable + Ryan) after asking what
resources *actually are* at the compiler level. MCP enhancement **Wave 4** (gates on this ADR).
**Builds on:** ADR 26 (harness shape), ADR 27 (bundled built-ins), the **`ElicitationHarness` /
`PromptsHarness`** precedent (framework primitives MCP projects onto), ADR 59 (the sandbox =
the workspace). **Resolves the design half of** #237 / #123.

## The reframe (why v1 of this ADR was wrong)

The first draft modeled resources as a new bundled **store** with a `<Resource>` JSX front door.
Both were mistakes. Two questions corrected it:

1. **What is a resource, at the compiler level?** The framework's core is *compilers → IR →
   model input* (the React reconciler is **one** compiler; a dep-less functional compiler is
   another). A resource is not a store and not RAG (no retrieval/ranking — that's an app concern
   *on top*). It is a **content-addressable read namespace** — `list`/`read`/`templates`/
   `subscribe` ≈ `readdir`/`cat`/`glob`/`watch`. It is **application-controlled context**: the MCP
   server trio splits by control — tools = *model*-controlled, prompts = *user*-controlled,
   **resources = *application*-controlled** readable content, pulled on demand.
2. **Does agentick own the content?** No. `PromptsHarness` earns primitive-hood because it *owns*
   a template library (loaders + renderer). **Resources own nothing** — the content lives in the
   sandbox (files), a store (docs), or a computed view. So resources is not a store; it is a
   **thin projection seam: a registry of `URI → resolver` + the subscribe / `list_changed`
   notifier**, where resolvers read from wherever the content already lives.

So: **framework primitive + thin MCP projection** (the elicitation/prompts pattern holds), but
**thinner than either** — a read-projection over existing content sources, front-end-agnostic,
with roots delegated to the sandbox.

## The seam (a registry of resolvers, not a store)

`ResourcesHarness extends BaseHarness` — but it is a **registry + notifier**, not a content
store. It holds `URI → resolver` bindings (and `uriTemplate → resolver` for parameterized reads)
and owns the subscription/`list_changed` machinery (which is why it's a harness: correlation +
bus + declared/journaled commands come from `BaseHarness`). It does **not** hold content.

```ts
interface ResourcesHarnessProtocol {
  // — registration: bind a URI (or template) to a resolver over EXISTING content —
  register(uri: string, resolver: ResourceResolver, meta?: ResourceMeta): Unsubscribe;
  registerTemplate(uriTemplate: string, resolver: TemplateResolver, meta?: ResourceTemplateMeta): Unsubscribe;
  // — reads (the projection / a compiler / a tool calls these) —
  list(cursor?: string): Promise<{ resources: ResourceDescriptor[]; nextCursor?: string }>;
  listTemplates(cursor?: string): Promise<{ templates: ResourceTemplateDescriptor[]; nextCursor?: string }>;
  read(uri: string): Promise<ResourceContents[]>;   // resolver runs; content-typed (text/blob + mimeType)
  // — change stream —
  subscribe(uri: string): Promise<Unsubscribe>;
  notifyUpdated(uri: string): void;                 // a provider signals its backing content changed
  readonly backend: string;
}
type ResourceResolver = (uri: string) => ResourceContents[] | Promise<ResourceContents[]>;
```

- **Resolvers read from existing content** — a file resolver reads the **sandbox** fs; a doc
  resolver reads a store; a computed resolver builds a view. The harness never duplicates that
  content; it just routes a `read(uri)` to the right resolver.
- **`ResourceContents`** = `{ uri, mimeType, text }` | `{ uri, mimeType, blob }` (matches MCP's
  text/blob union) → maps straight to the wire and to a **resource content block** (below).
- **Subscribe/`updated`** rides `BaseHarness`'s bus; `notifyUpdated(uri)` fans to subscribers.
  `list_changed` fires on registry mutation. (Mirrors how the prompts projection is driven by the
  `PromptsHarness` change-notifier.)
- **Pagination** cursors are first-class on the list verbs (MCP requires them).

## Compiler-general, front-end-agnostic (not a JSX component)

The primitive is the **runtime registry + read/subscribe interface** — it must serve *any*
compiler, because the compiler is the swappable core:

- **React reconciler:** a `<Resource uri=… mimeType=…>{() => content()}</Resource>` registers a
  resolver into the session's `ResourcesHarness`; a reactive body auto-`notifyUpdated`s when its
  signal changes.
- **Functional / dep-less compiler** (the `agent((ctx) => IRNode[])` aspiration): a plain
  `ctx.resource(uri, resolver)` registers the same binding — no JSX.
- **Imperative / gateway:** `harness.register(uri, resolver)` directly.

All three populate the *same* registry; the MCP projection and the compiler read it the same way
regardless of front-end. JSX is one sugar, not the seam. (The earlier draft's `<Resource>`-first
framing is dropped.)

## Roots = the sandbox's projection (not a new primitive)

MCP **roots** ("the directories this agent may operate on") is the *filesystem-boundary* concern
for agents that live and work on a machine — and **agentick already has that primitive: the
sandbox** (`workspace` + allowed `mounts`, `sandbox/contract.ts`). So:

- **Roots project from the sandbox.** Client-side, agentick advertises its sandbox workspace +
  mounts as MCP roots (+ `roots/list_changed` when mounts change). No new roots subsystem.
- **File-type resources are sandbox-backed** — a file resolver reads the sandbox fs, confined to
  the workspace/mounts (the sandbox's existing path-confinement + ACL apply). One coherent
  filesystem story: *sandbox = the workspace (roots); resources = the read namespace, files
  resolved through the sandbox.*

This is the compose-primitives answer: roots + file-resources are MCP-facing **projections of the
sandbox**, not duplicated state.

## Provider / consumer asymmetry (kept)

Elicitation is symmetric (a responder seam — agentick answers whoever asks). Resources are
asymmetric: a **provider** exposes, a **consumer** reads. So:
- **Provider (agentick-as-MCP-server):** the `ResourcesHarness` registry is projected out —
  `resources/list|templates/list|read|subscribe|unsubscribe` + `notifications/resources/{updated,
  list_changed}`. Advertise `resources: { subscribe, listChanged }` only when a harness is wired
  (fixes the hardcoded `resources:false`). The projection is thin — it reads the registry, never
  mutates it (exactly like `projection/prompts.ts`).
- **Consumer (agentick-as-MCP-client):** reading an *external* server's resources is
  `McpClientHarness` methods (`listResources`/`readResource`/…, Wave 2). These do **not** register
  into the local registry (that's for content agentick *provides*). Instead a resolver can *wrap*
  an external read — e.g. `register("proxy://…", () => client.readResource(externalUri))` — so
  the compiler consumes external content through the same read interface. Composition, not
  conflation.

## Resource content block (kept — the `content-mapper.ts:53` TODO)

Add a spec **resource content block** (`{ type: "resource"; resource: ResourceContents }`) so
embedded resources in tool/prompt results (and `ui://` app resources) round-trip through
agentick's content model instead of being flattened to text (today `content-mapper.ts` drops
them). `read` results and embedded resources share it. `ui://` *rendering* is the separate
`@agentick/mcp-apps` package's concern; the block is protocol-general.

## Package shape

`@agentick/resources` — bundled built-in (ADR 27), per-harness layout (harness/augment/
extension/conformance/testing + an optional `react/` `<Resource>` that deps reconciler-react, no
cycle). Spec carries only wire/firewall types (`ResourceDescriptor`, `ResourceContents`,
`ResourceTemplateDescriptor`, the resource content block, `ResourcesHarnessProtocol`).
**No roots package** — roots is a sandbox projection in `mcp-next` (client side) reading the
sandbox harness.

## Conformance
`runResourcesHarnessConformance`: register/list (+ pagination), read fixed + templated URIs (via
resolvers), subscribe → `notifyUpdated` fans, `list_changed` on mutation, text+blob typing. MCP
projection round-trip in `mcp-next`: loopback (server harness ↔ client reads every op) + against
the official `server-everything`/inspector (catches wire drift the shared-SDK loopback can't).
Roots: a sandbox-backed roots projection test (workspace/mounts → `roots/list` + `list_changed`
on mount change).

## Decisions (settled with Ryan 2026-07-07)
1. **Resources = read-projection seam (registry of URI→resolvers + notifier), NOT a store.** ✅
2. **Roots project from the sandbox; file-resources are sandbox-backed.** ✅
3. **Compiler-general / front-end-agnostic** — registry is the seam; `<Resource>` and
   `ctx.resource()` are equal front-ends. ✅
4. **Provider/consumer asymmetry** + **resource content block in spec.** ✅

## Scope / build order (Wave 4, after Wave 2 client reads)
`ResourcesHarness` (registry+notifier) + conformance + the resource content block → server
projection (#237) → sandbox-backed file resolver + roots projection → `withMCP` surfacing +
front-ends (`<Resource>` / `ctx.resource`). Client external-resource reads land in Wave 2 and are
composed via wrapping resolvers, not folded into the registry.
