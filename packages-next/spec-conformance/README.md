# @agentick/spec-conformance-next

**Internal package. Not published to npm.** (`private: true`)

Shared conformance test fixtures for `@agentick/spec-next` implementations.

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

- Internal packages (`@agentick/runtime-next`, `@agentick/persistence-*`,
  executor adapters) dev-depend on this fixture package.
- Marked `private: true` so it doesn't publish to npm.
- The conformance discipline keeps swap-Layer-substrate honest:
  every implementation must pass the same suite.
