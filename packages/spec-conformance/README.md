# @agentick/spec-conformance

**Internal package. Not published to npm.** (`private: true`)

Shared conformance test fixtures for `@agentick/spec` implementations.

Implementations of substrate contracts — `OperationJournal`,
`MessageInbox`, `EventBus`, `BaseHarness`, `Renderer` — must pass these
fixtures to certify conformance.

## Status

🚧 In active development as part of v2 (`feat/v2`).

Per Phase 1 of [`IMPLEMENTATION-PLAN.md`](../../docs/proposals/v2/IMPLEMENTATION-PLAN.md):

- `runJournalConformance(j: OperationJournal)`
- `runInboxConformance(i: MessageInbox)`
- `runHarnessConformance(h: BaseHarness)`
- `runRendererConformance(r: Renderer)`

Currently signature stubs only; bodies are populated as the substrate
implementations land in Phase 2.

## Why a separate package

- Internal packages (`@agentick/runtime`, `@agentick/persistence-*`,
  executor adapters) dev-depend on this fixture package.
- Marked `private: true` so it doesn't publish to npm.
- The conformance discipline keeps swap-Layer-substrate honest:
  every implementation must pass the same suite.

## Shared test fixtures

Beyond protocol conformance suites, this package also ships shared
test fixture factories — concrete value builders consumed across the
workspace.

### `fakeToolHandlerCtx(overrides?)` — ADR 43

Returns a fresh `ToolHandlerCtx` with sensible defaults
(`transport: "in-process"`, `task: "auto"`, no-op setState/emit).
Pass `transport: "mcp"` + `mcp: {...}` for MCP-side fixtures; the
result is structurally identical to `McpRequestContext`.

```ts
import { fakeToolHandlerCtx } from "@agentick/spec-conformance";

// In-process default
const ctx = fakeToolHandlerCtx({ toolCallId: "tc-1" });

// MCP-side with custom user
const mcpCtx = fakeToolHandlerCtx({
  toolCallId: "tc-2",
  transport: "mcp",
  mcp: { user: { id: "alice", roles: ["admin"] } },
});
```

Use this factory in every spec that constructs a fake ctx — that way
when the canonical `ToolHandlerCtx` shape evolves (new required
field, new sugar slot), one update here propagates to every consumer.
ADR 43 Slice 1's `transport` discriminator addition would have
broken every spec independently without this helper.

## Verified by

- The error-class conformance suite (`runAgentickErrorConformance`)
  pins the full v2 error registry — 88 framework error tags exercised
  for registry-membership + instance-shape + codec round-trip
  invariants. See
  [`src/__tests__/agentick-error-conformance.spec.ts`](./src/__tests__/agentick-error-conformance.spec.ts).
- Per-protocol suites land in the implementing packages' specs (one
  spec per implementor calling the matching `run*Conformance`).
