# @agentick/transport

## 1.0.0-next.19

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.19
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
  - @agentick/pubsub@1.0.0-next.18
  - @agentick/spec@1.0.0-next.18
  - @agentick/utils@1.0.0-next.18

## 1.0.0-next.17

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.17
  - @agentick/spec@1.0.0-next.17
  - @agentick/utils@1.0.0-next.17

## 1.0.0-next.16

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.16
  - @agentick/spec@1.0.0-next.16
  - @agentick/utils@1.0.0-next.16

## 1.0.0-next.15

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.15
  - @agentick/spec@1.0.0-next.15
  - @agentick/utils@1.0.0-next.15

## 1.0.0-next.14

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.14
  - @agentick/spec@1.0.0-next.14
  - @agentick/utils@1.0.0-next.14

## 1.0.0-next.13

### Minor Changes

- Transport hardening, thirteen findings fixed test-first. Security:
  DELETE now authenticates like POST/GET (http); authentication gained a
  wall-clock ceiling at the shared ingress seam (default 10s,
  `authnTimeoutMs` per edge, `Infinity` opts out) — a hung AuthSource
  refuses instead of leaking the request/socket. Correctness: in-process
  client→server notifications now route (cancellation actually aborts
  server-side work); a real per-connection context replaces the no-op
  sink (teardown releases server-side subscriptions);
  `sub/unsubscribe` now RUNS cleanups instead of forgetting them (leaked
  on every transport). Unix socket: bind errors are claimed
  (`listening()` — stale socket files no longer crash the process),
  NDJSON lines capped (`maxLineBytes`, default 16 MiB, typed
  frame-too-large + close), connect failures are typed Errors
  (`transportError`), socket failures reportable via `onFailure` (quiet
  by default). Honest capabilities: `binaryFrames` reflects `wireParity`;
  the websocket package description no longer advertises unshipped
  features.

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.13
  - @agentick/spec@1.0.0-next.13
  - @agentick/utils@1.0.0-next.13

## 1.0.0-next.12

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.12
  - @agentick/spec@1.0.0-next.12
  - @agentick/utils@1.0.0-next.12

## 1.0.0-next.11

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.11
  - @agentick/spec@1.0.0-next.11
  - @agentick/utils@1.0.0-next.11

## 1.0.0-next.10

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.10
  - @agentick/spec@1.0.0-next.10
  - @agentick/utils@1.0.0-next.10

## 1.0.0-next.9

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.9
  - @agentick/spec@1.0.0-next.9
  - @agentick/utils@1.0.0-next.9

## 1.0.0-next.8

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.8
  - @agentick/spec@1.0.0-next.8
  - @agentick/utils@1.0.0-next.8

## 1.0.0-next.7

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.7
  - @agentick/spec@1.0.0-next.7
  - @agentick/utils@1.0.0-next.7

## 1.0.0-next.6

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.6
  - @agentick/spec@1.0.0-next.6
  - @agentick/utils@1.0.0-next.6

## 1.0.0-next.5

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.5
  - @agentick/spec@1.0.0-next.5
  - @agentick/utils@1.0.0-next.5

## 1.0.0-next.4

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.4
  - @agentick/spec@1.0.0-next.4
  - @agentick/utils@1.0.0-next.4

## 1.0.0-next.3

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.3
  - @agentick/spec@1.0.0-next.3
  - @agentick/utils@1.0.0-next.3

## 1.0.0-next.2

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.2
  - @agentick/spec@1.0.0-next.2
  - @agentick/utils@1.0.0-next.2
