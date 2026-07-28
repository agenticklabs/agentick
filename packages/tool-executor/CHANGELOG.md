# @agentick/tool-executor

## 1.0.0-next.20

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.20
  - @agentick/elicitation@1.0.0-next.20
  - @agentick/runtime@1.0.0-next.20
  - @agentick/spec@1.0.0-next.20
  - @agentick/tasks@1.0.0-next.20
  - @agentick/utils@1.0.0-next.20

## 1.0.0-next.19

### Minor Changes

- `toolConfirmation(elic)` — the reader for the tool-confirmation contract, on
  `@agentick/tool-executor/client`. `ConfirmRequest` was exported as a TYPE with
  nothing that produces one: the mapping from an elicitation's
  `metadata.{toolName,toolUseId,arguments,preview}` + `message` lived in a private
  `toRequest`, so the documented "draw your own confirmation dialog" path had a
  shape to fill and no way to fill it. The first real consumer hand-rolled the
  mapping and dropped `preview` — every tool with a `confirmationPreview` rendered
  an empty dialog body.

  The reader NARROWS: `undefined` when `hints.kind !== "tool_confirmation"`, so it
  doubles as the discriminator a UI needs while walking
  `session.elicitations.list()` — no hardcoded hint string, no second pass. Its
  parameter is structural, so a `ClientElicitationHandle` off `list()` fits with no
  cast. `confirmClientTools` now filters through the same reader; the private
  `toRequest` is gone, so there is one mapping rather than two that can drift.

### Patch Changes

- Nothing to call at boot for a client catalog. The four RPC-polled
  projections (`session.tools`, `session.prompts`, `session.skills`,
  `session.resources`) already seed themselves on construction AND fire
  `subscribe` when the answer lands — so binding `list()` + `subscribe()`
  is the entire read path. That was never written down, so the first real
  consumer fired three speculative `refresh()` round-trips at every
  session open (`session.tools.refresh().catch(() => undefined)` and
  friends) purely as a boot barrier, doubling the wire traffic and turning
  a failed poll into a silently empty palette.

  No new API: the requirement is removed by documenting the contract that
  already holds and pinning it with tests. The `ClientHandle` contract, the
  four package READMEs, and each handle's own comment now say the same
  thing — render what `list()` has, re-render on change, never poll at
  boot; `refresh()` is for invalidating a snapshot you already hold. Each
  of the four packages gained a test that a subscriber registered while
  the seed is still in flight is notified when it lands (with exactly ONE
  poll on the wire), and that a failed first poll settles the snapshot
  empty — never half-filled — until `refresh()` recovers it.

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.19
  - @agentick/elicitation@1.0.0-next.19
  - @agentick/runtime@1.0.0-next.19
  - @agentick/spec@1.0.0-next.19
  - @agentick/tasks@1.0.0-next.19
  - @agentick/utils@1.0.0-next.19

## 1.0.0-next.18

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.18
  - @agentick/elicitation@1.0.0-next.18
  - @agentick/runtime@1.0.0-next.18
  - @agentick/spec@1.0.0-next.18
  - @agentick/tasks@1.0.0-next.18
  - @agentick/utils@1.0.0-next.18

## 1.0.0-next.17

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.17
  - @agentick/elicitation@1.0.0-next.17
  - @agentick/runtime@1.0.0-next.17
  - @agentick/spec@1.0.0-next.17
  - @agentick/tasks@1.0.0-next.17
  - @agentick/utils@1.0.0-next.17

## 1.0.0-next.16

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.16
  - @agentick/elicitation@1.0.0-next.16
  - @agentick/runtime@1.0.0-next.16
  - @agentick/spec@1.0.0-next.16
  - @agentick/tasks@1.0.0-next.16
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
  - @agentick/client-core@1.0.0-next.15
  - @agentick/elicitation@1.0.0-next.15
  - @agentick/runtime@1.0.0-next.15
  - @agentick/spec@1.0.0-next.15
  - @agentick/tasks@1.0.0-next.15
  - @agentick/utils@1.0.0-next.15

## 1.0.0-next.14

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.14
  - @agentick/elicitation@1.0.0-next.14
  - @agentick/runtime@1.0.0-next.14
  - @agentick/spec@1.0.0-next.14
  - @agentick/tasks@1.0.0-next.14
  - @agentick/utils@1.0.0-next.14

## 1.0.0-next.13

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.13
  - @agentick/elicitation@1.0.0-next.13
  - @agentick/runtime@1.0.0-next.13
  - @agentick/spec@1.0.0-next.13
  - @agentick/tasks@1.0.0-next.13
  - @agentick/utils@1.0.0-next.13

## 1.0.0-next.12

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.12
  - @agentick/elicitation@1.0.0-next.12
  - @agentick/runtime@1.0.0-next.12
  - @agentick/spec@1.0.0-next.12
  - @agentick/tasks@1.0.0-next.12
  - @agentick/utils@1.0.0-next.12

## 1.0.0-next.11

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.11
  - @agentick/elicitation@1.0.0-next.11
  - @agentick/runtime@1.0.0-next.11
  - @agentick/spec@1.0.0-next.11
  - @agentick/tasks@1.0.0-next.11
  - @agentick/utils@1.0.0-next.11

## 1.0.0-next.10

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.10
  - @agentick/elicitation@1.0.0-next.10
  - @agentick/runtime@1.0.0-next.10
  - @agentick/spec@1.0.0-next.10
  - @agentick/tasks@1.0.0-next.10
  - @agentick/utils@1.0.0-next.10

## 1.0.0-next.9

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.9
  - @agentick/elicitation@1.0.0-next.9
  - @agentick/runtime@1.0.0-next.9
  - @agentick/spec@1.0.0-next.9
  - @agentick/tasks@1.0.0-next.9
  - @agentick/utils@1.0.0-next.9

## 1.0.0-next.8

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.8
  - @agentick/elicitation@1.0.0-next.8
  - @agentick/runtime@1.0.0-next.8
  - @agentick/spec@1.0.0-next.8
  - @agentick/tasks@1.0.0-next.8
  - @agentick/utils@1.0.0-next.8

## 1.0.0-next.7

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.7
  - @agentick/elicitation@1.0.0-next.7
  - @agentick/runtime@1.0.0-next.7
  - @agentick/spec@1.0.0-next.7
  - @agentick/tasks@1.0.0-next.7
  - @agentick/utils@1.0.0-next.7

## 1.0.0-next.6

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.6
  - @agentick/elicitation@1.0.0-next.6
  - @agentick/runtime@1.0.0-next.6
  - @agentick/spec@1.0.0-next.6
  - @agentick/tasks@1.0.0-next.6
  - @agentick/utils@1.0.0-next.6

## 1.0.0-next.5

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.5
  - @agentick/elicitation@1.0.0-next.5
  - @agentick/runtime@1.0.0-next.5
  - @agentick/spec@1.0.0-next.5
  - @agentick/tasks@1.0.0-next.5
  - @agentick/utils@1.0.0-next.5

## 1.0.0-next.4

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.4
  - @agentick/elicitation@1.0.0-next.4
  - @agentick/runtime@1.0.0-next.4
  - @agentick/spec@1.0.0-next.4
  - @agentick/tasks@1.0.0-next.4
  - @agentick/utils@1.0.0-next.4

## 1.0.0-next.3

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.3
  - @agentick/elicitation@1.0.0-next.3
  - @agentick/runtime@1.0.0-next.3
  - @agentick/spec@1.0.0-next.3
  - @agentick/tasks@1.0.0-next.3
  - @agentick/utils@1.0.0-next.3

## 1.0.0-next.2

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.2
  - @agentick/elicitation@1.0.0-next.2
  - @agentick/runtime@1.0.0-next.2
  - @agentick/spec@1.0.0-next.2
  - @agentick/tasks@1.0.0-next.2
  - @agentick/utils@1.0.0-next.2
