# @agentick/tool

Author a tool once, run it anywhere.

`createTool()` takes a name, a description, a schema, and a handler, and returns a registration bundle — a wire-ready declaration plus the handler and validator that back it. The bundle drops into an Agentick session, into an MCP server projection, or into any executor that speaks the same shapes. This package depends only on `@agentick/spec`: no compiler, no React, no runtime.

## Install

```bash
npm install @agentick/tool zod
```

Any [Standard Schema](https://standardschema.dev) library works — Zod, Valibot, ArkType, Effect Schema — or raw JSON Schema with no dependency at all.

## Quick start

```ts
import { createTool } from "@agentick/tool";
import { z } from "zod";

export const getWeather = createTool({
  name: "get_weather",
  description: "Look up the current weather for a city.",
  inputSchema: z.object({
    city: z.string().describe("City name, e.g. 'Austin'"),
    unit: z.enum(["C", "F"]).default("C"),
  }),
  handler: async ({ city, unit }) => {
    const res = await fetch(`https://example.com/weather?city=${city}`);
    const { tempC, condition } = (await res.json()) as { tempC: number; condition: string };
    const temp = unit === "F" ? tempC * 1.8 + 32 : tempC;
    return `${Math.round(temp)}°${unit}, ${condition}`;
  },
});
```

`city` and `unit` are typed from the schema — no generic parameter, no cast. The handler returns a plain string; the framework wraps it in a text block.

## The bundle

`createTool` returns four things, one per job:

```ts
const { declaration, handlerRef, handler, validator } = getWeather;
```

| Field         | What it's for                                                                         |
| ------------- | ------------------------------------------------------------------------------------- |
| `declaration` | The model-facing and wire-facing description: name, schemas, exposure, annotations    |
| `handlerRef`  | Stable id linking the declaration to its implementation (auto-generated, overridable) |
| `handler`     | The function to invoke at dispatch                                                    |
| `validator`   | Runs against dispatched input **before** the handler sees it                          |

Most consumers take the whole bundle and split it themselves. If you're writing the low-level wiring, the declaration goes to the registry and the `handlerRef` + `handler` + `validator` triple goes to the handler resolver — see [@agentick/tool-executor](../tool-executor).

## Validation

The schema does double duty: it validates dispatched input at runtime, and it's the source of the JSON Schema the model sees. Invalid input never reaches your handler — the executor rejects with a typed `ToolValidationError`.

Bring any Standard Schema validator:

```ts
import { jsonSchema } from "@agentick/spec";

export const search = createTool({
  name: "search",
  description: "Search the docs.",
  inputSchema: jsonSchema<{ query: string }>({
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  }),
  handler: async ({ query }) => `no results for ${query}`,
});
```

Omit `inputSchema` entirely and the tool accepts anything — the bundle carries a pass-through validator and the handler's input is `unknown`:

```ts
export const anything = createTool({
  name: "anything",
  description: "Takes whatever the model sends.",
  handler: async (input) => JSON.stringify(input),
});
```

## What a handler returns

Three shapes, all type-discriminable. Returning the wrong shape is a compile error, not a silent coercion.

```ts
// 1. A string — sugar for a single text block.
handler: async () => "72°F, clear";

// 2. Content blocks — text, images, documents, anything the model accepts.
handler: async () => [
  { type: "text", text: "Here is the chart:" },
  { type: "image", source: { type: "base64", mimeType: "image/png", data: "iVBOR..." } },
];

// 3. An envelope — display content plus typed data, plus a soft-error flag.
handler: async () => ({
  content: "72°F, clear",
  structuredContent: { tempF: 72, condition: "clear" },
  metadata: { source: "cache" },
});
```

Handlers may also return a `Promise`, an `Effect`, or a `TaskHandle` for long-running work.

> [!NOTE]
> There is no "return a plain object and we'll JSON it" path. `return { temp: 72 }` does not type-check. Structured data goes through `structuredContent`, which keeps display content and machine data separable all the way to the wire.

### Typed output makes tools composable

Declare an `outputSchema` and the executor validates `structuredContent` against it before the dispatch resolves — the same Standard Schema acceptance as `inputSchema`, and the same typed failure on a mismatch.

```ts
export const forecast = createTool({
  name: "forecast",
  description: "Three-day forecast.",
  inputSchema: z.object({ city: z.string() }),
  outputSchema: z.object({
    days: z.array(z.object({ date: z.string(), highC: z.number() })),
  }),
  handler: async ({ city }) => ({
    content: `Forecast for ${city}`,
    structuredContent: { days: [{ date: "2026-07-27", highC: 34 }] },
  }),
});
```

A typed output shape is what lets a model chain one tool's result into another's input, or write code that orchestrates several tools, instead of re-parsing prose at every hop. The schema is emitted to the model as `outputSchema` where the provider supports it, and to MCP clients as `CallToolResult.structuredContent`.

### Soft errors vs. hard failures

They are different things and the framework keeps them different:

```ts
export const readFile = createTool({
  name: "read_file",
  description: "Read a UTF-8 file.",
  inputSchema: z.object({ path: z.string() }),
  handler: async ({ path }) => {
    if (!path.startsWith("/workspace/")) {
      throw new Error("path escapes the workspace"); // hard: the dispatch REJECTS
    }
    const found = await lookup(path);
    if (!found) {
      return { content: `No file at ${path}`, isError: true }; // soft: the model retries
    }
    return found;
  },
});
```

`isError: true` is a domain outcome the model reasons about — "file not found", "rate-limited". The dispatch still **resolves**, and the flag rides through to MCP's `CallToolResult.isError`. A thrown or rejected handler is a host-level failure: the dispatch **rejects** with a typed error and produces no result at all.

> [!IMPORTANT]
> Execution provenance — who ran the tool, how long it took, how it should be presented — is stamped by the executor. It is not a field on the envelope, and a handler that widens its return type to smuggle `executedBy` gets those keys dropped at the boundary.

## The handler context

Every handler's second argument carries a `ctx` that is the same object in-process and on an MCP server. **The same handler runs unchanged whether an Agentick session dispatched it or an MCP client called it over the wire.**

```ts
export const deploy = createTool({
  name: "deploy",
  description: "Deploy the current branch.",
  inputSchema: z.object({ env: z.enum(["staging", "prod"]) }),
  handler: async ({ env }, { ctx }) => {
    if (env === "prod" && !(await ctx.elicit?.confirm("Deploy to production?"))) {
      return { content: "Cancelled by the user.", isError: true };
    }
    ctx.log.info({ event: "deploy.start", env });
    const bar = ctx.progress.begin({ total: 3, message: "building" });
    const out = await runDeploy(env, ctx.signal, () => bar.advance());
    return out;
  },
});
```

| Slot                                      | Notes                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `ctx.signal`                              | `AbortSignal` for the dispatch — composes host abort and caller abort            |
| `ctx.log` / `ctx.trace` / `ctx.metrics`   | Observability; `log` is callable and chainable via `.with(fields)`               |
| `ctx.progress.begin({ total? })`          | Out-of-band liveness; forwarded to MCP `notifications/progress`                  |
| `ctx.elicit`                              | Ask the user a question mid-handler — `text`, `select`, `confirm`                |
| `ctx.tasks` / `ctx.resource`              | Raw substrate primitives for long-running work and readable content              |
| `ctx.tools`                               | Dispatch a sibling tool by name — same door and exposure gate as `session.tools` |
| `ctx.setState(key, value)` / `ctx.emit()` | Per-call state and session channel events                                        |
| `ctx.transport`                           | `"in-process"` or `"mcp"` — branch only when behavior genuinely differs          |
| `ctx.mcp`                                 | Wire-level extras (client capabilities, authenticated user); MCP only            |

`ctx.progress` has two doors. `begin(opts?)` is the everyday one: it takes the token from the call, counts and clamps for you, and emits an opening frame so a bar appears the moment work starts. Pass `total` when you know the denominator; omit it when you don't, and never invent one — a spinner that tells the truth beats a bar that lies. The callable form, `ctx.progress(token, frame)`, is the raw door, for echoing a token that came from elsewhere.

Optional capabilities that not every deployment mounts — a sandbox, for instance — contribute their own `ctx` slot by module augmentation, so they show up as `ctx.sandbox?.…` when the package is installed. Guard the optional slots with `?`; the universal ones are always there.

## Client-handled tools

Omit the handler and you've declared a tool the **client** executes. The bundle carries no `handlerRef`, so the executor relays the call to the client instead of looking for a server implementation.

```ts
export const openFile = createTool({
  name: "open_file",
  description: "Open a file in the user's editor.",
  inputSchema: z.object({ path: z.string() }),
  annotations: { requiresResponse: false },
  defaultResult: ({ path }) => [{ type: "text", text: `Opened ${path}` }],
});
```

`defaultResult` is what the executor resolves with when no live result comes back: always, for fire-and-forget tools, and as the timeout fallback when `requiresResponse: true`. It takes a static block array or a function of the validated input.

## Presentation and confirmation

The fields below are all _seams_: pass a static value, or a function of the validated input and the dispatch context (sync or async) evaluated at the moment it's needed.

```ts
export const deleteFile = createTool({
  name: "delete_file",
  description: "Delete a file from the workspace.",
  inputSchema: z.object({ path: z.string() }),
  title: "Delete file",
  displaySummary: ({ path }) => `Deleting ${path}`,
  aliases: ["rm"],
  annotations: { requiresConfirmation: true, intent: "action" },
  confirmationMessage: ({ path }) => `Permanently delete ${path}?`,
  confirmationPreview: async ({ path }) => ({ diff: await previewDelete(path) }),
  handler: async ({ path }) => `Deleted ${path}`,
});
```

- **`title`** — human display name for the call (`Delete file`), never the model-facing identifier.
- **`displaySummary`** — the author's description of what _this specific call_ is doing. Kept distinct from the model's own narration and from `title`; nothing is collapsed, so a client can compose its own precedence.
- **`confirmationMessage`** / **`confirmationPreview`** — the prompt and the preview payload (a diff, a plan, a cost estimate) surfaced when `requiresConfirmation` fires the confirmation gate.
- **`aliases`** — alternate dispatch names. `dispatch("rm", …)` resolves to this tool; exact name wins over alias.

## Exposure

`exposure` says where a tool is reachable from. It defaults to `["model"]`.

```ts
export const compactHistory = createTool({
  name: "compact_history",
  description: "Summarize and drop old turns.",
  exposure: ["dispatch"], // host-callable, invisible to the model
  handler: async () => "compacted",
});
```

| Value        | Reachable from                         |
| ------------ | -------------------------------------- |
| `"model"`    | Model function-calling                 |
| `"dispatch"` | Host code, via `dispatch(name, input)` |
| `"runtime"`  | Internal framework use only            |

## Summaries and the capability tree

A large toolbox is unreadable as a flat list — for the model and for the person watching. Two declaration fields fix that, and neither costs a schema.

**`summary`** is one sentence: what the tool does, statically. It's the currency of a capabilities listing you keep in context permanently, so the model knows the lay of the land without every schema being resident. It is not `displaySummary` — that one describes what a _specific call_ is doing.

**`group`** is a path: `["api", "jobs"]`. The tree is nothing but the set of paths. No registry holds a group, dispatch never consults one, and a client derives its tree view by grouping the flat tool list on this field.

```ts
export const listJobs = createTool({
  name: "list_jobs",
  description: "List jobs, optionally filtered by status.",
  summary: "Lists jobs.",
  group: ["api", "jobs"],
  inputSchema: z.object({ status: z.enum(["open", "closed"]).optional() }),
  handler: async ({ status }) => JSON.stringify(await fetchJobs(status)),
});
```

### `createToolGroup`

Writing `group` by hand on every tool is the part you'd get wrong. `createToolGroup` stamps it for you and **returns a plain flat array of declarations** — there is no group object, nothing group-shaped survives the call:

```ts
import { createToolGroup } from "@agentick/tool";

export const jobTools = createToolGroup({
  name: "jobs",
  tools: [
    listJobs, // → group: ["jobs"]
    createToolGroup({
      name: "drafts",
      tools: [createDraft, publishDraft], // → group: ["jobs", "drafts"]
    }),
  ],
});

createApp(Agent, { tools: [...jobTools] });
```

A nested group is just a nested array — that _is_ the recursion. Each group prepends its own name onto whatever path its members already carry, so a tool that declared `group: ["x"]` inside a `"jobs"` group ends up at `["jobs", "x"]`. Members may be `createTool` bundles or raw declarations, mixed freely; the flattening keeps the declaration and drops the wrapper, so register handlers the way you always did.

A group's PROSE — the paragraph a prompt renders above the member names — is its own declaration (`ToolGroupInfo`), registered on `toolExecutor.groups`; see the `@agentick/tool-executor` README, "Group prose". Deriving names from paths (and vice versa) at registration is under study in blueprint 108 — today the path files, the name identifies, and neither rewrites the other.

## Catalogs

When the tool set changes at runtime — auth state, feature flags, late registration — hand consumers a catalog instead of an array. Consumers re-read on every list and subscribe for change notifications; the MCP server projection turns those notifications into `notifications/tools/list_changed`.

```ts
import { createToolCatalog, staticToolCatalog } from "@agentick/tool";

const catalog = createToolCatalog([getWeather.declaration]);

const stop = catalog.subscribeAll(() => {
  console.log(
    "tool set changed:",
    catalog.list().map((t) => t.name),
  );
});

catalog.register(forecast.declaration); // throws if the name is taken
catalog.replace(forecast.declaration); // atomic add-or-replace
catalog.remove("forecast"); // silent no-op if absent
stop();

const frozen = staticToolCatalog([getWeather.declaration]); // never changes
```

`isToolCatalog(x)` is duck-typed on `list` + `subscribeAll`, so you can bring your own implementation without importing ours.

## Transforms — `@agentick/tool/transforms`

Tool lists often need to look different per audience: a public MCP connection sees a renamed, filtered subset; an eval run ablates half the toolbox; an embedded product rebrands descriptions. `ToolTransform<C>` is a pure function from a declaration and a context to a new declaration or `null` (drop it).

```ts
import {
  applyTransform,
  composeTransforms,
  deny,
  filter,
  onlyExposingTo,
  prefix,
  rename,
  setTitle,
} from "@agentick/tool/transforms";

interface Viewer {
  readonly role: "admin" | "guest";
}

const publicView = composeTransforms<Viewer>(
  onlyExposingTo("model"),
  deny([/^admin_/]),
  filter((tool, viewer) => viewer.role === "admin" || !tool.metadata?.requiresAuth),
  rename({ internal_search: "search" }),
  prefix("public_"),
  setTitle({ public_search: "Search" }),
);

const visible = applyTransform(publicView, allTools, { role: "guest" });
```

| Primitive                                        | Purpose                                                         |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `composeTransforms(...ts)`                       | Compose N transforms left-to-right; first `null` short-circuits |
| `applyTransform(t, tools, ctx)`                  | Apply once to a list, dropping nulls                            |
| `rename({ from: to })`                           | Explicit name map; `false` drops the tool                       |
| `renameBy(fn)`                                   | Project a new name from `(tool, ctx)`                           |
| `prefix(str, { unlessAlready? })`                | Prepend to the name                                             |
| `suffix(str, { unlessAlready? })`                | Append to the name                                              |
| `describe({ name: text })`                       | Override the description                                        |
| `setTitle({ name: text })`                       | Set `metadata.title` (wire display)                             |
| `setIcons({ name: [...] })`                      | Set `metadata.icons` (wire display)                             |
| `filter((tool, ctx) => bool)`                    | Drop where the predicate is false                               |
| `allow([names + regexps])`                       | Keep only matches                                               |
| `deny([names + regexps])`                        | Drop matches                                                    |
| `onlyExposingTo(audience)`                       | Drop tools that don't expose to the audience                    |
| `replaceInputSchema({ name: schema })`           | Swap `inputSchema`                                              |
| `replaceOutputSchema({ name: schema })`          | Swap `outputSchema`, setting it even if absent                  |
| `mapSchemas({ mapInput?, mapOutput? })`          | Generic mapper for both schemas                                 |
| `setMetadata({ name: patch })`                   | Shallow-merge into `metadata`                                   |
| `replaceMetadata({ name: replacement \| null })` | Replace or remove `metadata` wholesale                          |

### Order matters

`composeTransforms` runs left-to-right, and a `null` anywhere in the chain short-circuits the rest:

```ts
composeTransforms(rename({ a: "b" }), prefix("api_")); // "a" → "b" → "api_b"
composeTransforms(prefix("api_"), rename({ a: "b" })); // "a" → "api_a" (rename no-ops)
```

### Two scope rules

1. **Transforms see declarations, not handlers.** Anything that needs to wrap the implementation — middleware, retry, logging — needs the whole bundle. That primitive isn't shipped yet; see the gaps below.
2. **No shipped transform touches `annotations`.** Names, descriptions, schemas, and `metadata` are rewritable; the semantic contract (confirmation requirements, behavior hints) flows through projection unchanged. Advertising a destructive tool as read-only to one audience is a safety footgun, so the library gives you no way to do it.

## API

| Export                               | Purpose                                                              |
| ------------------------------------ | -------------------------------------------------------------------- |
| `createTool(spec)`                   | The factory. Returns a `CreatedTool` bundle                          |
| `isCreatedTool(value)`               | Structural guard separating a bundle from a raw declaration          |
| `createToolGroup(spec)`              | Stamp a capability-tree path; returns a flat `ToolDeclaration[]`     |
| `permissiveValidator`                | Validator that accepts every input unchanged (the no-schema default) |
| `fromStandardSchema(schema)`         | Adapt any Standard Schema validator to the `Validator` interface     |
| `createToolCatalog(initial?)`        | Mutable catalog with change notifications                            |
| `staticToolCatalog(decls)`           | Read-only catalog over a fixed array                                 |
| `isToolCatalog(x)`                   | Duck-typed guard (`list` + `subscribeAll`)                           |
| `ToolSpec` / `CreatedTool`           | Factory input and returned bundle types                              |
| `ToolGroupSpec` / `ToolGroupMember`  | `createToolGroup` input, and what may sit in its `tools`             |
| `ToolCatalog` / `MutableToolCatalog` | Read surface and mutation surface                                    |

Additional `ToolSpec` fields not covered above: `narrate` (opt this tool out of injected model narration), `providerOptions` (per-provider tool options, e.g. OpenAI `strict`), `metadata` (arbitrary data on the declaration), and `handlerRef` (override the generated id when an external resolver already knows it).

## Patterns

**JSX agents.** If you're building with the React compiler, author with the `createTool` from [@agentick/compiler-react](../compiler-react) instead — same spec, plus a `use()` hook for capturing tree-positional context during render, and a `<Tool>` element to mount it. This package is what that variant is built on, and what you reach for when there's no compiler in the picture.

**Serving tools over MCP.** [@agentick/mcp](../mcp) accepts `CreatedTool[]` directly and does the split for you — declarations to `tools/list`, handlers to `tools/call`. Pair with transforms for per-connection views.

**Running tools in-process.** [@agentick/tool-executor](../tool-executor) owns the registry, layered scopes, validation, confirmation gates, and dispatch.

**Shapes and types.** [@agentick/spec](../spec) owns `ToolDeclaration`, `ToolHandlerCtx`, `ToolAnnotations`, `Validator`, and the content block types.

## Roadmap & known gaps

- **`wrapHandler`** — handler-aware transforms (middleware, retry, logging over the full bundle) are not shipped. Transforms today are declaration-only.
- **Catalog coverage** — `ToolCatalog` ships and is consumed by the MCP server projection, but has no test suite in this package; its behavior is exercised downstream in the MCP tools-list suites. A local suite is outstanding.
- **`narrate`** — the field threads onto the declaration, but this package has no test pinning it; the opt-out is covered where it's consumed.

## Verified by

- `src/__tests__/create-tool.spec.ts` — bundle shape, default exposure, `handlerRef` override, annotation/metadata forwarding, confirmation seams and aliases, client-handled tools, permissive-vs-Standard-Schema validation, handler invocation contract.
- `src/__tests__/tool-group.spec.ts` — `summary`/`group` on the declaration (both handler shapes, and absent when unset), and `createToolGroup` flattening: parent-first path prefixing across nesting levels, pre-existing paths, mixed bundle/declaration members, source declarations left unmutated.
- `src/transforms/__tests__/transforms.spec.ts` — every primitive, composition order, `null` short-circuiting, and an end-to-end projection.
- [@agentick/tool-executor](../tool-executor) `src/__tests__/tool-result-currency.spec.ts` — the three return shapes, `outputSchema` validation, soft-vs-hard error semantics, and executor-stamped provenance. `confirmation-seams.spec.ts` and `narration-strip.spec.ts` cover the confirmation, `title`, and `displaySummary` seams end to end.
