# ADR 62 — `ResourcesHarness`: resources as a framework primitive, MCP as a projection

**Status:** PROPOSED 2026-07-07 (Fable, for Ryan). MCP enhancement **Wave 4** (the biggest;
gates on this ADR). **Builds on:** ADR 26 (harness API shape), ADR 27 (modular built-ins —
bundled ≠ privileged), the **`ElicitationHarness` precedent** (a framework primitive MCP
projects onto), ADR 49 (store-port pattern, for the durable-provider case). **Resolves the
design half of** #237 / #123 (MCP resources "never fulfilled").

## TL;DR

Model Context Protocol resources — named, URI-addressed, readable content with **templates**,
**subscriptions** (`resources/updated`), and `list_changed` — are **not an MCP concept in
agentick; they are a framework concept that MCP projects.** Introduce a bundled
**`ResourcesHarness`** (a `BaseHarness`, exactly like timeline / state / tasks / elicitation),
shaped 1:1 with the MCP resource spec so the projection is a thin mapping, and usable by
**any** consumer (a `<Resource>` component, a tool, the session) — not just MCP. This is the
elicitation pattern applied to resources: *the seam runs through the framework; MCP is one
edge of it.*

**The one asymmetry to get right:** elicitation is **symmetric** — "ask the user" is the same
operation no matter who asks, so agentick's own elicit *and* an external server's elicit both
resolve through the one `ElicitationHarness` (agentick is always the *responder*). Resources
are **asymmetric** — a **provider** exposes them and a **consumer** reads them. So
`ResourcesHarness` is the **provider** seam (agentick's own resources → projected out over
MCP-server). **Consuming an *external* server's resources is a separate read** on the MCP
*client* harness (Wave 2), which a `<Resource src="mcp://…">` can source from — composed, not
folded into the provider registry (folding would conflate "resources agentick owns" with
"resources agentick reads," and mis-attribute ownership/subscription).

## Why a new harness (steel-manned null hypothesis)

Can resources ride an existing primitive instead of a new harness? No — the shape doesn't fit
any:

- **Sections / content tree (Class B):** what renders *into model context* now. Resources are
  *addressable, on-demand-readable* content (a client `read`s a URI when it wants it), with
  templates + subscriptions + mime types. Not the same lifecycle.
- **State / KV (Class C):** key→value, `get`/`set`. Resources add **URI templates**
  (parameterized reads), **per-URI subscriptions + `updated`**, **`list_changed`**, and
  **content typing** (text/blob + mimeType). A KV store models none of those.
- **Timeline:** the conversation log. Unrelated.

The list/read/**templates**/**subscribe+updated**/**list_changed**, content-typed shape is a
distinct primitive — and it already has ≥3 prospective consumers (MCP-server projection, a
`<Resource>` primitive, adopter tools), clearing the three-consumers bar. It belongs in the
harness family (timeline/state/tasks/elicitation/knobs/skills), not bolted onto one of them.

## The harness surface (aligned 1:1 with the MCP resource spec)

`ResourcesHarness extends BaseHarness` — declared commands (ADR 51: journaled, wire-exposable,
deny-by-default), Promise-shaped at the edge, Effect internal. The verbs mirror the protocol so
the MCP projection is a rename, not a translation:

```ts
interface ResourcesHarnessProtocol {
  // — provider registration (framework consumers register what agentick exposes) —
  register(resource: ResourceEntry): Unsubscribe;              // fixed URI
  registerTemplate(template: ResourceTemplateEntry): Unsubscribe; // uriTemplate + resolver
  // — reads (what the projection / a <Resource> / a tool calls) —
  list(cursor?: string): Promise<{ resources: ResourceDescriptor[]; nextCursor?: string }>;
  listTemplates(cursor?: string): Promise<{ templates: ResourceTemplateDescriptor[]; nextCursor?: string }>;
  read(uri: string): Promise<ResourceContents[]>;             // text/blob + mimeType, per URI
  // — subscriptions (per-URI change stream) —
  subscribe(uri: string): Promise<Unsubscribe>;
  // — provider-side change signal → fans to subscribers + the MCP `updated` notification —
  notifyUpdated(uri: string): void;
  // list_changed fires automatically on register/unregister (registry mutation).
  readonly backend: string;
}
```

- **`ResourceContents`** is content-typed (`{ uri, mimeType, text }` | `{ uri, mimeType, blob }`),
  matching the MCP `TextResourceContents` / `BlobResourceContents` union — so `read` results
  map straight to the wire and (the other direction) to an agentick **resource content block**
  (see below).
- **Templates** carry a `uriTemplate` (RFC 6570) + a resolver `(uri) => ResourceContents[]`;
  `read` matches a concrete URI against fixed entries first, then templates.
- **Subscriptions + `updated`** ride `BaseHarness`'s bus/notification machinery — `subscribe`
  registers interest; `notifyUpdated(uri)` fans to subscribers. Providers call it when content
  changes; a **reactive `<Resource>`** (below) calls it automatically when its signal changes.
- **`list_changed`** fires on registry mutation (like tool `list_changed`).
- Pagination cursors are first-class on the list verbs (MCP requires them; most harnesses punt —
  resources shouldn't).

## Framework consumers (the seam is general, not MCP-only)

- **`<Resource>` component** (reconciler primitive): declare a resource in the tree —
  `<Resource uri="config://app" mimeType="application/json">{() => JSON.stringify(cfg())}</Resource>`.
  Reactive body → when its signal changes, the harness auto-`notifyUpdated`s. Templates via a
  `uriTemplate` prop + a resolver. This is the ergonomic front door; it registers into the
  session's `ResourcesHarness`.
- **Tools** can `read` resources through the harness (via `use()`), or a resource can be the
  output of a tool.
- **The gateway / any harness** can expose resources (logs, status, catalogs) uniformly.

None of these know about MCP. MCP is just the most prominent *projection*.

## MCP projections (both edges)

- **Server (agentick-as-MCP-server) — the #237 core.** The `mcp-next` server projection maps
  the harness 1:1 onto the wire: `resources/list` → `list`, `resources/templates/list` →
  `listTemplates`, `resources/read` → `read`, `resources/subscribe`/`unsubscribe` →
  `subscribe`, `notifyUpdated` → `notifications/resources/updated`, registry mutation →
  `notifications/resources/list_changed`. Advertise `resources: { subscribe: true, listChanged:
  true }` only when a harness is wired (fixes the hardcoded `resources:false`). This is a thin
  projection package (`mcp-next/server/projection/resources.ts`) over the framework harness —
  exactly like `projection/elicitation.ts` is thin over the elicit seam.
- **Client (agentick-as-MCP-client) — Wave 2, separate.** Reading an *external* server's
  resources is `McpClientHarness` methods (`listResources`/`readResource`/`listResourceTemplates`
  + `subscribe`). These do **not** register into the local `ResourcesHarness` (that's the
  provider registry for resources agentick *owns*). Instead a **`<Resource src="mcp://<server>/<uri>">`**
  sources its content from the client harness — composition at the tree level, not conflation at
  the registry level. (Contrast elicitation, where the client-side external request *does* route
  through the one harness — because there agentick is the responder either way; here agentick is
  consumer, not provider.)

## Resource content block (the `content-mapper.ts:53` TODO)

MCP tool/prompt results can embed resources (`{ type: "resource", resource: {...} }`), and
`ui://` app resources are resources too. Introduce a spec **resource content block**
(`{ type: "resource"; resource: ResourceContents }`) so embedded resources round-trip through
agentick's content model instead of being flattened to text (today `content-mapper.ts` drops
them). `read` results and embedded resources share this block. `ui://` handling is deferred to
the separate `@agentick/mcp-apps-next` package (Ryan's call) — the block is protocol-general;
the *rendering* of `ui://` is the app package's concern.

## Durable resources (optional, later)

Most resources are **re-derivable** (Class B — declared in the tree, rebuilt on render) — no
store needed; the harness holds the live registry. A provider that needs **durable** resource
*content* across restart uses the ADR-49 store-port pattern (`register` a resource whose
resolver reads a `ResourceStore`), not a special case in the harness. Out of scope for Wave 4;
noted so the harness doesn't foreclose it.

## Package shape

`@agentick/resources-next` — a **bundled built-in** (metapackage bundles it; not privileged,
per ADR 27), mirroring the per-harness layout used by elicitation/timeline:

```
resources-next/src/
  harness.ts          — ResourcesHarness (BaseHarness impl)
  augment.ts          — adds the HookBridges slot
  extension.ts        — withResources() session-extension factory
  conformance.ts      — runResourcesHarnessConformance
  react/              — <Resource> component + hooks (deps reconciler-react, no cycle)
  testing/            — stubResourcesHarness
  __tests__/          — harness + integration-with-reconciler
```
Spec (`@agentick/spec-next`) carries only the **wire/firewall types** — `ResourceDescriptor`,
`ResourceContents`, `ResourceTemplateDescriptor`, the resource content block, the
`ResourcesHarnessProtocol` interface — never the harness impl.

## Conformance

`runResourcesHarnessConformance` (ships from the package, ADR-49/sandbox idiom): register/list
(+ pagination cursor), read fixed + templated URIs, subscribe → `notifyUpdated` fans to
subscribers, `list_changed` on registry mutation, content typing (text + blob). Then the **MCP
projection round-trip** in `mcp-next`: loopback (`McpServerHarness` with a `ResourcesHarness` ↔
`McpClientHarness` reads every op) **and** against the official `server-everything` /
inspector (the only way to catch wire drift, since both sides share the SDK).

## Decisions for Ryan
1. **The provider/consumer asymmetry** (harness = provider seam; external-read = client method,
   composed via `<Resource src>`). This is the core call — the alternative is one bidirectional
   harness that also proxies external resources (more "unified" but conflates ownership +
   subscription lifecycle). **Recommend the asymmetric split.**
2. **Resource content block in spec** — add it now (Wave 4) so embedded resources stop being
   flattened. **Recommend yes.**
3. **`<Resource>` reactive auto-`updated`** — auto-fire `notifyUpdated` when a reactive resource
   body's signal changes (ergonomic, matches the framework's reactive model) vs. explicit
   `notifyUpdated` only. **Recommend auto + explicit escape hatch.**

## Scope
This ADR is the Wave-4 foundation. Build order once ratified: `ResourcesHarness` + conformance
+ `<Resource>` → server projection (#237) → client reads (Wave 2 overlap) → `withMCP` surfacing.
The client-consumption reads land in Wave 2; the provider harness + server projection are Wave 4.
