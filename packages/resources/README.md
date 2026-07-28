# @agentick/resources

`ResourcesHarness` — a **read-projection seam** over existing content, not
a store (ADR 62). A registry of `URI → resolver` bindings (plus
`uriTemplate → resolver`) and the subscribe / `list_changed` notifier.
The harness owns **no content**: a resolver reads from wherever the
content already lives (the sandbox fs, a document store, a computed
view); `read(uri)` routes to the matching resolver.

The MCP server trio splits readable context by control:

| Surface   | Controlled by | Primitive              |
| --------- | ------------- | ---------------------- |
| tools     | the model     | `ToolsHarness`         |
| prompts   | the user      | `PromptsHarness`       |
| resources | the app       | **`ResourcesHarness`** |

Resources are the **application-controlled** slice — readable content the
app exposes and the model/client pull on demand.

Private workspace package. Bundled into the `agentick` metapackage; not
published independently.

## Purpose

The framework's core is _compilers → IR → model input_. A resource is not
a store and not RAG — it is a **content-addressable read namespace**
(`list` / `read` / `templates` / `subscribe` ≈ `readdir` / `cat` / `glob`
/ `watch`). Because agentick owns no resource content, this harness is
**thinner than `PromptsHarness`**: a registry of resolvers + a
change-notifier, front-end-agnostic, projected onto MCP `resources/*` by
the server harness exactly as prompts are projected onto `prompts/*`.

**Provider / consumer asymmetry.** This is the PROVIDER seam — agentick's
own resources projected OUT (agentick-as-MCP-server). Reading an
_external_ server's resources is a `McpClientHarness` concern (Wave 2);
compose it with a wrapping resolver
(`register("proxy://…", () => client.readResource(uri))`), not by folding
external content into this registry.

## Quick start

```ts
import { ResourcesHarness } from "@agentick/resources";

const resources = new ResourcesHarness(scopeId, journal, bus, inbox);
await resources.ready;

// Bind a fixed uri to a resolver over EXISTING content.
resources.register(
  "config://app.json",
  () => [{ uri: "config://app.json", mimeType: "application/json", text: readConfig() }],
  { name: "App config", description: "current app configuration" },
);

// Bind a URI template — the resolver receives the CONCRETE uri.
resources.registerTemplate("db://users/{id}", (uri) => [
  { uri, mimeType: "application/json", text: loadUser(parseId(uri)) },
]);

// A resolver also receives the INVOKING op's ctx (ADR 91 §2) as an optional
// second param — the trunk (sessionId / opId / `user`) + `log` / `trace` /
// `run` facets. The `read` path threads the ctx of the op that invoked it, so
// an identity-scoped resolver resolves per-principal content:
resources.register("knowify://me", (uri, ctx) => [
  { uri, mimeType: "application/json", text: loadProfile(ctx?.user) },
]);

const contents = await resources.read("db://users/42"); // runs the template resolver
const { resources: page, nextCursor } = await resources.list();

// A provider signals its backing content changed → fans to subscribers.
resources.notifyUpdated("config://app.json");
```

Project it onto the wire via the MCP server harness:

```ts
new McpServerHarness(id, journal, bus, inbox, {
  name: "my-server",
  transports: [httpTransport()],
  resources: { use: resources, filter: (r, ctx) => isVisible(r, ctx) },
});
// → advertises `resources: { subscribe: true, listChanged: true }`,
//   serves resources/list · templates/list · read · subscribe ·
//   unsubscribe, and fans notifications/resources/{updated,list_changed}.
```

## Registry vs. store

`register` / `registerTemplate` bind a **resolver function**, so per
ADR 51 §1.2 (ops with required function parameters must NOT be declared
commands) they are plain in-process methods returning an `Unsubscribe`.
The **reads** — `read` / `list` / `listTemplates` — carry serializable
data both ways, so they ARE declared commands (`this.command()`):
journaled, inbox-addressable, and wire-enumerable, exactly like
`prompts:get`.

## Change streams

Two distinct notifier streams — kept separate because the events are
semantically distinct (unlike prompts, where every change is "a
declaration changed"):

- `subscribe(uri, listener)` fires on `notifyUpdated(uri)` →
  MCP `notifications/resources/updated`.
- `subscribeAll(listener)` fires on register / unregister →
  MCP `notifications/resources/list_changed`.

## Durable backing (store + loaders)

Resources is the definition-library archetype's **richest instance**
(data-layer plan §6-C, Phase 5). Its state lives in **three** structures,
and — crucially — the harness is **store-backed but NOT `SnapshotCapable`**
(store-backed ≠ snapshot-backed):

| Structure              | Holds                                    | Fed by                                    |
| ---------------------- | ---------------------------------------- | ----------------------------------------- |
| **`ResourceStore`**    | serializable `ResourceDeclarationRecord` | **durable** loaders only                  |
| **catalog projection** | declaration slice `snapshot()` reads     | durable (mirrored) + transient (overlaid) |
| **resolver sidecar**   | the non-serializable `resolver` fn       | both durable + transient                  |

Two **source classes** coexist:

- **Durable** resources come from a `ResourceLoader` (array / module /
  DB / fs — the source resources lacked before). A loaded item carries a
  `declaration` (→ the store) **and** a `resolver` (→ the sidecar).
  `reload()` upserts them; `read()` does lookup-on-miss against the
  loaders. These survive a restart via the store (declarations reload
  from the loader source).
- **Transient** resources come from `register` / `registerTemplate` /
  `<Resource>` tree-mounts. They are registry-only — they **never** touch
  the store and re-mount from the tree on restart.

Because the resolver is non-serializable (a live fn), it lives in the
sidecar and can **never** reach the store — the `ResourceDeclarationRecord`
type makes that a compile-time guarantee, exactly as `PromptDeclarationRecord`
excludes `render`/`template`. On resume `hydrate()` mirrors the store's
declarations into the catalog (so the model still sees the resource
listed), but `read()` throws `ResourceNotFound` until the loaders re-run
and re-attach the resolver.

**Dual-key store — one collection, `kind`-discriminated.** Fixed resources
key by `uri`, templates by `uriTemplate`; the record's `kind` field
discriminates. A single `MemoryCollection` (keyed by `uri ?? uriTemplate`)
backs both — template keys always contain `{…}` and fixed uris never do,
so the key-spaces are disjoint in practice. `ResourceStoreQuery` enumerates
one class (`list({ kind: "template" })`) or filters by `uri` substring;
exact lookup is `get(uri)`. A durable adapter (Postgres, a filesystem
source) conforms to the same `ResourceStore` port and passes
`runResourceStoreConformance`.

```ts
import { fromArray } from "@agentick/resources";

harness.setLoaders([
  fromArray([
    {
      declaration: { uri: "db://doc", kind: "fixed", meta: { name: "Doc" } },
      resolver: () => [{ uri: "db://doc", mimeType: "text/plain", text: "…" }],
    },
  ]),
]);
await harness.reload(); // → store.put(declaration) + sidecar(resolver) + catalog
```

## URI templates

`registerTemplate` compiles an RFC 6570-lite pattern:

| Expression | Matches                           |
| ---------- | --------------------------------- |
| `{name}`   | exactly one path segment (no `/`) |
| `{+name}`  | reserved expansion (incl. `/`)    |
| `{/name}`  | path expansion (incl. `/`)        |

Everything else is a regex-escaped literal, anchored end-to-end.
`read(uri)` prefers a fixed binding, then the first matching template.

### File resolvers (`file://{+path}`) — from `@agentick/sandbox/mcp`

A ready-made `file://` `TemplateResolver` ships from the sandbox package's
opt-in `/mcp` subpath (ADR 65), so a filesystem boundary declared as an
MCP **root** is also **readable** as a resource:

```ts
import { sandboxFileResolver, fsFileResolver, registerFileResolver } from "@agentick/sandbox/mcp";

// Read through a sandbox (ACL-gated; text, per the handle contract):
registerFileResolver(resources, sandboxFileResolver(sandbox));
// …or off the local filesystem, rooted + containment-checked (no sandbox):
registerFileResolver(resources, fsFileResolver("/srv/data"));
```

`registerFileResolver(resources, resolver, meta?)` binds under the
canonical `file://{+path}` template (reserved expansion so full paths
match). The `fs` backend reads text as UTF-8 and non-text losslessly as a
base64 blob; the sandbox backend is text-only (handle contract, ADR 59).
The resolver lives WITH the sandbox because it deps the sandbox handle —
resources stays content-agnostic (it owns the seam, not the backend).

## API

### `ResourcesHarness` (class)

`extends BaseHarness<"resources">`. Construct with
`(scopeId, journal, bus, inbox, options?)`. Options: `pageSize`
(default 100), `backend` (default `"memory"`), `store?`
(`ResourceStore`; defaults to a fresh `InMemoryResourceStore`), `loaders?`
(`ResourceLoader[]` for the durable source). See **Durable backing**.
Beyond the protocol surface the class also exposes `setLoaders(loaders)`,
`reload()`, and `hydrate()`.

### `harness.fx` — the Effect-canonical read face

`read` / `list` / `listTemplates` are declared commands, so each has an
Effect twin: `fx.read({ uri })`, `fx.list({ cursor? })`,
`fx.listTemplates({ cursor? })`. Same command, un-run — the positional
Promise methods (`read(uri)`) are the edge facade with `runPromise` applied
at the boundary.

Reach for `fx` when the caller is already inside an operation and the read
must stay in ITS fiber tree. That is not a performance preference — it is
what carries identity into your resolver:

```ts
// Inside an enclosing operation — composed in ITS fiber tree:
Effect.gen(function* () {
  const contents = yield* resources.fx.read({ uri });
  // → resources:command:read is a CHILD of the enclosing op, and the
  //   resolver's `ctx` carries the caller's identity + the enclosing opId
  //   as parentOpId.
});

await resources.read(uri);
// → a fresh ROOT fiber: no ambient trunk to inherit, so the resolver sees
//   only the harness's own scope. Correct for a top-level adopter call.
```

The MCP server's `resources/read` projection is the reference consumer: it
runs `fx.read` on the crossing operation's runtime, which is how a wire
caller's identity reaches an identity-scoped resolver (ADR 92 §Slice A).

### `InMemoryResourceStore` · `ResourceStore` · `ResourceLoader`

The bundled in-memory default store, its port (`ResourceStore extends
CollectionStore<ResourceDeclarationRecord, ResourceStoreQuery>`, in
`@agentick/spec`), and the loader type + factories (`fromArray`,
`fromModule`). `runResourceStoreConformance({ label, factory })` validates
any adapter against the port. There is deliberately **no** URL loader — a
JSON source cannot carry a resolver fn, and a resolver-less resource can
never be `read()`.

### `withResources(options?)` — `SessionExtension`

Opt into the model-facing surface. The AppHarness constructs the
per-session `ResourcesHarness` at the single construction site (#159,
like tasks/elicitation) and wires it into `ctx.resource`,
`bridges.resources`, `session.resources`, and `installer.resources` — so
`withResources()` does **not** construct a harness. It auto-registers two
model tools (default-on):

- `resource_list` — enumerate available resources + templates (paginated).
- `resource_read` — read one uri; returns first-class `resource` content
  blocks (text/blob round-trip). A failed read surfaces the harness's
  typed error, not a silent empty.

`WithResourcesOptions.registerModelTools: false` installs the substrate
without the model surface (e.g. resources exposed only over the MCP
server projection, or read exclusively from adopter code).

```ts
createApp(<Agent />, { model, extensions: [withResources()] });
```

## Front-ends

One registry, three equal front-ends over `register` (ADR 62) — an
adopter cannot tell which came first:

| Front-end                       | Where                            |
| ------------------------------- | -------------------------------- |
| `ctx.resource.read(uri)`        | tool handlers (like `ctx.tasks`) |
| `session.resources.read(uri)`   | adopter / server-side code       |
| `<Resource>` (`/react` subpath) | inside a JSX agent tree          |

### `<Resource>` (`@agentick/resources/react`)

Reads like `<Tool>`: registers a `uri → resolver` binding on mount,
unregisters on unmount. Depends on `@agentick/compiler-react`'s
`useBridges` (no cycle — compiler-react never imports this package).

```tsx
import { Resource } from "@agentick/resources/react";

// static content (string or ResourceContents)
<Resource uri="config://app" name="App config" content={JSON.stringify(cfg)} />

// resolver prop (lazy, may be async)
<Resource uri="db://count" resolver={async () => `${await count()}`} />

// children-as-resolver
<Resource uri="file://readme" mimeType="text/markdown">{() => readme}</Resource>

// template — the resolver receives the CONCRETE matched uri
<Resource uriTemplate="file://{path}">{(uri) => readFile(uri)}</Resource>
```

Precedence when more than one is given: `resolver` prop > function child >
`content`. `useResourceBridge()` is exported for custom components.

### Catalog surfacing (default projection, ADR 63)

`<Resource>` does **not** render a host intrinsic. Instead the compiler
runs a `resources` **default projection** that folds the registry into a
compact CATALOG section (uris + names + descriptions — NOT content;
resources are pulled on demand). It reads `bridges.resources` structurally
(no cross-harness import) and is lazy/overridable: a
`<Project projectionKey="resources">` suppresses it. Absent any resources,
it contributes nothing.

### `runResourcesHarnessConformance(label, factory)`

The shared conformance suite. Runs register/list (+ pagination), read
fixed + templated, unknown-uri error, text + blob typing, subscribe →
notifyUpdated fan, and list_changed on mutation against any impl.

### `compileUriTemplate(t)` / `matchesTemplate(re, uri)`

The URI-template matcher, exported for reuse.

### `snapshot()`

Synchronous, unpaginated registry snapshot (`{ resources, templates }`,
sorted) — the sync-read counterpart to `list` / `listTemplates` that the
`resources` default projection folds during a synchronous render.

### `/react`

`<Resource>` + `useResourceBridge()`. See **Front-ends** above.

### `/testing`

`fakeResources()` — a real `ResourcesHarness` over an in-memory
substrate (preferred for consumer tests). `stubResources({ contents })`
— canned-answer double, no substrate round-trip.

## Protocol surface (`ResourcesHarnessProtocol`)

`id` · `ready` · `backend` · `close()` · `register` · `registerTemplate`
· `list` · `listTemplates` · `read` · `has` · `subscribe` ·
`subscribeAll` · `notifyUpdated`. Errors:
`ResourceNotFound` · `ResourceAlreadyRegistered` ·
`ResourceResolverFailed` · `ResourcesBackendError`.

## Status

Wave 4b pt2 (ADR 62 / 63 / #237) — the front-ends
(`ctx.resource` · `session.resources` · `<Resource>` · `withResources`
model tools), the `resources` catalog default projection, and `withMCP`
remote-resource surfacing (keyed by adopter alias) all landed on top of
Wave 4a (harness + conformance + MCP server projection).

Data-layer Phase 5 run #9 added the **durable store backing** — a
`ResourceStore` (dual-key, `kind`-discriminated), `ResourceLoader`
sources, the durable/transient/resolver-sidecar split, and
`runResourceStoreConformance` — WITHOUT making the harness
`SnapshotCapable` (the store is the durable source, not a snapshot). The
`resources` catalog default projection (the render-read IR fold) is
unchanged. Green.

## Roadmap & known gaps

- **Roots/mounts seam + file-resolver (ADR 65): landed.**
  `sandboxRootsSource` / `bindSandboxRootsToClient` (outbound roots),
  inbound `ctx.mcp.clientRoots`, and `sandboxFileResolver` /
  `fsFileResolver` / `registerFileResolver` (file → resource) ship from
  `@agentick/sandbox/mcp`.
- **Remote MCP resource surfacing (`withMCP`): landed.** A connected
  server's resources are proxy-registered under `mcp://<alias>/<uri>` —
  see `@agentick/mcp`'s README (resource surfacing + alias trust).
- **Client-side external-resource consumption** landed in Wave 2
  (`McpClientHarness`); compose it via wrapping resolvers, not folded
  into this registry.
- **Filter scope.** The MCP projection's `filter` gates FIXED resources
  (list + read). Templated reads carry no fixed descriptor and bypass it.
- **Pagination** is offset-based with an opaque decimal cursor over a
  stable-sorted (by uri) snapshot.

## Client (`@agentick/resources/client`)

The wire twin of `session.resources`, per ADR 87 (a harness that projects a
session handle ships the matching client handle). Importing
`@agentick/resources/client` self-assembles `client.session(id).resources`:

```ts
import "@agentick/resources/client"; // (bundled by @agentick/client)

const resources = client.session(id).resources;
resources.list(); // sync snapshot of ResourceDescriptor[] (eager resources/list poll)
resources.get("file:///a.txt"); // by uri, sync
await resources.listTemplates(); // ResourceTemplateDescriptor[] (RPC)
await resources.read("file:///a.txt"); // ResourceContents[] (RPC)
await resources.refresh(); // force a resources/list re-poll
resources.subscribe(() => {
  /* re-read on change */
});
```

RPC-backed (no `resources-state` delta channel yet — the reactive mirror rides
the client channel-consumer primitive later): `list()`/`get()` read a local
snapshot seeded by an eager `resources/list` poll; `read`/`listTemplates` are
pure RPC. The snapshot fills itself — the poll fires `subscribe` when it lands,
so binding `list()` + `subscribe()` is the whole read path and no boot-time
`refresh()` is needed; `refresh()` invalidates a snapshot you already have, and a
failed first poll settles empty until it (or the next mutation) recovers it.
The `resources/*` wire rows are declared type-only in
`src/wire-augment.ts` (imported by both the server `augment.ts` and the client
subpath, so the `/client` bundle loads no server code).

## Verified by

- `src/client/__tests__/resources-handle.spec.ts` — client handle unit:
  eager `resources/list` seed populates `list()` (unwrapped from
  `.resources`); `read`/`listTemplates` are pure RPC (no `resources/list`
  follow-up); `get(uri)` from snapshot; `refresh()` re-polls; `subscribe(cb)`
  fires with no args; the seed notifies subscribers when it lands (no boot
  `refresh()` needed) and settles empty on a failed poll. (7 tests)
- `src/client/__tests__/session-resources.spec.ts` — ADR 87 self-assembly:
  importing `/client` registers `client.session(id).resources`; `read(uri)`
  issues `resources/read` over the transport. (2 tests)
- `src/__tests__/conformance.spec.ts` — runs the exported
  `runResourcesHarnessConformance` suite against this package's impl:
  register/list/has, name-defaults-to-uri, pagination with no
  overlap/omission, fixed + templated read, unknown-uri
  `ResourceNotFound`, text + blob typing, `subscribe` → `notifyUpdated`
  fan (matching uri only), `list_changed` on register + unregister.
  (9 tests)
- `src/__tests__/harness.spec.ts` — impl-specific: duplicate fixed +
  template registration errors, `backend` default + override,
  `listTemplates` descriptors, fixed-over-template read precedence,
  `ResourceResolverFailed` on throwing + rejecting resolvers,
  declared-command journaling (`read` emits requested + terminal on the
  resources surface), URI-template match semantics. (11 tests)
- `src/__tests__/tools.spec.ts` — `resource_list` / `resource_read`
  handlers (enumerate fixed + templates, first-class `resource` blocks,
  typed error surfaced not swallowed, honest degrade when no harness) +
  `withResources` registers both tools by default / suppresses them under
  `registerModelTools:false`. (6 tests)
- `src/react/__tests__/resource.spec.tsx` — `<Resource>` register/read
  via all three content sources, template concrete-uri resolution,
  unmount unregisters, and the `resources` catalog default projection
  (folds a `SectionEntry` tagged `default:resources`; empty registry
  contributes nothing; `<Project>` override suppresses). (7 tests)
- `src/__tests__/store-backing.spec.ts` — the durable/transient/sidecar
  split: a durable loader feeds the store (declaration) + sidecar
  (resolver, never the store); transient `register`/`registerTemplate`
  stay registry-only; `resolverFor` fixed-over-template precedence;
  `snapshot()` combines durable + transient; lookup-on-miss; `hydrate()`
  surfaces declarations while `read()` waits for the resolver; the harness
  is NOT `SnapshotCapable`. Plus `runResourceStoreConformance` against
  `InMemoryResourceStore` (backend id, empty-read, idempotent delete,
  put/get round-trip both kinds, upsert, `kind`/`uri` list filters).
- `@agentick/app` `substrate-single-construction-site.spec.ts` —
  `installer.resources` === `session.resources` (single site) +
  `resource_read` reaches the same harness via `ctx.resource`
  (dispatch round-trip).
- `@agentick/mcp` `resource-surface.spec.ts` +
  `with-mcp-resources-e2e.spec.ts` — alias-keyed remote surfacing +
  the adversarial alias-trust test (see that package's README).

@see [`docs/proposals/v2/blueprint/62-resources-harness.md`](../../docs/proposals/v2/blueprint/62-resources-harness.md)
@see [`docs/proposals/v2/blueprint/27-modular-built-ins.md`](../../docs/proposals/v2/blueprint/27-modular-built-ins.md)
