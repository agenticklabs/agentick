# @agentick/tool-next

Generic, reconciler-agnostic tool authoring for Agentick v2.

`createTool()` returns a registration bundle (`declaration` + `handler` + `validator`) that drops directly into any `ToolExecutorHarness` + `HandlerResolver`. Zero render-time concerns; no React hooks; no DI plumbing.

Reconciler-specific variants (e.g., React tools with `use()`) extend this base in their respective packages.

## Quick start

```ts
import { createTool } from "@agentick/tool-next";
import { z } from "zod";

const search = createTool({
  name: "search",
  description: "Find documents matching a query.",
  inputSchema: z.object({
    query: z.string(),
    limit: z.number().optional(),
  }),
  handler: async ({ query, limit }, { ctx }) => {
    const hits = await ctx.services.search.find({ query, limit });
    return [{ type: "text", text: JSON.stringify(hits) }];
  },
});

// Drop into a session / app / gateway:
const app = createApp(<Agent />, { tools: [search] });
```

`createTool` validates input against `inputSchema` before the handler runs; invalid input surfaces a `ToolValidationError` (typed) instead of reaching the handler.

## Subpaths

| Subpath                          | Purpose                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `@agentick/tool-next`            | `createTool` + `Validator` + JSON-Schema helpers                                           |
| `@agentick/tool-next/transforms` | `ToolTransform<C>` primitives for per-context tool-list projection (rename / filter / etc.) |

## Transforms — `@agentick/tool-next/transforms`

Library of `ToolTransform<C>` primitives that map / filter / rewrite `ToolDeclaration` lists per arbitrary context. Used by the MCP server projection (per-connection tool views), eval-next (ablation), in-app rebranding (audience-specific descriptions), and anywhere else a tool list needs adaptation.

```ts
import {
  applyTransform,
  composeTransforms,
  allow, deny, filter, onlyExposingTo,
  rename, renameBy, prefix, suffix,
  describe, setTitle, setIcons,
  replaceInputSchema, replaceOutputSchema, mapSchemas,
  setMetadata, replaceMetadata,
} from "@agentick/tool-next/transforms";

// Per-connection MCP-server-style projection:
const projection = composeTransforms<McpRequestContext>(
  onlyExposingTo("model"),
  deny([/^admin_/]),
  filter((tool, ctx) => ctx.user.role !== "guest" || !tool.metadata?.requiresAuth),
  rename({ internal_search: "search" }),
  prefix("public_"),
  setTitle({ public_search: "Search" }),
);

const projectedTools = applyTransform(projection, gatewayTools, ctx);
```

### Scope rules

1. **Transforms operate on `ToolDeclaration` only.** Handler-aware transforms (middleware, retry, logging) require the full registration bundle (`CreatedTool`); they ship as `wrapHandler` separately (not yet — coming with #171 server-side projection work).
2. **Semantic annotations are NEVER mutated.** `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, and v2's own `annotations` slot flow through projection unchanged. Lying about destructiveness per-audience is a safety footgun. See [ADR 40 §4](../../docs/proposals/v2/blueprint/40-mcp-server-harness.md).
3. **Transforms are stateless + pure.** Create once at module init; reuse across many calls. `apply` must not mutate the input.

### Primitive reference

| Primitive | Purpose |
|-----------|---------|
| `composeTransforms(...ts)` | Compose N transforms left-to-right; first-null short-circuits |
| `applyTransform(t, tools, ctx)` | Apply once to a list, dropping nulls |
| `rename({ from: to })` | Explicit name map; `false` drops |
| `renameBy(fn)` | Project new name from `(tool, ctx)` |
| `prefix(str, { unlessAlready? })` | Prepend to name |
| `suffix(str, { unlessAlready? })` | Append to name |
| `describe({ name: text })` | Override description |
| `setTitle({ name: text })` | Set `metadata.title` (MCP wire display) |
| `setIcons({ name: [...] })` | Set `metadata.icons` (MCP wire display) |
| `filter((tool, ctx) => bool)` | Drop where predicate is false |
| `allow([names + regexps])` | Keep only matches |
| `deny([names + regexps])` | Drop matches |
| `onlyExposingTo(audience)` | Drop tools not exposing to the audience |
| `replaceInputSchema({ name: schema })` | Swap inputSchema |
| `replaceOutputSchema({ name: schema })` | Swap outputSchema (sets it even if absent) |
| `mapSchemas({ mapInput?, mapOutput? })` | Generic mapper for both |
| `setMetadata({ name: patch })` | Shallow-merge metadata |
| `replaceMetadata({ name: replacement \| null })` | Replace or remove metadata wholesale |

### Composition order

`composeTransforms` runs left-to-right. Order matters:

```ts
composeTransforms(rename({ a: "b" }), prefix("api_"))
// "a" → "b" → "api_b"

composeTransforms(prefix("api_"), rename({ a: "b" }))
// "a" → "api_a"  (rename only matches "a", which is now "api_a"; no-op)
```

When a transform returns `null` (filter rejection, `rename(false)`), the chain short-circuits — subsequent transforms don't see the dropped tool.

## Verified by

- `src/__tests__/create-tool.spec.ts` — `createTool` registration shape, validation, defaults
- `src/transforms/__tests__/transforms.spec.ts` — 28 tests covering every primitive + composition + drop semantics + end-to-end MCP-shaped projection

## See also

- [ADR 40 — MCP server harness shape](../../docs/proposals/v2/blueprint/40-mcp-server-harness.md) §4 — how the MCP server uses these
- [`@agentick/tool-executor-next`](../tool-executor) — registry + dispatch runtime
- [`@agentick/spec-next`](../spec) — `ToolDeclaration` + `ToolRegistration` shapes
