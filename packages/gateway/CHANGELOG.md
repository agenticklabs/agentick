# @agentick/gateway

## 1.0.0-next.20

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.20
  - @agentick/cluster@1.0.0-next.20
  - @agentick/runtime@1.0.0-next.20
  - @agentick/spec@1.0.0-next.20
  - @agentick/utils@1.0.0-next.20

## 1.0.0-next.19

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.19
  - @agentick/cluster@1.0.0-next.19
  - @agentick/runtime@1.0.0-next.19
  - @agentick/spec@1.0.0-next.19
  - @agentick/utils@1.0.0-next.19

## 1.0.0-next.18

### Minor Changes

- A progress token's stream now ends. `ProgressReporter.close()` sends
  `notifications/progress/complete` (token only — a bounded stream reaching
  its end is not a failure, which is why it is not
  `notifications/subscription/closed`); the client transport closes the
  matching stream on receipt, which ends the consumer's iterator and reaps
  the token's registration.

  Two bugs die with it: a client `handle.events()` loop no longer hangs on
  a `next()` that will never resolve, and a completed `session/send` no
  longer leaves its token in the transport's `progressStreams` map — the
  registration leak.

  The gateway's `session/send` arms the marker behind BOTH progress
  fan-outs (execution events and ADR 64 signals) draining, so it can never
  race the last pushed frame — and does it in a detached continuation, so
  the RPC response is not held behind a slow tail frame. Pinned by a
  no-drop test: a deliberately slow consumer still receives every frame,
  including the terminal `result`, because `MultiplexedStream` empties its
  buffer before signalling done.

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.18
  - @agentick/cluster@1.0.0-next.18
  - @agentick/runtime@1.0.0-next.18
  - @agentick/spec@1.0.0-next.18
  - @agentick/utils@1.0.0-next.18

## 1.0.0-next.17

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.17
  - @agentick/cluster@1.0.0-next.17
  - @agentick/runtime@1.0.0-next.17
  - @agentick/spec@1.0.0-next.17
  - @agentick/utils@1.0.0-next.17

## 1.0.0-next.16

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.16
  - @agentick/cluster@1.0.0-next.16
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
  - @agentick/app@1.0.0-next.15
  - @agentick/cluster@1.0.0-next.15
  - @agentick/runtime@1.0.0-next.15
  - @agentick/spec@1.0.0-next.15
  - @agentick/utils@1.0.0-next.15

## 1.0.0-next.14

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.14
  - @agentick/cluster@1.0.0-next.14
  - @agentick/runtime@1.0.0-next.14
  - @agentick/spec@1.0.0-next.14
  - @agentick/utils@1.0.0-next.14

## 1.0.0-next.13

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.13
  - @agentick/cluster@1.0.0-next.13
  - @agentick/runtime@1.0.0-next.13
  - @agentick/spec@1.0.0-next.13
  - @agentick/utils@1.0.0-next.13

## 1.0.0-next.12

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.12
  - @agentick/cluster@1.0.0-next.12
  - @agentick/runtime@1.0.0-next.12
  - @agentick/spec@1.0.0-next.12
  - @agentick/utils@1.0.0-next.12

## 1.0.0-next.11

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.11
  - @agentick/cluster@1.0.0-next.11
  - @agentick/runtime@1.0.0-next.11
  - @agentick/spec@1.0.0-next.11
  - @agentick/utils@1.0.0-next.11

## 1.0.0-next.10

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.10
  - @agentick/cluster@1.0.0-next.10
  - @agentick/runtime@1.0.0-next.10
  - @agentick/spec@1.0.0-next.10
  - @agentick/utils@1.0.0-next.10

## 1.0.0-next.9

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.9
  - @agentick/cluster@1.0.0-next.9
  - @agentick/runtime@1.0.0-next.9
  - @agentick/spec@1.0.0-next.9
  - @agentick/utils@1.0.0-next.9

## 1.0.0-next.8

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.8
  - @agentick/cluster@1.0.0-next.8
  - @agentick/runtime@1.0.0-next.8
  - @agentick/spec@1.0.0-next.8
  - @agentick/utils@1.0.0-next.8

## 1.0.0-next.7

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.7
  - @agentick/cluster@1.0.0-next.7
  - @agentick/runtime@1.0.0-next.7
  - @agentick/spec@1.0.0-next.7
  - @agentick/utils@1.0.0-next.7

## 1.0.0-next.6

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.6
  - @agentick/cluster@1.0.0-next.6
  - @agentick/runtime@1.0.0-next.6
  - @agentick/spec@1.0.0-next.6
  - @agentick/utils@1.0.0-next.6

## 1.0.0-next.5

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.5
  - @agentick/cluster@1.0.0-next.5
  - @agentick/runtime@1.0.0-next.5
  - @agentick/spec@1.0.0-next.5
  - @agentick/utils@1.0.0-next.5

## 1.0.0-next.4

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.4
  - @agentick/cluster@1.0.0-next.4
  - @agentick/runtime@1.0.0-next.4
  - @agentick/spec@1.0.0-next.4
  - @agentick/utils@1.0.0-next.4

## 1.0.0-next.3

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.3
  - @agentick/cluster@1.0.0-next.3
  - @agentick/runtime@1.0.0-next.3
  - @agentick/spec@1.0.0-next.3
  - @agentick/utils@1.0.0-next.3

## 1.0.0-next.2

### Patch Changes

- Updated dependencies:
  - @agentick/app@1.0.0-next.2
  - @agentick/cluster@1.0.0-next.2
  - @agentick/runtime@1.0.0-next.2
  - @agentick/spec@1.0.0-next.2
  - @agentick/utils@1.0.0-next.2
