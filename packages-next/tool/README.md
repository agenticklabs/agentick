# @agentick/tool-next

Generic, compiler-agnostic tool authoring for Agentick v2.

## What it is

`createTool()` is the base tool factory. It takes a spec (`name`, `description`, a Standard-Schema `inputSchema`, a `handler`) and returns a registration **bundle** — `{ declaration, handlerRef, handler, validator }` — that drops directly into any `ToolExecutorHarness` + `HandlerResolver` pair, or into any consumer that accepts the `CreatedTool[]` shorthand (e.g. the MCP server projection).

Zero render-time concerns; no React hooks; no DI plumbing. It depends only on `@agentick/spec-next`. Compiler-specific variants extend this base in their own packages — e.g. `@agentick/compiler-react-next` ships its own `createTool` that adds a `use()` hook slot for capturing tree-scoped context (sandbox, MCP refs) during the compiler's collect walk, rendered as `<Tool>`. This package is what those variants are built on, and what you reach for when you need a tool with no compiler at all.

## Quick start

```ts
import { createTool } from "@agentick/tool-next";
import { z } from "zod";

const askName = createTool({
  name: "ask_name",
  description: "Ask the user their name.",
  inputSchema: z.object({}),
  handler: async (_input, { ctx }) => {
    // ctx.elicit works identically in-process AND in an MCP-server
    // projection — same tool, both transports. See ADR 43.
    const name = await ctx.elicit?.text("Your name?", { default: "Ada" });
    return [{ type: "text", text: `Hello, ${name ?? "anonymous"}` }];
  },
});
```

`askName` is a `CreatedTool` bundle, not a bare declaration. Where it goes:

```ts
// Consumer that accepts the CreatedTool[] shorthand — the MCP server projection
// splits each bundle into a wire declaration + a resolvable handler for you:
import { spawnStandaloneMcpServer, stdioTransport } from "@agentick/mcp-next/server";

await spawnStandaloneMcpServer({
  name: "example-server",
  transports: [stdioTransport()],
  tools: [askName], // readonly CreatedTool[]
});
```

For low-level wiring, register the pieces yourself: `declaration` → `ToolExecutorHarness.register({ registration })`, and `handlerRef` + `handler` + `validator` → the `HandlerResolver`. For a JSX agent, author with the `createTool` from `@agentick/compiler-react-next` and render `<Tool>` — the adopter `tools:` slots on sessions/apps take `ToolDeclaration[]`, which the compiler produces from the tree.

### Validation

The returned `validator` is what the tool executor runs against dispatched input **before** the handler is invoked; invalid input surfaces a typed `ToolValidationError` (from `@agentick/spec-next`) instead of reaching the handler. `createTool` itself performs no validation — it packages the validator (a `StandardSchemaV1` adapter when `inputSchema` is set, or a permissive pass-through when it is omitted). Any Standard-Schema library works: Zod 4, Valibot, ArkType, Effect Schema, or a raw JSON Schema wrapped via `jsonSchema({ ... })` from spec.

### Result currency (ADR 70)

A handler returns one of three **discriminable** shapes (plus the usual `Promise` / `Effect` / `TaskHandle` wrappers), normalized to one internal result at dispatch:

```ts
handler: async () => "42"; // string sugar → [{ type: "text", text: "42" }]
handler: async () => [{ type: "text", text: "42" }]; // ContentBlock[] — the classic shape
handler: async () => ({
  // the opt-in envelope
  content: "72°F, clear", //   display (string sugar accepted here too)
  structuredContent: { tempF: 72, condition: "clear" }, //   typed machine result (outputSchema-validated)
  isError: false, //   SOFT/domain error flag (default false)
  metadata: { source: "cache" },
});
```

The three shapes stay type-discriminable (`string` / array / object-with-`content`), so a **wrong-shape return is a compile error** — there is no plain-object→JSON-block guessing (`return { temp: 72 }` does not silently become content; it fails to type-check). Structured data goes through `structuredContent`, not a bare object.

**`structuredContent` + `outputSchema` = composition.** When a tool declares `outputSchema`, the executor validates the envelope's `structuredContent` against it (same Standard-Schema acceptance as `inputSchema`; a failure is a typed dispatch error). A typed output shape is what lets the model treat tools as composable building blocks — chain one tool's typed output into another's typed input, or emit code that orchestrates several tools ("tools as an API") — instead of re-parsing prose each hop. It flows to `DispatchResult.structuredContent` and, on the MCP wire, to `CallToolResult.structuredContent`.

**`isError` (soft) vs throw (hard).** `isError: true` is a _domain_ error the model reasons about and can retry ("file not found", "rate-limited") — the dispatch still **resolves**. A thrown/rejected handler is a _hard_ failure — the dispatch **rejects** with a typed `ToolExecutorError` and never produces a result. `isError` maps to MCP `CallToolResult.isError`.

## Tool handler ctx is transport-portable

Per ADR 43, every `ToolHandler` receives a `ToolHandlerCtx` with a `transport: "in-process" | "mcp"` discriminator. **The same handler runs unchanged whether dispatched by an in-process Agentick session OR by an MCP server projecting your `ToolDeclaration` onto the wire.**

```ts
handler: async (input, { ctx }) => {
  ctx.transport;                        // "in-process" or "mcp"
  ctx.signal;                           // AbortSignal — cancellation
  await ctx.elicit?.confirm("Apply?");  // sugar, both transports
  ctx.tasks?.submit(...);               // raw substrate primitive, both transports
  ctx.mcp?.clientCapabilities;          // MCP-only extras, undefined in-process
  return [...];
},
```

Substrate primitives every session has (`elicit`/`elicitation`, `tasks`, `resource`) live on `ctx`; extension- or provider-scoped things flow through the JSX `use:` capture of the compiler variant. Branch on `ctx.transport` only when the handler genuinely needs different behavior per transport (rare). Common code stays portable.

## API

Exhaustive detail is in the generated typedoc. Key exports:

### `@agentick/tool-next`

| Export                               | Purpose                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `createTool(spec)`                   | Base factory → `CreatedTool` bundle                                                           |
| `isCreatedTool(value)`               | Structural guard discriminating a bundle from a raw `ToolDeclaration`                         |
| `ToolSpec` / `CreatedTool` (types)   | Factory input spec / returned bundle shape                                                    |
| `permissiveValidator`                | `Validator` that accepts every input unchanged (used when no `inputSchema`)                   |
| `fromStandardSchema(schema)`         | Adapt any `StandardSchemaV1` to the spec `Validator` interface                                |
| `createToolCatalog(initial?)`        | Build a `MutableToolCatalog` — mutable tool source with change notifications                  |
| `staticToolCatalog(decls)`           | Wrap a fixed array as a read-only, never-changing `ToolCatalog`                               |
| `isToolCatalog(x)`                   | Duck-typed guard (`list` + `subscribeAll`)                                                    |
| `ToolCatalog` / `MutableToolCatalog` | Read (`list` + `subscribeAll`) and mutation (`register`/`remove`/`replace`/`setAll`) surfaces |

`ToolCatalog` exists for consumers that need to observe a tool set over time — the MCP server projection re-fetches on every `tools/list` and fires `notifications/tools/list_changed` when the catalog mutates. Static-array adopters don't need it; the projection normalizes a plain array through `staticToolCatalog` internally.

### `@agentick/tool-next/transforms`

`ToolTransform<C>` primitives that map / filter / rewrite `ToolDeclaration` lists per arbitrary context (see below).

## Transforms — `@agentick/tool-next/transforms`

Library of `ToolTransform<C>` primitives that map / filter / rewrite `ToolDeclaration` lists per arbitrary context. Used by the MCP server projection (per-connection tool views), eval ablation, in-app rebranding (audience-specific descriptions), and anywhere else a tool list needs adaptation.

```ts
import {
  applyTransform,
  composeTransforms,
  allow,
  deny,
  filter,
  onlyExposingTo,
  rename,
  renameBy,
  prefix,
  suffix,
  describe,
  setTitle,
  setIcons,
  replaceInputSchema,
  replaceOutputSchema,
  mapSchemas,
  setMetadata,
  replaceMetadata,
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

1. **Transforms operate on `ToolDeclaration` only.** Handler-aware transforms (middleware, retry, logging) require the full registration bundle (`CreatedTool`); a `wrapHandler` primitive for those is not yet shipped (see Status).
2. **Semantic annotations are NEVER mutated.** `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, and v2's own `annotations` slot flow through projection unchanged. Lying about destructiveness per-audience is a safety footgun. See [ADR 40 §4](../../docs/proposals/v2/blueprint/40-mcp-server-harness.md).
3. **Transforms are stateless + pure.** Create once at module init; reuse across many calls. `apply` must not mutate the input.

### Primitive reference

| Primitive                                        | Purpose                                                       |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `composeTransforms(...ts)`                       | Compose N transforms left-to-right; first-null short-circuits |
| `applyTransform(t, tools, ctx)`                  | Apply once to a list, dropping nulls                          |
| `rename({ from: to })`                           | Explicit name map; `false` drops                              |
| `renameBy(fn)`                                   | Project new name from `(tool, ctx)`                           |
| `prefix(str, { unlessAlready? })`                | Prepend to name                                               |
| `suffix(str, { unlessAlready? })`                | Append to name                                                |
| `describe({ name: text })`                       | Override description                                          |
| `setTitle({ name: text })`                       | Set `metadata.title` (MCP wire display)                       |
| `setIcons({ name: [...] })`                      | Set `metadata.icons` (MCP wire display)                       |
| `filter((tool, ctx) => bool)`                    | Drop where predicate is false                                 |
| `allow([names + regexps])`                       | Keep only matches                                             |
| `deny([names + regexps])`                        | Drop matches                                                  |
| `onlyExposingTo(audience)`                       | Drop tools not exposing to the audience                       |
| `replaceInputSchema({ name: schema })`           | Swap inputSchema                                              |
| `replaceOutputSchema({ name: schema })`          | Swap outputSchema (sets it even if absent)                    |
| `mapSchemas({ mapInput?, mapOutput? })`          | Generic mapper for both                                       |
| `setMetadata({ name: patch })`                   | Shallow-merge metadata                                        |
| `replaceMetadata({ name: replacement \| null })` | Replace or remove metadata wholesale                          |

### Composition order

`composeTransforms` runs left-to-right. Order matters:

```ts
composeTransforms(rename({ a: "b" }), prefix("api_"));
// "a" → "b" → "api_b"

composeTransforms(prefix("api_"), rename({ a: "b" }));
// "a" → "api_a"  (rename only matches "a", which is now "api_a"; no-op)
```

When a transform returns `null` (filter rejection, `rename(false)`), the chain short-circuits — subsequent transforms don't see the dropped tool.

## Status & roadmap

- **`createTool` + validators** — stable. Bundle shape, exposure defaults, annotation/metadata forwarding, and Standard-Schema validation are covered by `create-tool.spec.ts`.
- **Transforms** — stable. Every primitive plus composition + drop semantics is covered.
- **`ToolCatalog`** — shipped and consumed by the MCP server projection, but this package has no dedicated spec for it; its behavior is exercised through the MCP server's `tools-slot` / `tools-list-changed` suites. A local spec is a known gap.
- **`wrapHandler` (handler-aware transforms: middleware/retry/logging over the full `CreatedTool` bundle)** — not yet shipped. Transforms today are declaration-only. Tracked with the server-side projection work.

## Verified by

- `src/__tests__/create-tool.spec.ts` — bundle shape, exposure default, `handlerRef` override, annotation/metadata forwarding, permissive-vs-Standard-Schema validation, handler invocation contract
- `src/transforms/__tests__/transforms.spec.ts` — 28 tests covering every primitive + composition + drop semantics + end-to-end MCP-shaped projection

## See also

- [ADR 43 — Unified `ToolHandlerCtx`](../../docs/proposals/v2/blueprint/43-unified-tool-handler-ctx.md) — one ctx across transports
- [ADR 40 — MCP server harness shape](../../docs/proposals/v2/blueprint/40-mcp-server-harness.md) §4 — how the MCP server uses transforms
- [`@agentick/tool-executor-next`](../tool-executor) — registry + dispatch runtime
- [`@agentick/spec-next`](../spec) — `ToolDeclaration`, `ToolHandlerCtx`, `Validator`, `ToolValidationError` shapes
