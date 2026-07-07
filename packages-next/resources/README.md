# @agentick/resources-next

`ResourcesHarness` — a **read-projection seam** over existing content, not
a store (ADR 62). A registry of `URI → resolver` bindings (plus
`uriTemplate → resolver`) and the subscribe / `list_changed` notifier.
The harness owns **no content**: a resolver reads from wherever the
content already lives (the sandbox fs, a document store, a computed
view); `read(uri)` routes to the matching resolver.

The MCP server trio splits readable context by control:

| Surface   | Controlled by | Primitive             |
| --------- | ------------- | --------------------- |
| tools     | the model     | `ToolsHarness`        |
| prompts   | the user      | `PromptsHarness`      |
| resources | the app       | **`ResourcesHarness`** |

Resources are the **application-controlled** slice — readable content the
app exposes and the model/client pull on demand.

Private workspace package. Bundled into the `agentick` metapackage; not
published independently.

## Purpose

The framework's core is *compilers → IR → model input*. A resource is not
a store and not RAG — it is a **content-addressable read namespace**
(`list` / `read` / `templates` / `subscribe` ≈ `readdir` / `cat` / `glob`
/ `watch`). Because agentick owns no resource content, this harness is
**thinner than `PromptsHarness`**: a registry of resolvers + a
change-notifier, front-end-agnostic, projected onto MCP `resources/*` by
the server harness exactly as prompts are projected onto `prompts/*`.

**Provider / consumer asymmetry.** This is the PROVIDER seam — agentick's
own resources projected OUT (agentick-as-MCP-server). Reading an
*external* server's resources is a `McpClientHarness` concern (Wave 2);
compose it with a wrapping resolver
(`register("proxy://…", () => client.readResource(uri))`), not by folding
external content into this registry.

## Quick start

```ts
import { ResourcesHarness } from "@agentick/resources-next";

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

const contents = await resources.read("db://users/42");   // runs the template resolver
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
- `subscribeListChanged(listener)` fires on register / unregister →
  MCP `notifications/resources/list_changed`.

## URI templates

`registerTemplate` compiles an RFC 6570-lite pattern:

| Expression | Matches                          |
| ---------- | -------------------------------- |
| `{name}`   | exactly one path segment (no `/`) |
| `{+name}`  | reserved expansion (incl. `/`)    |
| `{/name}`  | path expansion (incl. `/`)        |

Everything else is a regex-escaped literal, anchored end-to-end.
`read(uri)` prefers a fixed binding, then the first matching template.

## API

### `ResourcesHarness` (class)

`extends BaseHarness<"resources">`. Construct with
`(scopeId, journal, bus, inbox, options?)`. Options: `pageSize`
(default 100), `backend` (default `"memory"`).

### `withResources()` — `SessionExtension`

Wave 4a no-op (documented). Session surfacing — constructing a per-session
harness, wiring `bridges.resources` / `ctx.resource`, and the React
`<Resource>` front-end — is Wave 4b (`TODO(#237-4b)`).

### `runResourcesHarnessConformance(label, factory)`

The shared conformance suite. Runs register/list (+ pagination), read
fixed + templated, unknown-uri error, text + blob typing, subscribe →
notifyUpdated fan, and list_changed on mutation against any impl.

### `compileUriTemplate(t)` / `matchesTemplate(re, uri)`

The URI-template matcher, exported for reuse.

### `/testing`

`fakeResources()` — a real `ResourcesHarness` over an in-memory
substrate (preferred for consumer tests). `stubResources({ contents })`
— canned-answer double, no substrate round-trip.

## Protocol surface (`ResourcesHarnessProtocol`)

`id` · `ready` · `backend` · `close()` · `register` · `registerTemplate`
· `list` · `listTemplates` · `read` · `has` · `subscribe` ·
`subscribeListChanged` · `notifyUpdated`. Errors:
`ResourceNotFound` · `ResourceAlreadyRegistered` ·
`ResourceResolverFailed` · `ResourcesBackendError`.

## Status

Wave 4a (ADR 62 / #237) — the harness + conformance + spec wire types +
the MCP server projection + capability advertisement. Green.

## Roadmap & known gaps

- **Wave 4b (`TODO(#237-4b)`):** roots-from-sandbox, a sandbox-backed
  file resolver, the React `<Resource>` component / `ctx.resource`
  front-ends, `withMCP` session surfacing of resources.
- **Client-side external-resource consumption** landed in Wave 2
  (`McpClientHarness`); compose it via wrapping resolvers, not folded
  into this registry.
- **Filter scope.** The MCP projection's `filter` gates FIXED resources
  (list + read). Templated reads carry no fixed descriptor and bypass it.
- **Pagination** is offset-based with an opaque decimal cursor over a
  stable-sorted (by uri) snapshot.

## Verified by

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

@see [`docs/proposals/v2/blueprint/62-resources-harness.md`](../../docs/proposals/v2/blueprint/62-resources-harness.md)
@see [`docs/proposals/v2/blueprint/27-modular-built-ins.md`](../../docs/proposals/v2/blueprint/27-modular-built-ins.md)
