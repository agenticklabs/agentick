# @agentick/resources

**Readable content the application exposes and the model pulls on demand.** A resource is a `URI → resolver` binding, and this package is the registry of those bindings plus the change notifiers around them. It owns **no content**: a resolver reads from wherever the content already lives — the sandbox filesystem, a document store, a computed view — and `read(uri)` routes to whichever binding matches.

That "application-controlled" framing is the whole point of a third surface. Context the model chooses to invoke is a tool; context the user chooses is a prompt; context the _app_ publishes and either side pulls when it needs it is a resource:

| Surface   | Chosen by       | Package                         |
| --------- | --------------- | ------------------------------- |
| tools     | the model       | [@agentick/tool](../tool)       |
| prompts   | the user        | [@agentick/prompts](../prompts) |
| resources | the application | **this one**                    |

## Install

```bash
npm install @agentick/resources
```

Subpaths: `/react` (`<Resource>` and its bridge hook), `/client` (browser-side read handle), `/testing` (doubles + two conformance suites).

## Quick start

Declare content in the agent tree and let the model pull it:

```tsx
import { withResources } from "@agentick/resources";
import { Resource } from "@agentick/resources/react";

function Agent() {
  return (
    <>
      <Resource uri="config://app" name="App config" content={JSON.stringify(config)} />
      <Resource uriTemplate="db://users/{id}">{(uri) => loadUser(userIdOf(uri))}</Resource>
    </>
  );
}

const app = createApp(<Agent />, { model, extensions: [withResources()] });
```

`withResources()` registers two model tools — `resource_list` and `resource_read` — so the model can enumerate the catalog and read one uri with no further wiring. The same registry is reachable from every other side of the app: `session.resources` in your own code, `ctx.resource` inside a tool handler.

```ts
const contents = await session.resources.read("db://users/42");
const { resources, nextCursor } = await session.resources.list();
```

> [!NOTE]
> `withResources()` does not construct anything. The app builds one instance per session before extensions install, then wires that single instance into `ctx.resource`, `bridges.resources`, and `session.resources` — so every front-end below writes into the same registry, and a second instance would collide on the inbox address. Pass `registerModelTools: false` for the substrate without the model-facing tools (resources published only over an MCP projection, or read exclusively from your own code).

## Three front-ends, one registry

An adopter cannot tell which binding arrived first, and nothing about a resource depends on how it was declared:

| Front-end                     | Where it belongs          |
| ----------------------------- | ------------------------- |
| `<Resource>` (`/react`)       | inside a JSX agent tree   |
| `session.resources.read(uri)` | your own server-side code |
| `ctx.resource.read(uri)`      | tool handlers             |

### `<Resource>` — declared in the tree

Reads like `<Tool>`: it registers on mount and unregisters on unmount.

```tsx
// Static content — a string or ResourceContents.
<Resource uri="config://app" name="App config" content={JSON.stringify(cfg)} />

// A resolver prop; may be async.
<Resource uri="db://count" resolver={async () => `${await count()}`} />

// Children as the resolver.
<Resource uri="file://readme" mimeType="text/markdown">{() => readme}</Resource>

// A template — the resolver receives the CONCRETE uri that matched.
<Resource uriTemplate="file://{path}">{(uri) => readFile(uri)}</Resource>
```

Precedence when more than one content source is given: `resolver` prop, then a function child, then `content`. `useResourceBridge()` is exported for building your own components on the same bridge.

### Registering directly

```ts
resources.register(
  "config://app.json",
  () => [{ uri: "config://app.json", mimeType: "application/json", text: readConfig() }],
  { name: "App config", description: "the current app configuration" },
);

// A template binding — the resolver parses its own parameters out of the concrete uri.
resources.registerTemplate("db://users/{id}", (uri) => [
  { uri, mimeType: "application/json", text: loadUser(userIdOf(uri)) },
]);
```

Both return an `Unsubscribe`, and both take a function argument, which is what keeps them plain in-process methods rather than wire-addressable commands. Registering a uri twice throws `ResourceAlreadyRegistered` — unlike the loader path below, which upserts.

## The resolver gets the caller's ctx

A resolver's optional second argument is the ctx of the operation that invoked the read — the trunk (`sessionId`, `opId`, identity) plus the `log` / `trace` / `metrics` / `run` facets. That is what makes identity-scoped content possible:

```ts
resources.register("crm://me", (uri, ctx) => [
  { uri, mimeType: "application/json", text: loadProfile(ctx?.user) },
]);
```

Optional in the signature so a resolver stays trivially testable; always threaded by the read path in practice.

**Which read path you take decides what identity arrives.** `read` / `list` / `listTemplates` are declared commands, so each has an Effect twin under `fx` — the same command, un-run:

```ts
// Inside an enclosing operation: composed in ITS fiber tree.
Effect.gen(function* () {
  const contents = yield* resources.fx.read({ uri });
  // The read parents under the enclosing op, and the resolver's ctx carries the
  // caller's identity plus that op as its parent.
});

await resources.read(uri);
// A fresh root fiber: no ambient trunk to inherit, so the resolver sees only this
// registry's own scope. Correct for a top-level call from your own code.
```

The MCP server's `resources/read` projection is the reference consumer of `fx`: it runs the read on the crossing operation's runtime, which is how a wire caller's authenticated identity reaches an identity-scoped resolver.

## URI templates and aliases

`registerTemplate` compiles an RFC 6570-lite pattern, anchored end to end, with everything outside an expression treated as a regex-escaped literal:

| Expression | Matches                           |
| ---------- | --------------------------------- |
| `{name}`   | exactly one path segment (no `/`) |
| `{+name}`  | reserved expansion, `/` included  |
| `{/name}`  | path expansion, `/` included      |

`compileUriTemplate` / `matchesTemplate` are exported for reuse. The matcher answers only yes or no — the resolver receives the raw concrete uri and parses its own parameters, so no variable bag is ever built.

**`read(uri)` resolution order is fixed binding, then declared alias, then the first matching template.** An alias sits above a template because an alias is an exact declared name for one resource, while a template is a pattern that might match it incidentally.

```ts
resources.register("mcp://docs/config://app", resolver, {
  name: "Config",
  aliases: ["config://app"], // the uri the upstream server documents
});
```

Aliases exist because a uri is not a name: it is documented, in server instructions and in prose the model reads, so rewriting it makes the model's most reliable source of truth wrong. An alias resolves but is **not** a catalog entry — `list()` reports one row per registration and `has()` answers only for registered uris. Two registrations claiming one alias is an error, not a race: the read rejects with a `ResourceAliasAmbiguous` carrying both candidates — branchable by tag, not just readable as a message — rather than handing back whichever registered first, and un-registering one claimant makes the alias unambiguous again.

## Change streams

Two notifiers, kept apart because the events mean different things:

```ts
resources.subscribe("config://app.json", () => refetch()); // this uri's content changed
resources.subscribeAll(() => recomputeCatalog()); // the set of resources changed

resources.notifyUpdated("config://app.json"); // a provider signals its backing content moved
```

`subscribe` fires only for the matching uri. `subscribeAll` fires on register, unregister, and reload. Over an MCP projection they become `notifications/resources/updated` and `notifications/resources/list_changed`.

## Model tools

`resource_list` enumerates the catalog — uri, name, description, mimeType — paginated by an opaque cursor, with templates folded into the first page. `resource_read` resolves one uri and returns first-class `resource` content blocks, so text and binary both round-trip. A failed read surfaces the typed error as a failed dispatch rather than a silent empty result, and with no registry mounted at all both degrade honestly instead of throwing.

## The catalog reaches the model without being read

`<Resource>` renders no host intrinsic. Instead the compiler folds the registry into a compact catalog section during the render pass — uris, names, and descriptions, never content, because resources are pulled on demand. It reads the bridge structurally, contributes nothing when the registry is empty, and a `<Project projectionKey="resources">` suppresses it entirely.

## Mounting stores as a resource tree

A keyed store — anything with `get` and `listChildren` — can be exposed as a browsable tree and have its addresses rewritten at a single boundary on the way to the model. Three composable functions over the resolver primitive, none a harness method:

| Function                                      | Does                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `storeResolver(store, projection?, options?)` | a `{ get, listChildren }` store → a resolver, optionally through a projection |
| `mount(resolver, meta?)`                      | a resolver at a prefix, with a name + description                             |
| `createTree(tree)`                            | many mounts → one resolver; `tree` is static or `(ctx) => tree`               |

A projection is yours to write — this package ships the seam, not a library of scopes. `userScope` below is adopter code: a `{ toInternal, toHome }` pair closing over whatever the ctx says about the caller.

```ts
const userScope = (owner: string): MountProjection => ({
  toInternal: (home) => `users/${owner}/${home}`,
  toHome: (key) =>
    key.startsWith(`users/${owner}/`) ? key.slice(`users/${owner}/`.length) : undefined,
});

const tree = createTree((ctx) => ({
  notes: mount(storeResolver(collection, userScope(ownerOf(ctx))), {
    name: "Notes",
    description: "Personal notes and preferences",
  }),
  clients: mount(storeResolver(collection, tenantScope(ownerOf(ctx)), { limit: 50 }), {
    name: "Clients",
    description: "What the business knows about each client",
  }),
  global: mount(
    storeResolver(collection), // no projection — nothing to strip
    { name: "Platform", description: "Curated platform knowledge, read-only" },
  ),
}));

registerTree(session.resources, "knowledge://", tree);
```

The model reads `knowledge://` and gets a listing of those directories, each with its description; reads `knowledge://notes/afman.md` and gets a document; reads `knowledge://clients` and gets that subtree. It never sees the internal keys the store is organized under — that is the projection's job.

`MountStore` is content-shaped (its `get` returns rendered `ResourceContents`) and browsable (`listChildren` returns `Child` entries) — distinct from the durable declaration `ResourceStore` below. `storeResolver` decides leaf vs directory **structurally**: `get` returns content for a leaf and `undefined` for a directory, at which point it lists children. No extension sniffing — what is a leaf is the store's answer, not the router's guess. Because a store holds no directory rows, an empty prefix and a nonexistent one read alike; a store that needs to tell them apart needs a tri-state `listChildren`, which this port does not have.

### The projection is one boundary

A `MountProjection` is a stateless `{ toInternal, toHome }` pair. `toHome` is the **only** place a store key becomes a model-facing **address**, and it runs in exactly one spot: `storeResolver`'s outbound pass. Every address is minted from it — the requested path itself, each child, and a leaf's own uri — so a path that does not project back is not-found on a direct read, not just absent from a listing. Fail-closed by construction: an address is emitted only if it maps back, so an id-bearing key cannot leak and a dead link cannot form. A path only reaches `toInternal` in canonical form (no `.`, `..`, or empty segment; a trailing slash is dropped), which is what keeps `tenants/42/../43` from round-tripping through a normalizing store. Omitting the projection serves the store's keys verbatim, which is what `global/`, skills, and prompts want.

The boundary governs addresses and nothing else. A leaf's **content** passes through untouched — the framework cannot scrub a body it does not know the format of, so a document whose frontmatter renders an internal id leaks it. Emitting a safe body is the store's job (an adapter's metadata allowlist), not this seam's.

### Paging

`Page.cursor` is model-facing: `storeResolver` embeds it verbatim in the listing's `nextPage` address, and the model reads that address back. So **a cursor must carry no isolation id** — the relative child name is the canonical choice. A store keying its cursor on an internal record id publishes that id, and no projection is positioned to catch it. `storeResolver(store, projection, { limit })` requests a page size; omitted, the store's own default applies.

### Routing and the root

`createTree` routes an incoming path by **longest-prefix** match (segment-aware — `clients/jo` is not under `clients/johnson/`) and delegates to that mount's resolver; a path matching no mount is `ResourceNotFound`, the same typed error a missing resource gets. Reading the empty path merges a root listing carrying each mount's `meta.description` — the same one line that feeds the `resource_list` catalog and the system-prompt workspace legend, generated from the tree so it cannot drift. `registerTree` is the convenience that wires the root `register` plus the `{+path}` descent template in one call.

The computed form `(ctx) => tree` is invoked **on every read**, and deliberately not memoized: `ctx.sessionId` is optional, so a cache keyed on it collapses every ctx that lacks one into a single entry and serves one principal's tree to the next. Building a handful of mount objects is cheap; an expensive attribution or membership lookup inside `tree` is **yours to cache**, in your attribution port, which is the only layer holding a principal identity it can trust.

## Durable backing

The registry's state lives in three structures, and the split is the interesting part:

| Structure   | Holds                                    | Fed by                                        |
| ----------- | ---------------------------------------- | --------------------------------------------- |
| the store   | serializable declaration records         | loaders only                                  |
| the catalog | the declaration slice `snapshot()` reads | loaders (mirrored) + registrations (overlaid) |
| the sidecar | the resolver function                    | both                                          |

Two source classes coexist. **Loader-sourced** resources come from a `ResourceLoader` — an array, a module, your own database adapter. Each loaded item carries a declaration, which goes to the store, and a resolver, which goes to the sidecar. **Registration-sourced** resources (`register`, `registerTemplate`, `<Resource>`) never touch the store; they re-mount from the tree.

```ts
import { fromArray } from "@agentick/resources";

resources.setLoaders([
  fromArray([
    {
      declaration: { uri: "db://doc", kind: "fixed", meta: { name: "Doc" } },
      resolver: () => [{ uri: "db://doc", mimeType: "text/plain", text: "…" }],
    },
  ]),
]);

await resources.reload(); // → { added: ["db://doc"], updated: [] }
```

`reload()` upserts every loader's items into store, catalog, and sidecar, and fires `list_changed` once. `read()` also does lookup-on-miss: an unresolved uri asks each loader for that exact key and re-attaches the resolver on a hit.

> [!IMPORTANT]
> Store-backed is not snapshot-backed. There is no `exportSnapshot` / `importSnapshot` here, on purpose — a resolver is a live function and does not serialize. `hydrate()` mirrors the store's declarations back into the catalog so a restored resource is still _listed_, but `read()` throws `ResourceNotFound` until the loaders re-run and re-attach a resolver, exactly as a restored prompt has no content until it is re-registered.

The store is one collection discriminated by `kind`: fixed resources key by `uri`, templates by `uriTemplate`. A durable adapter — Postgres, a filesystem source — implements the same `ResourceStore` port and proves itself against `runResourceStoreConformance`. There is deliberately no URL loader: a JSON source cannot carry a resolver function, and a resource without a resolver can never be read.

## Reading resources in the browser

Importing `@agentick/resources/client` self-assembles `client.session(id).resources`:

```ts
import "@agentick/resources/client"; // bundled by @agentick/client

const resources = client.session(id).resources;

resources.list(); // sync snapshot of descriptors
resources.get("file:///a.txt"); // sync, by uri
await resources.listTemplates(); // RPC
await resources.read("file:///a.txt"); // RPC
await resources.refresh(); // force a re-poll
resources.subscribe(() => rerender());
```

The descriptor snapshot seeds itself with an eager poll and fires subscribers when it lands, so binding `list()` plus `subscribe()` is the entire read path — there is nothing to await at boot. A first poll that fails settles empty rather than half-filled; `refresh()` or the next mutation recovers it. `read` and `listTemplates` are pure RPC with no local mirror.

One more `resources/*` row is reachable without any handle code: `await resources.commands()` returns the declared verbs with their exposure — the discovery door every harness serves, described in [@agentick/gateway](../gateway#discovery--two-doors).

## API

### `@agentick/resources`

| Export                                               | Purpose                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `ResourcesHarness`                                   | The implementation, for direct construction                  |
| `withResources(options?)`                            | Session extension — registers the model tools                |
| `storeResolver` / `mount` / `createTree`             | Compose a `MountStore` into a browsable, projected resolver  |
| `registerTree(resources, scheme, tree, meta?)`       | Wire a tree's root + `{+path}` descent template in one call  |
| `MountStore` / `MountProjection` / `Mount` (types)   | The store port, the address seam, the resolver-with-meta     |
| `MountListQuery` / `MountOptions` (types)            | The `listChildren` query, and the mount's page-size request  |
| `InMemoryResourceStore` / `matchesResourceQuery`     | The bundled default store and its query matcher              |
| `fromArray` / `fromModule`                           | Loader factories for the durable source                      |
| `compileUriTemplate` / `matchesTemplate`             | The URI-template matcher                                     |
| `buildResourcesTools(sessionId)`                     | The `resource_*` registrations + handlers, for custom wiring |
| `RESOURCE_LIST` / `RESOURCE_READ` / `EXTENSION_NAME` | Name constants                                               |
| `ResourceLoader` / `ResourceLoaderItem` (types)      | The loader contract                                          |

### The instance surface

```ts
interface Resources {
  readonly id: string;
  readonly ready: Promise<void>;
  readonly backend: string;
  register(uri: string, resolver: ResourceResolver, meta?: ResourceMeta): Unsubscribe;
  registerTemplate(t: string, resolver: TemplateResolver, meta?: ResourceTemplateMeta): Unsubscribe;
  has(uri: string): boolean;
  read(uri: string): Promise<readonly ResourceContents[]>;
  list(cursor?: string): Promise<ResourcesListResult>;
  listTemplates(cursor?: string): Promise<ResourcesListTemplatesResult>;
  subscribe(uri: string, listener: () => void): Unsubscribe;
  subscribeAll(listener: () => void): Unsubscribe;
  notifyUpdated(uri: string): void;
  close(): Promise<void>;
}
```

Construction: `new ResourcesHarness(scopeId, journal, bus, inbox, options?)`, where options are `pageSize` (default 100), `backend` (default `"memory"`), `store`, `loaders`, plus everything in `BaseHarnessOptions`. Beyond the protocol the class adds `snapshot()` (a synchronous unpaginated catalog, sorted — the sync read the render pass folds), `fx`, `setLoaders(loaders)`, `reload()`, and `hydrate()`.

Errors: `ResourceNotFound`, `ResourceAlreadyRegistered`, `ResourceResolverFailed`, `ResourcesBackendError`, `ResourceAliasAmbiguous`. Pagination is offset-based behind an opaque cursor over a uri-sorted snapshot.

### `@agentick/resources/react`

| Export                | Purpose                                          |
| --------------------- | ------------------------------------------------ |
| `<Resource>`          | Declare a fixed or templated binding in the tree |
| `useResourceBridge()` | The bridge, for custom components                |

### `@agentick/resources/client`

| Export                               | Purpose                               |
| ------------------------------------ | ------------------------------------- |
| `session.resources`                  | Registered on import: the read handle |
| `resourcesHandle(client, sessionId)` | The free factory the slot registers   |

### `@agentick/resources/testing`

| Export                                           | Purpose                                                        |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `fakeResources(options?)`                        | A real instance on an in-memory substrate — the default choice |
| `stubResources({ contents })`                    | Canned-answer double, no substrate round-trip                  |
| `runResourcesHarnessConformance(...)`            | Certify an alternate registry implementation                   |
| `runResourceStoreConformance(...)`               | Certify a durable store adapter                                |
| `fakeMountStore({ leaves, children, cursors? })` | A working in-memory `MountStore` for mount tests               |
| `runResourceMountConformance(...)`               | Certify a `MountStore` through the mount machinery             |

## Patterns

**Serving resources over MCP.** [@agentick/mcp](../mcp)'s server projection maps this registry onto `resources/*` without translation — list, templates, read, subscribe, unsubscribe, and both notifications — and advertises `subscribe` and `listChanged`:

```ts
new McpServerHarness(id, journal, bus, inbox, {
  name: "my-server",
  transports: [httpTransport()],
  resources: { use: resources, filter: (r, ctx) => isVisible(r, ctx) },
});
```

**Reading another server's resources.** That is the client direction, and it composes rather than folding external content into this registry. [@agentick/mcp](../mcp) proxy-registers a connected server's resources under `mcp://<alias>/<uri>`, keyed on the alias _you_ assigned rather than any name the server reports about itself, with the original uri kept readable as an alias. Hand-rolled, the same shape is one line: `register("proxy://…", () => client.readResource(uri))`.

**Files as resources.** [@agentick/sandbox](../sandbox) ships ready-made `file://{+path}` resolvers on its opt-in MCP subpath, so a filesystem boundary declared as a root is also readable as a resource:

```ts
import { sandboxFileResolver, fsFileResolver, registerFileResolver } from "@agentick/sandbox/mcp";

registerFileResolver(resources, sandboxFileResolver(sandbox)); // ACL-gated, text
registerFileResolver(resources, fsFileResolver("/srv/data")); // rooted + containment-checked
```

The resolver lives with the sandbox because it depends on the sandbox handle. This package stays backend-agnostic: it owns the seam, not the storage.

**Shapes.** [@agentick/spec](../spec) owns `ResourceResolver`, `TemplateResolver`, `ResourceMeta`, the descriptor and contents types, `ResourceDeclarationRecord`, the `ResourceStore` port, and the error classes.

## Roadmap & known gaps

- **`withResources()` cannot pass a store or loaders.** The app owns the single construction site, and its options do not forward them yet, so a durable source is injected at the constructor or through `setLoaders(...)` followed by `reload()`.
- **`hydrate()` is not wired into session resume.** It works and is tested, but nothing calls it on restore — reattaching a durable catalog is an explicit call today.
- **The MCP `filter` gates fixed resources only.** A templated read carries no fixed descriptor, so it bypasses the filter.
- **No delta channel for the client handle.** The browser snapshot is poll-seeded; a live mirror waits on the generic client channel-consumer work, so `list()` is only as fresh as the last poll or mutation.
- **Templates only appear on the first page of `resource_list`.** They have their own cursor space; full template pagination means calling `listTemplates` directly.
- **A mount projects addresses, not content.** A leaf body that names an internal id still names it; scrubbing one belongs to the store or its adapter, which is the only layer that knows the format.
- **A mount cannot distinguish an empty directory from a missing one.** A `MountStore` holds no directory rows, so both list as empty. Telling them apart needs a tri-state `listChildren`, which is not built.

## Verified by

- `src/__tests__/conformance.spec.ts` runs the exported registry suite (`src/conformance.ts`) against this implementation: register / list / `has` with descriptor metadata, `name` defaulting to the uri, pagination with no overlap or omission, fixed and templated reads, `ResourceNotFound` for an unknown uri, text and blob contents round-tripping, `subscribe` firing for the matching uri only, and `list_changed` on register and unregister.
- `src/__tests__/harness.spec.ts` — duplicate fixed and template registration errors, `backend` default and override, template descriptors, fixed-over-template read precedence, `ResourceResolverFailed` wrapping both throwing and rejecting resolvers, declared-command journaling (a read emits request and terminal envelopes on the resources surface), and the URI-template match semantics including regex-metacharacter escaping.
- `src/__tests__/ctx-spine.spec.ts` — the invoking op's ctx reaching both a fixed and a template resolver, `fx.read` inheriting the ambient trunk (identity plus the enclosing op as parent) where the Promise facade deliberately does not, and `fx.list` / `fx.listTemplates` serving the same pages as their positional twins.
- `src/__tests__/store-backing.spec.ts` — a loader feeding the store with a declaration and the sidecar with a resolver that never reaches the store, registrations staying out of the store entirely, `snapshot()` combining both sources, lookup-on-miss, `hydrate()` surfacing declarations while `read()` waits for the resolver, and the absence of any snapshot capability. Plus `runResourceStoreConformance` against `InMemoryResourceStore`.
- `src/__tests__/tools.spec.ts` — `resource_list` enumerating fixed resources and templates, `resource_read` returning first-class resource blocks, a typed error surfaced rather than swallowed, honest degradation with no registry present, and `withResources` registering both tools by default and suppressing them under `registerModelTools: false`.
- `src/react/__tests__/resource.spec.tsx` — `<Resource>` registering and reading through all three content sources, a template resolving the concrete matched uri, unmount unregistering, and the catalog projection folding a tagged section, contributing nothing when empty, and yielding to a `<Project>` override.
- `src/client/__tests__/resources-handle.spec.ts` and `session-resources.spec.ts` — the eager seed notifying subscribers when it lands, a failed seed settling empty and recovering on `refresh()`, `list()` / `get()` reflecting the poll, `read` and `listTemplates` as pure RPC with no follow-up list, the zero-argument `subscribe` contract, and importing `/client` self-assembling `session.resources` over a transport.
- `src/__tests__/mount.spec.ts` — the mount machinery through a real `ResourcesHarness`: `registerTree` wiring the root plus `{+path}` descent, a leaf and a directory reading back under home addresses, and no internal key surviving into the read. Then the address boundary directly: a parent traversal, a `.` segment, and an empty leading or interior segment each rejected as `ResourceNotFound` before the store is asked for a key; a trailing slash naming the same directory rather than an empty one; an unroutable path failing typed rather than as a bare crash; and a mount's `limit` plus a listing's own `nextPage` cursor both arriving at `listChildren` as a query. It also runs `runResourceMountConformance` (`src/mount-conformance.ts`) against `fakeMountStore`: get / list round-trip with a child's whole `meta` carried, the fail-closed drop of a non-projecting child **and** not-found on reading that child directly, id-elision over the whole serialized response including a `nextPage` built from a real cursor, longest-prefix routing with segment-aware boundary correctness, a computed tree rebuilt per read so no ctx serves another's tree, and the root merge listing each mount's description.
- Alias behavior is covered where its motivating consumer lives, in [@agentick/mcp](../mcp): a documented upstream uri staying readable without doubling the catalog, `has` answering for registered uris only, two claimants refusing to guess (asserted on the `ResourceAliasAmbiguous` tag and its `candidates`, not the message), an alias becoming unambiguous when one claimant goes away, and an adversarial test that an impostor's self-reported name cannot shadow another server's namespace.
- [@agentick/app](../app) proves the single construction site: `installer.resources` is `session.resources`, and `resource_read` reaches that same instance through `ctx.resource` over a real dispatch round-trip.
