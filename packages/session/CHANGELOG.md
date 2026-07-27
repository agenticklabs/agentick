# @agentick/session

## 1.0.0-next.17

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.17
  - @agentick/compiler-react@1.0.0-next.17
  - @agentick/elicitation@1.0.0-next.17
  - @agentick/gates@1.0.0-next.17
  - @agentick/knobs@1.0.0-next.17
  - @agentick/loop-executor@1.0.0-next.17
  - @agentick/model@1.0.0-next.17
  - @agentick/model-executor@1.0.0-next.17
  - @agentick/pubsub@1.0.0-next.17
  - @agentick/resources@1.0.0-next.17
  - @agentick/runtime@1.0.0-next.17
  - @agentick/spec@1.0.0-next.17
  - @agentick/state@1.0.0-next.17
  - @agentick/store@1.0.0-next.17
  - @agentick/tasks@1.0.0-next.17
  - @agentick/timeline@1.0.0-next.17
  - @agentick/tool-executor@1.0.0-next.17
  - @agentick/utils@1.0.0-next.17

## 1.0.0-next.16

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.16
  - @agentick/compiler-react@1.0.0-next.16
  - @agentick/elicitation@1.0.0-next.16
  - @agentick/gates@1.0.0-next.16
  - @agentick/knobs@1.0.0-next.16
  - @agentick/loop-executor@1.0.0-next.16
  - @agentick/model@1.0.0-next.16
  - @agentick/model-executor@1.0.0-next.16
  - @agentick/pubsub@1.0.0-next.16
  - @agentick/resources@1.0.0-next.16
  - @agentick/runtime@1.0.0-next.16
  - @agentick/spec@1.0.0-next.16
  - @agentick/state@1.0.0-next.16
  - @agentick/store@1.0.0-next.16
  - @agentick/tasks@1.0.0-next.16
  - @agentick/timeline@1.0.0-next.16
  - @agentick/tool-executor@1.0.0-next.16
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

- Verified-defect hygiene slice, every behavior fix red-first. `<H1>`–`<H3>`
  and `<Paragraph>` actually render now — the wrappers emitted `heading`/
  `paragraph` intrinsics no contributor claims, so heading levels and block
  boundaries were silently dropped; they now emit the claimed `h1`–`h3`/`p`
  (byte-identical to the lowercase intrinsics, pinned). `guard(...)` bags
  of inline verdict literals contextually type without `as const` — the
  decider/bag overload pair collapsed into one union signature. A
  `renderedWith` or caller-pinned formatter ref that matches neither a
  registered id nor a format is now reported as a `formatter-unresolved`
  warning diagnostic (once per distinct ref; the tree still renders through
  the default) — new shared `resolveFormatterRef`/`describeUnresolvedFormatter`
  exports in @agentick/formatters are the one lookup both `formatTree` and
  the compiler harness use, and the mount now binds the harness's real
  default ref instead of a sentinel. `defineSession`'s no-op model handle
  reads `current` as `undefined` (the documented model-less case) instead
  of throwing; writes still reject. Plus: direct unit suites for
  `ulid`/`waitFor`/`waitForStable`, and accurate barrel docblocks for spec
  and eval.

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.15
  - @agentick/compiler-react@1.0.0-next.15
  - @agentick/elicitation@1.0.0-next.15
  - @agentick/gates@1.0.0-next.15
  - @agentick/knobs@1.0.0-next.15
  - @agentick/loop-executor@1.0.0-next.15
  - @agentick/model@1.0.0-next.15
  - @agentick/model-executor@1.0.0-next.15
  - @agentick/pubsub@1.0.0-next.15
  - @agentick/resources@1.0.0-next.15
  - @agentick/runtime@1.0.0-next.15
  - @agentick/spec@1.0.0-next.15
  - @agentick/state@1.0.0-next.15
  - @agentick/store@1.0.0-next.15
  - @agentick/tasks@1.0.0-next.15
  - @agentick/timeline@1.0.0-next.15
  - @agentick/tool-executor@1.0.0-next.15
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
  - @agentick/compiler@1.0.0-next.14
  - @agentick/compiler-react@1.0.0-next.14
  - @agentick/elicitation@1.0.0-next.14
  - @agentick/gates@1.0.0-next.14
  - @agentick/knobs@1.0.0-next.14
  - @agentick/loop-executor@1.0.0-next.14
  - @agentick/model@1.0.0-next.14
  - @agentick/model-executor@1.0.0-next.14
  - @agentick/pubsub@1.0.0-next.14
  - @agentick/resources@1.0.0-next.14
  - @agentick/runtime@1.0.0-next.14
  - @agentick/spec@1.0.0-next.14
  - @agentick/state@1.0.0-next.14
  - @agentick/store@1.0.0-next.14
  - @agentick/tasks@1.0.0-next.14
  - @agentick/timeline@1.0.0-next.14
  - @agentick/tool-executor@1.0.0-next.14
  - @agentick/utils@1.0.0-next.14

## 1.0.0-next.13

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.13
  - @agentick/compiler-react@1.0.0-next.13
  - @agentick/elicitation@1.0.0-next.13
  - @agentick/gates@1.0.0-next.13
  - @agentick/knobs@1.0.0-next.13
  - @agentick/loop-executor@1.0.0-next.13
  - @agentick/model@1.0.0-next.13
  - @agentick/model-executor@1.0.0-next.13
  - @agentick/pubsub@1.0.0-next.13
  - @agentick/resources@1.0.0-next.13
  - @agentick/runtime@1.0.0-next.13
  - @agentick/spec@1.0.0-next.13
  - @agentick/state@1.0.0-next.13
  - @agentick/store@1.0.0-next.13
  - @agentick/tasks@1.0.0-next.13
  - @agentick/timeline@1.0.0-next.13
  - @agentick/tool-executor@1.0.0-next.13
  - @agentick/utils@1.0.0-next.13

## 1.0.0-next.12

### Minor Changes

- ADR 92 Slice B — lifecycle & security mutations join the operation
  grammar. `session:command:spawn` + `app:command:create-child-session`
  (spawn/fork enveloped with parent linkage — `app.guard` can now veto a
  spawn; the ADR 48 `onSessionCreate` behavior unchanged);
  `session:command:close` (bus-only) with idle eviction routed through it
  (`reason: "evicted" | "closed"` — `close()` gains an optional
  `SessionCloseInput`); `live:command:{stop,close}` (in-process teardown
  enveloped; `start` deferred to the sync-return design pass);
  `credentials:command:{set,delete}` under the structural redaction law —
  the secret is never an op input, so no journal record, bus envelope,
  guard, or middleware can observe it (asserted over the full journal +
  bus with fragment checks). New scope dims: `streamId`,
  `credentialNamespace`/`credentialKey`.

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.12
  - @agentick/compiler-react@1.0.0-next.12
  - @agentick/elicitation@1.0.0-next.12
  - @agentick/gates@1.0.0-next.12
  - @agentick/knobs@1.0.0-next.12
  - @agentick/loop-executor@1.0.0-next.12
  - @agentick/model@1.0.0-next.12
  - @agentick/model-executor@1.0.0-next.12
  - @agentick/pubsub@1.0.0-next.12
  - @agentick/resources@1.0.0-next.12
  - @agentick/runtime@1.0.0-next.12
  - @agentick/spec@1.0.0-next.12
  - @agentick/state@1.0.0-next.12
  - @agentick/store@1.0.0-next.12
  - @agentick/tasks@1.0.0-next.12
  - @agentick/timeline@1.0.0-next.12
  - @agentick/tool-executor@1.0.0-next.12
  - @agentick/utils@1.0.0-next.12

## 1.0.0-next.11

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.11
  - @agentick/compiler-react@1.0.0-next.11
  - @agentick/elicitation@1.0.0-next.11
  - @agentick/gates@1.0.0-next.11
  - @agentick/knobs@1.0.0-next.11
  - @agentick/loop-executor@1.0.0-next.11
  - @agentick/model@1.0.0-next.11
  - @agentick/model-executor@1.0.0-next.11
  - @agentick/pubsub@1.0.0-next.11
  - @agentick/resources@1.0.0-next.11
  - @agentick/runtime@1.0.0-next.11
  - @agentick/spec@1.0.0-next.11
  - @agentick/state@1.0.0-next.11
  - @agentick/store@1.0.0-next.11
  - @agentick/tasks@1.0.0-next.11
  - @agentick/timeline@1.0.0-next.11
  - @agentick/tool-executor@1.0.0-next.11
  - @agentick/utils@1.0.0-next.11

## 1.0.0-next.10

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.10
  - @agentick/compiler-react@1.0.0-next.10
  - @agentick/elicitation@1.0.0-next.10
  - @agentick/gates@1.0.0-next.10
  - @agentick/knobs@1.0.0-next.10
  - @agentick/loop-executor@1.0.0-next.10
  - @agentick/model@1.0.0-next.10
  - @agentick/model-executor@1.0.0-next.10
  - @agentick/pubsub@1.0.0-next.10
  - @agentick/resources@1.0.0-next.10
  - @agentick/runtime@1.0.0-next.10
  - @agentick/spec@1.0.0-next.10
  - @agentick/state@1.0.0-next.10
  - @agentick/store@1.0.0-next.10
  - @agentick/tasks@1.0.0-next.10
  - @agentick/timeline@1.0.0-next.10
  - @agentick/tool-executor@1.0.0-next.10
  - @agentick/utils@1.0.0-next.10

## 1.0.0-next.9

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.9
  - @agentick/compiler-react@1.0.0-next.9
  - @agentick/elicitation@1.0.0-next.9
  - @agentick/gates@1.0.0-next.9
  - @agentick/knobs@1.0.0-next.9
  - @agentick/loop-executor@1.0.0-next.9
  - @agentick/model@1.0.0-next.9
  - @agentick/model-executor@1.0.0-next.9
  - @agentick/pubsub@1.0.0-next.9
  - @agentick/resources@1.0.0-next.9
  - @agentick/runtime@1.0.0-next.9
  - @agentick/spec@1.0.0-next.9
  - @agentick/state@1.0.0-next.9
  - @agentick/store@1.0.0-next.9
  - @agentick/tasks@1.0.0-next.9
  - @agentick/timeline@1.0.0-next.9
  - @agentick/tool-executor@1.0.0-next.9
  - @agentick/utils@1.0.0-next.9

## 1.0.0-next.8

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.8
  - @agentick/compiler-react@1.0.0-next.8
  - @agentick/elicitation@1.0.0-next.8
  - @agentick/gates@1.0.0-next.8
  - @agentick/knobs@1.0.0-next.8
  - @agentick/loop-executor@1.0.0-next.8
  - @agentick/model@1.0.0-next.8
  - @agentick/model-executor@1.0.0-next.8
  - @agentick/pubsub@1.0.0-next.8
  - @agentick/resources@1.0.0-next.8
  - @agentick/runtime@1.0.0-next.8
  - @agentick/spec@1.0.0-next.8
  - @agentick/state@1.0.0-next.8
  - @agentick/store@1.0.0-next.8
  - @agentick/tasks@1.0.0-next.8
  - @agentick/timeline@1.0.0-next.8
  - @agentick/tool-executor@1.0.0-next.8
  - @agentick/utils@1.0.0-next.8

## 1.0.0-next.7

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.7
  - @agentick/compiler-react@1.0.0-next.7
  - @agentick/elicitation@1.0.0-next.7
  - @agentick/gates@1.0.0-next.7
  - @agentick/knobs@1.0.0-next.7
  - @agentick/loop-executor@1.0.0-next.7
  - @agentick/model@1.0.0-next.7
  - @agentick/model-executor@1.0.0-next.7
  - @agentick/pubsub@1.0.0-next.7
  - @agentick/resources@1.0.0-next.7
  - @agentick/runtime@1.0.0-next.7
  - @agentick/spec@1.0.0-next.7
  - @agentick/state@1.0.0-next.7
  - @agentick/store@1.0.0-next.7
  - @agentick/tasks@1.0.0-next.7
  - @agentick/timeline@1.0.0-next.7
  - @agentick/tool-executor@1.0.0-next.7
  - @agentick/utils@1.0.0-next.7

## 1.0.0-next.6

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.6
  - @agentick/compiler-react@1.0.0-next.6
  - @agentick/elicitation@1.0.0-next.6
  - @agentick/gates@1.0.0-next.6
  - @agentick/knobs@1.0.0-next.6
  - @agentick/loop-executor@1.0.0-next.6
  - @agentick/model@1.0.0-next.6
  - @agentick/model-executor@1.0.0-next.6
  - @agentick/pubsub@1.0.0-next.6
  - @agentick/resources@1.0.0-next.6
  - @agentick/runtime@1.0.0-next.6
  - @agentick/spec@1.0.0-next.6
  - @agentick/state@1.0.0-next.6
  - @agentick/store@1.0.0-next.6
  - @agentick/tasks@1.0.0-next.6
  - @agentick/timeline@1.0.0-next.6
  - @agentick/tool-executor@1.0.0-next.6
  - @agentick/utils@1.0.0-next.6

## 1.0.0-next.5

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.5
  - @agentick/compiler-react@1.0.0-next.5
  - @agentick/elicitation@1.0.0-next.5
  - @agentick/gates@1.0.0-next.5
  - @agentick/knobs@1.0.0-next.5
  - @agentick/loop-executor@1.0.0-next.5
  - @agentick/model@1.0.0-next.5
  - @agentick/model-executor@1.0.0-next.5
  - @agentick/pubsub@1.0.0-next.5
  - @agentick/resources@1.0.0-next.5
  - @agentick/runtime@1.0.0-next.5
  - @agentick/spec@1.0.0-next.5
  - @agentick/state@1.0.0-next.5
  - @agentick/store@1.0.0-next.5
  - @agentick/tasks@1.0.0-next.5
  - @agentick/timeline@1.0.0-next.5
  - @agentick/tool-executor@1.0.0-next.5
  - @agentick/utils@1.0.0-next.5

## 1.0.0-next.4

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.4
  - @agentick/compiler-react@1.0.0-next.4
  - @agentick/elicitation@1.0.0-next.4
  - @agentick/gates@1.0.0-next.4
  - @agentick/knobs@1.0.0-next.4
  - @agentick/loop-executor@1.0.0-next.4
  - @agentick/model@1.0.0-next.4
  - @agentick/model-executor@1.0.0-next.4
  - @agentick/pubsub@1.0.0-next.4
  - @agentick/resources@1.0.0-next.4
  - @agentick/runtime@1.0.0-next.4
  - @agentick/spec@1.0.0-next.4
  - @agentick/state@1.0.0-next.4
  - @agentick/store@1.0.0-next.4
  - @agentick/tasks@1.0.0-next.4
  - @agentick/timeline@1.0.0-next.4
  - @agentick/tool-executor@1.0.0-next.4
  - @agentick/utils@1.0.0-next.4

## 1.0.0-next.3

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.3
  - @agentick/compiler-react@1.0.0-next.3
  - @agentick/elicitation@1.0.0-next.3
  - @agentick/gates@1.0.0-next.3
  - @agentick/knobs@1.0.0-next.3
  - @agentick/loop-executor@1.0.0-next.3
  - @agentick/model@1.0.0-next.3
  - @agentick/model-executor@1.0.0-next.3
  - @agentick/pubsub@1.0.0-next.3
  - @agentick/resources@1.0.0-next.3
  - @agentick/runtime@1.0.0-next.3
  - @agentick/spec@1.0.0-next.3
  - @agentick/state@1.0.0-next.3
  - @agentick/store@1.0.0-next.3
  - @agentick/tasks@1.0.0-next.3
  - @agentick/timeline@1.0.0-next.3
  - @agentick/tool-executor@1.0.0-next.3
  - @agentick/utils@1.0.0-next.3

## 1.0.0-next.2

### Patch Changes

- Updated dependencies:
  - @agentick/compiler@1.0.0-next.2
  - @agentick/compiler-react@1.0.0-next.2
  - @agentick/elicitation@1.0.0-next.2
  - @agentick/gates@1.0.0-next.2
  - @agentick/knobs@1.0.0-next.2
  - @agentick/loop-executor@1.0.0-next.2
  - @agentick/model@1.0.0-next.2
  - @agentick/model-executor@1.0.0-next.2
  - @agentick/pubsub@1.0.0-next.2
  - @agentick/resources@1.0.0-next.2
  - @agentick/runtime@1.0.0-next.2
  - @agentick/spec@1.0.0-next.2
  - @agentick/state@1.0.0-next.2
  - @agentick/store@1.0.0-next.2
  - @agentick/tasks@1.0.0-next.2
  - @agentick/timeline@1.0.0-next.2
  - @agentick/tool-executor@1.0.0-next.2
  - @agentick/utils@1.0.0-next.2
