# @agentick/spec

The canonical contract package for Agentick v2.

`@agentick/spec` is the **firewall** between compiler, runtime, executor,
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

- `@agentick/spec` — index, re-exports everything
- `@agentick/spec/data` — wire data shapes only
- `@agentick/spec/protocol` — protocol interfaces only
- `@agentick/spec/guards` — type guards
