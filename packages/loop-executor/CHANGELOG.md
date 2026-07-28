# @agentick/loop-executor

## 1.0.0-next.20

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.20
  - @agentick/spec@1.0.0-next.20
  - @agentick/utils@1.0.0-next.20

## 1.0.0-next.19

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.19
  - @agentick/spec@1.0.0-next.19
  - @agentick/utils@1.0.0-next.19

## 1.0.0-next.18

### Minor Changes

- `ToolPresentation` crosses to the client. The four un-collapsed label
  materials (`name` / `title` / `summary` / `narration`) the tool executor
  already resolves at dispatch — `summary` being the author's
  `displaySummary` annotation resolved against the VALIDATED input — were
  computed and then thrown away on the wire path; `presentation` is now an
  optional field on `tool-dispatch-end` and `tool-dispatch`, threaded
  through `LoopExecutionEvent` and `buildOnEvent`. No new types, no second
  resolution site, and the framework still presumes no precedence — the
  client composes.

  Deliberately NOT on `tool-dispatch-start`, contrary to where the label is
  wanted first: resolution happens INSIDE the dispatch (it needs the
  validated input and the model's stripped narration), strictly after the
  start event is emitted. A slot there would be structurally
  always-undefined, and filling it would mean re-resolving off the raw
  declaration — a second, divergent path for the same fact. Pinned by a
  test asserting `tool-dispatch-start` carries no `presentation`.

- Result-level metadata now reaches the client on the tool-dispatch stream
  event. `ToolDispatchEvent.metadata` forwards `DispatchResult.metadata`
  verbatim — the loop projects the bag it is handed and never interprets
  it — which is what an MCP-Apps frame descriptor needs to reach a UI.

  The consuming side stopped dropping it. `mapCallToolResult` now folds an
  incoming `CallToolResult._meta` into `metadata.mcp.meta` — the SAME
  namespaced key the server-side result extensions project FROM, so a
  result-scoped payload reads identically whether agentick produced it or
  received it — and `withMCP`'s proxy handlers return the full mapped
  result instead of bare content blocks. Two fields the bare content
  mapping also silently dropped now survive with it: `structuredContent`,
  and `isError`, which means a consumed MCP tool's DOMAIN error no longer
  reaches the model wearing a success.

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.18
  - @agentick/spec@1.0.0-next.18
  - @agentick/utils@1.0.0-next.18

## 1.0.0-next.17

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.17
  - @agentick/spec@1.0.0-next.17
  - @agentick/utils@1.0.0-next.17

## 1.0.0-next.16

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.16
  - @agentick/spec@1.0.0-next.16
  - @agentick/utils@1.0.0-next.16

## 1.0.0-next.15

### Minor Changes

- Three follow-ups riding one slice. (1) The run-level `execution` summary
  event now EXISTS: the loop emits `kind: "execution"` (output, usage,
  stopReason, durationMs) after `execution-end` on any terminal carrying a
  result — exactly as the per-tick `"tick"` follows `"tick-end"` — and the
  session forwards it as the `type: "execution"` StreamEvent, which was
  declared in spec but had no producer anywhere. Adopters now get a
  per-execution duration, not just per-tick. (2) BREAKING: the superseded
  `session/timeline_history` gateway porcelain is DELETED — handler, spec
  `WireMethods` row, and the `SessionTimelineHistoryParams`/`Entry`/
  `Result` types (the `Entry.cursor` co-location affordance was never
  populated by anything and dies with it). `timeline/history` — the
  harness's own grant-gated declared read — is the one wire door; the
  bounded-tool-output hint now points there. (3) `LoopExecutorFactory`,
  `ToolExecutorFactory`, and `SessionHarnessFactory` all type `deps` as
  OPTIONAL, matching their implementations' documented local-substrate
  fallback (the `CompilerFactory` cure applied to its three twins) —
  dep-less construction is now reachable through the public types and
  pinned by tests in all three packages.

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.15
  - @agentick/spec@1.0.0-next.15
  - @agentick/utils@1.0.0-next.15

## 1.0.0-next.14

### Minor Changes

- Cancellation parity — BREAKING for anyone reading `outcome` on an
  abort. Every cancellation entry point now lands `outcome: "canceled"`:
  a caller-supplied `signal` abort reports exactly like `abort()` and
  `timeoutMs` (it previously reported `succeeded`), with `stopReason`
  naming which one fired (`"aborted"` / `"timeout"`). A signal that
  aborts only after the run finished naturally does not relabel the
  finished work. Session-side, a canceled terminal that carries a result
  now RESOLVES `send()` with `stopReason: "aborted"` — as the session
  README always promised — instead of rejecting; only a result-less
  terminal rejects. Riding along: a derived-promise hygiene sweep (four
  unhandled-rejection leaks fixed, the biggest on every harness's
  `ready`), `CompilerFactory` deps widened to optional with a dep-less
  `reactCompiler()` fallback, the model-executor's backward-compat
  aliases deleted onto `ExecutorLifecycle`'s own API, and a workspace
  docblock sweep (21 stale `-next` specifiers and dead contracts).

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.14
  - @agentick/spec@1.0.0-next.14
  - @agentick/utils@1.0.0-next.14

## 1.0.0-next.13

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.13
  - @agentick/spec@1.0.0-next.13
  - @agentick/utils@1.0.0-next.13

## 1.0.0-next.12

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.12
  - @agentick/spec@1.0.0-next.12
  - @agentick/utils@1.0.0-next.12

## 1.0.0-next.11

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.11
  - @agentick/spec@1.0.0-next.11
  - @agentick/utils@1.0.0-next.11

## 1.0.0-next.10

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.10
  - @agentick/spec@1.0.0-next.10
  - @agentick/utils@1.0.0-next.10

## 1.0.0-next.9

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.9
  - @agentick/spec@1.0.0-next.9
  - @agentick/utils@1.0.0-next.9

## 1.0.0-next.8

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.8
  - @agentick/spec@1.0.0-next.8
  - @agentick/utils@1.0.0-next.8

## 1.0.0-next.7

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.7
  - @agentick/spec@1.0.0-next.7
  - @agentick/utils@1.0.0-next.7

## 1.0.0-next.6

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.6
  - @agentick/spec@1.0.0-next.6
  - @agentick/utils@1.0.0-next.6

## 1.0.0-next.5

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.5
  - @agentick/spec@1.0.0-next.5
  - @agentick/utils@1.0.0-next.5

## 1.0.0-next.4

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.4
  - @agentick/spec@1.0.0-next.4
  - @agentick/utils@1.0.0-next.4

## 1.0.0-next.3

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.3
  - @agentick/spec@1.0.0-next.3
  - @agentick/utils@1.0.0-next.3

## 1.0.0-next.2

### Patch Changes

- Updated dependencies:
  - @agentick/runtime@1.0.0-next.2
  - @agentick/spec@1.0.0-next.2
  - @agentick/utils@1.0.0-next.2
