# Resources

**Tools are verbs the model calls; resources are nouns the model reads.**

A resource is application-controlled content addressed by a stable URI — a config
blob, a file, a document, a computed view — that the model (or your own code, or a
connected MCP peer) **pulls on demand**. Resources are not sent to the model every
tick. They surface as a catalog of _what's available_; the content arrives only
when something reads a specific URI.

By the end of this guide you'll expose content as resources with `<Resource>`, let
the model discover and read them with the built-in tools, read them from your own
code, and understand exactly when a resource is the right tool versus a plain
`<Section>` or a read `<Tool>`.

## Pull vs. push — the mental model

Agentick already gives you two _push_ primitives. `<Section>`, `<Message>`, and
`<Timeline>` render content **into** the model's context on every tick — the model
sees them whether or not it needs them, and they cost tokens each turn.

Resources are the _pull_ primitive. You register a `URI → resolver` binding; the
model sees only a compact **catalog** (uris, names, descriptions — never the
content), and it reads a URI when it decides the content is relevant. Nothing is
inlined until a read happens.

| | Push (`<Section>` / `<Message>`) | Pull (`<Resource>`) |
| ------------------ | -------------------------------------- | ----------------------------------------- |
| Reaches the model | Inlined every tick | Only when read by URI |
| Token cost | Every turn | Catalog entry only, until read |
| Addressed by | Position in the tree | Stable URI |
| Good for | Small, always-relevant context | Large / numerous / occasionally-needed |

The one-liner again: **tools are verbs, resources are nouns.** A tool _does_
something (and the model chooses to call it). A resource _is_ something (and the
model chooses to read it).

## When to use a resource — and when not

Reach for a resource when content is:

- **Large or numerous** — inlining it every tick would blow the context budget.
- **Not needed every turn** — reference material the model consults occasionally.
- **Worth a discoverable catalog** — the model benefits from seeing _what exists_
  before deciding what to read.
- **Addressed by a stable reference** — a URI the model, your code, and a remote
  peer can all name.
- **Heterogeneously sourced** — files, store rows, and computed views behind one
  read interface.

**Do NOT use a resource when a simpler primitive fits:**

- A small, always-relevant fact belongs in a `<Section>` (push) — the catalog +
  read round-trip is pure overhead.
- Content the model should _act on_, not read, is a `<Tool>`. If the model needs
  to _search_ or _transform_, that's a verb.
- One-shot content you already have in hand — just render it. Resources earn their
  keep through addressability and on-demand reads, not as a wrapper around a
  string you were going to inline anyway.

Resources are not RAG. There is no retrieval, ranking, or embedding here — that's
an application concern you build _on top_. A resource is a content-addressable read
namespace: `list` / `read` / `templates` / `subscribe` map to `readdir` / `cat` /
`glob` / `watch`.

## The seam owns no content

The resources harness is a **registry of resolvers plus a change-notifier** — not a
store. You bind a URI (or a URI template) to a resolver function that reads from
wherever the content already lives: the sandbox filesystem, a database, a computed
view. `read(uri)` routes to the matching resolver and returns its content. The
harness never duplicates or caches the underlying data.

This is why resources is _thinner_ than most primitives: it holds bindings and fans
out change notifications, and that's it.

## Declaring resources with `<Resource>`

`<Resource>` is the read-side analogue of `<Tool>`. Where `<Tool>` registers a
callable the model _invokes_, `<Resource>` registers readable content the model
_pulls_. It registers its binding on mount and unregisters on unmount — it renders
no host output of its own.

There are three ways to supply content; pick the cleanest for the case.

```tsx
import { Resource } from "@agentick/resources-next/react";

// 1. Static content — a string or a ResourceContents object:
<Resource uri="config://app" name="App config" mimeType="application/json"
          content={JSON.stringify(appConfig)} />

// 2. A resolver prop — lazy, may be async:
<Resource uri="db://users/count" name="User count"
          resolver={async () => `${await db.users.count()}`} />

// 3. Children-as-resolver — reads most like <Tool>:
<Resource uri="file://readme" name="README" mimeType="text/markdown">
  {() => readme}
</Resource>
```

A resolver may return a bare `string` (wrapped as a single text-contents entry for
the read URI, carrying the declared `mimeType`), a single `ResourceContents`, or an
array. The `content` prop accepts the same shapes.

When more than one source is supplied, precedence is: `resolver` prop > function
child > `content`.

### Templated resources

Use `uriTemplate` when a single binding should serve a family of URIs. The resolver
receives the **concrete matched URI**:

```tsx
// Every db://users/<id> read hits this one resolver:
<Resource uriTemplate="db://users/{id}" name="User record" mimeType="application/json">
  {(uri) => loadUser(parseId(uri))}
</Resource>
```

Template syntax is an RFC 6570-lite subset:

| Expression | Matches |
| ---------- | --------------------------------- |
| `{name}` | exactly one path segment (no `/`) |
| `{+name}` | reserved expansion (includes `/`) |
| `{/name}` | path expansion (includes `/`) |

`read(uri)` prefers an exact fixed binding, then the first matching template.

### A minimal end-to-end example

```tsx
import { createApp } from "@agentick/app-next/react";
import { openai } from "@agentick/model-openai-next";
import { withResources } from "@agentick/resources-next";
import { Resource } from "@agentick/resources-next/react";
import { System, Timeline } from "agentick";

function Agent() {
  return (
    <>
      <System>You are a support agent. Read the release notes before answering.</System>
      <Resource uri="doc://release-notes" name="Release notes" mimeType="text/markdown">
        {() => fs.readFileSync("./RELEASE_NOTES.md", "utf8")}
      </Resource>
      <Timeline />
    </>
  );
}

const app = await createApp(<Agent />, {
  model: openai("gpt-4o"),
  extensions: [withResources()],
});
```

`withResources()` gives the model the two tools it needs to use the catalog (next
section). The `<Resource>` contributes one catalog entry; its content is read only
if the model calls `resource_read("doc://release-notes")`.

## The catalog — availability, not content

How does the model _know_ a resource exists? Through the **catalog**. The reconciler
runs a default surfacing layer (ADR 63) that folds the resources registry into a
compact section: URIs, names, descriptions, and mime types — **not content**. That
section is a real, inspectable node in the compiled tree (devtools shows it like any
other), and it costs only the metadata, not the payload.

- Absent any registered resources, the catalog contributes nothing.
- Override or suppress it with `<Project projectionKey="resources">` from
  `@agentick/reconciler-react-next` if you want to render availability yourself.

This is the crux of pull semantics: the model spends tokens on _knowing what's
readable_, and spends the content budget only on what it actually reads.

## Letting the model read — `withResources()`

Installing `withResources()` auto-registers two model-facing tools:

| Tool | What it does |
| --------------- | ---------------------------------------------------------------- |
| `resource_list` | Enumerate available resources + templates (paginated via cursor) |
| `resource_read` | Read one URI; returns first-class `resource` content blocks |

`resource_read` returns the content as `{ type: "resource", resource: ... }` blocks
(text or binary round-trip), not flattened text. A failed read surfaces the
harness's typed error (`ResourceNotFound` / `ResourceResolverFailed`) rather than a
silent empty result — honest failures.

Opt out of the model surface when resources exist only for your own code or only for
an MCP-server projection:

```tsx
// Substrate without the model tools — read only via ctx.resource /
// session.resources, or expose over MCP.
extensions: [withResources({ registerModelTools: false })];
```

## Reading resources from your own code

The same registry is reachable three equal ways — an adopter can't tell which
front-end registered a binding:

| Front-end | Where |
| ------------------------------- | -------------------------------- |
| `<Resource>` (`/react` subpath) | inside a JSX agent tree |
| `session.resources.read(uri)` | adopter / server-side code |
| `ctx.resource.read(uri)` | inside a tool handler (like `ctx.tasks`) |

```ts
// From adopter code — no tool ctx needed:
const contents = await session.resources.read("doc://release-notes");
const { resources, nextCursor } = await session.resources.list();
const exists = session.resources.has("doc://release-notes");
```

```ts
// From inside a tool handler:
const AnalyzeTool = createTool({
  name: "analyze_config",
  description: "Analyze the current app config",
  handler: async (_input, { ctx }) => {
    const [cfg] = await ctx.resource!.read("config://app");
    return [{ type: "text", text: summarize(cfg) }];
  },
});
```

You can also register bindings imperatively (no JSX) — the front-end-agnostic seam:

```ts
const unregister = session.resources.register(
  "config://app",
  () => [{ uri: "config://app", mimeType: "application/json", text: readConfig() }],
  { name: "App config", description: "current app configuration" },
);
```

## File resources (sandbox-backed)

A ready-made `file://` resolver ships from the sandbox package's opt-in `/mcp`
subpath, so a filesystem boundary you declare as an MCP **root** is also _readable_
as a resource. (This is the "roots + resources are both projections of the sandbox"
story — see [MCP: connecting to servers](/docs/v2/mcp) for roots.)

```ts
import {
  sandboxFileResolver,
  fsFileResolver,
  registerFileResolver,
} from "@agentick/sandbox-next/mcp";

// Read through a sandbox — ACL-gated, provider-backed (text, per the handle contract):
registerFileResolver(session.resources, sandboxFileResolver(sandbox));

// …or straight off the local filesystem, rooted + containment-checked (no sandbox):
registerFileResolver(session.resources, fsFileResolver("/srv/data"));
```

`registerFileResolver` binds under the canonical `file://{+path}` template (reserved
expansion so full paths match). The `fs` backend reads text as UTF-8 and non-text
losslessly as base64; the sandbox backend is text-only. The resolver lives _with_
the sandbox because it depends on the sandbox handle — resources itself stays
content-agnostic.

## Change streams

Two distinct notifier streams, kept separate because the events mean different
things:

```ts
// Content of a specific URI changed — fan to per-URI subscribers.
session.resources.notifyUpdated("config://app");
const unsub = session.resources.subscribe("config://app", () => refetch());

// Registry topology changed (a resource was added / removed).
const unsub2 = session.resources.subscribeListChanged(() => rebuildCatalog());
```

When projected over MCP these become `notifications/resources/updated` and
`notifications/resources/list_changed` respectively — see
[Exposing an MCP server](/docs/v2/mcp-server).

## When NOT to use this — gotchas

- **Don't wrap a string you'd inline anyway.** If content is small and always
  relevant, a `<Section>` is simpler and the catalog + read round-trip is wasted
  ceremony.
- **The catalog is metadata, not content.** The model must _decide_ to read. If you
  need content guaranteed in context every turn, that's push, not pull.
- **Resources is not a cache or a store.** It holds resolver bindings; the resolver
  re-runs on every `read`. Cache inside your resolver if reads are expensive.
- **Templated reads bypass the MCP-projection `filter`.** A per-connection visibility
  filter gates _fixed_ resources (which carry a descriptor); a templated read
  resolves without a fixed descriptor, so don't rely on `filter` for template
  access control — gate inside the resolver.
- **`bridges.resources` is optional at the general-bridges layer** (stub mounts may
  omit it), which is why `ctx.resource` is written `ctx.resource!` in handlers. On a
  production session constructed by the app harness it is always present.

## See also

- [MCP: connecting to servers](/docs/v2/mcp) — surfacing a remote server's resources as
  `mcp://<alias>/…`, and roots.
- [Exposing an MCP server](/docs/v2/mcp-server) — projecting your resources over the wire.
- [Tools](/docs/tools) — the verb primitive (contrast with resources, the noun).
- [Sandbox](/docs/sandbox) — the filesystem primitive file-resources read through.
- [`@agentick/resources-next` README](https://github.com/agenticklabs/agentick/blob/feat/v2/packages-next/resources/README.md) — the package spec and full protocol surface.
- ADRs: [62 — resources as a read-projection seam](https://github.com/agenticklabs/agentick/blob/feat/v2/docs/proposals/v2/blueprint/62-resources-harness.md), [63 — compiler surfacing](https://github.com/agenticklabs/agentick/blob/feat/v2/docs/proposals/v2/blueprint/63-compiler-surfacing.md).
