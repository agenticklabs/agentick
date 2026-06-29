# @agentick/spec-next

The canonical contract package for Agentick v2.

`@agentick/spec-next` is the **firewall** between compiler, runtime, executor,
and optional topology wrappers. It contains:

- **Wire data shapes** that cross harness boundaries (`CompiledStructure`,
  `EventEnvelope`, `MessageEnvelope`, content blocks, execution results,
  etc.).
- **Protocol interfaces** for harness-to-harness integration
  (`CompilerProtocol`, `ExecutorProtocol`, `OperationJournal`,
  `MessageInbox`, etc.).
- **JSON Schema artifacts** for cross-language validation.
- **Type guards** for structural validation.

This package is:

- **Zero-dep** — no runtime dependencies. Pure types + schemas.
- **Browser-safe** — works in any JavaScript environment without
  polyfills.
- **Versioned** — date-versioned spec contract (`SPEC_VERSION`); semver
  package version.

## Status

🚧 In active development as part of v2 (`feat/v2`).

See [`docs/proposals/v2/blueprint/`](../../docs/proposals/v2/blueprint/)
for the full architectural blueprint, and
[`docs/proposals/v2/IMPLEMENTATION-PLAN.md`](../../docs/proposals/v2/IMPLEMENTATION-PLAN.md)
for the build sequencing.

## Subpath exports

- `@agentick/spec-next` — index, re-exports everything
- `@agentick/spec-next/data` — wire data shapes only
- `@agentick/spec-next/protocol` — protocol interfaces only
- `@agentick/spec-next/guards` — type guards

## Adopter-facing type aliases

Per ADR 42 §"Naming rules": no "Harness" or "Protocol" in
adopter-visible types. Every harness exposes a noun alias alongside
its `*HarnessProtocol`/`*Protocol` interface, so adopter code reads
naturally:

| Adopter alias              | Underlying protocol                         | Where used                              |
| -------------------------- | ------------------------------------------- | --------------------------------------- |
| `Prompts`                  | `PromptsHarnessProtocol`                    | `server.prompts`, `withPrompts(...)`    |
| `Elicit`                   | (sugar surface in `protocol/elicit-api.ts`) | `ctx.elicit`, `session.elicit`          |
| `Tools`, `Skills`, `Tasks` | (pending — ADR 42 Slices 2–3)               | `server.tools`, `withSkills(...)`, etc. |

The protocol shapes stay for power-user access; the aliases are
strictly nominal sugar.

## Cross-cutting types worth knowing

- **`ToolHandlerCtx`** (`data/tool-handler.ts`) — the unified ctx every
  tool handler sees, in-process AND MCP-server. Carries
  `transport: "in-process" | "mcp"` discriminator + optional
  `mcp?: McpRequestExtras` sub-slot for MCP wire identity. See ADR 43.
- **`McpRequestContext`** (`protocol/mcp-server-harness.ts`) — type
  alias of `ToolHandlerCtx & { transport: "mcp"; mcp: McpRequestExtras }`.
  Import this from MCP-server-specific code paths (security stages,
  projection); structurally identical to the unified ctx.
- **`Elicit`** (`protocol/elicit-api.ts`) — sugar interface exposed
  on `ctx.elicit` (tool handlers) and `session.elicit`. Same surface
  regardless of routing transport.
- **`AgentickError`** (`errors/base.ts`) — abstract root of the v2
  typed-error class hierarchy (per ADR 41). Concrete subclasses
  register via `registerAgentickError(tag, cls)` and serialize through
  `serializeAgentickError` / `deserializeAgentickError` with full
  cross-wire class-identity preservation.
