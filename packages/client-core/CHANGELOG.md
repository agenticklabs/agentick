# @agentick/client-core

## 1.0.0-next.20

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.20
  - @agentick/runtime@1.0.0-next.20
  - @agentick/spec@1.0.0-next.20
  - @agentick/utils@1.0.0-next.20

## 1.0.0-next.19

### Minor Changes

- Say which client to install. `@agentick/client` already carries every
  built-in capability's client surface — `session.timeline`,
  `session.tools`, `session.knobs` and the rest are registered by
  importing it, with nothing to wire — while `@agentick/client-core` is
  the lean core where you register each capability yourself. Nothing said
  so. The first real consumer installed the core, hand-rolled five
  `import "@agentick/<x>/client"` lines, missed one, and spent time
  chasing a `tools/list` method-not-found at a server that was fine.

  The fix is that both READMEs now state the choice in their first lines
  — install `@agentick/client`; drop to the core only to trim a bundle —
  and `createClient`'s own doc comment names the tradeoff at the point of
  use, so the zero-config path is the one you find first.

  Behind that, reading a capability slot you never registered now throws
  `SessionSubHandleNotRegistered` instead of silently synthesizing a wire
  namespace that fails at the first call; the message leads with
  "install @agentick/client" and gives the single import as the
  deliberate-lean-core alternative. Client-core gains no harness
  dependency for it — a module-private dictionary of slot name →
  `/client` specifier (string literals only), read on the one path where
  synthesis would otherwise have happened, checked against the live
  registry in both directions by an anti-rot test in `@agentick/client`.
  Unknown names keep synthesizing (the gateway-porcelain
  `session.billing.approve` case), and only property reads throw:
  `"tools" in session`, `Object.keys`, and util.inspect report absence,
  so logging a session is always safe.

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
  - @agentick/pubsub@1.0.0-next.19
  - @agentick/runtime@1.0.0-next.19
  - @agentick/spec@1.0.0-next.19
  - @agentick/utils@1.0.0-next.19

## 1.0.0-next.18

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.18
  - @agentick/runtime@1.0.0-next.18
  - @agentick/spec@1.0.0-next.18
  - @agentick/utils@1.0.0-next.18

## 1.0.0-next.17

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.17
  - @agentick/runtime@1.0.0-next.17
  - @agentick/spec@1.0.0-next.17
  - @agentick/utils@1.0.0-next.17

## 1.0.0-next.16

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.16
  - @agentick/runtime@1.0.0-next.16
  - @agentick/spec@1.0.0-next.16
  - @agentick/utils@1.0.0-next.16

## 1.0.0-next.15

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.15
  - @agentick/runtime@1.0.0-next.15
  - @agentick/spec@1.0.0-next.15
  - @agentick/utils@1.0.0-next.15

## 1.0.0-next.14

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.14
  - @agentick/runtime@1.0.0-next.14
  - @agentick/spec@1.0.0-next.14
  - @agentick/utils@1.0.0-next.14

## 1.0.0-next.13

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.13
  - @agentick/runtime@1.0.0-next.13
  - @agentick/spec@1.0.0-next.13
  - @agentick/utils@1.0.0-next.13

## 1.0.0-next.12

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.12
  - @agentick/runtime@1.0.0-next.12
  - @agentick/spec@1.0.0-next.12
  - @agentick/utils@1.0.0-next.12

## 1.0.0-next.11

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.11
  - @agentick/runtime@1.0.0-next.11
  - @agentick/spec@1.0.0-next.11
  - @agentick/utils@1.0.0-next.11

## 1.0.0-next.10

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.10
  - @agentick/runtime@1.0.0-next.10
  - @agentick/spec@1.0.0-next.10
  - @agentick/utils@1.0.0-next.10

## 1.0.0-next.9

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.9
  - @agentick/runtime@1.0.0-next.9
  - @agentick/spec@1.0.0-next.9
  - @agentick/utils@1.0.0-next.9

## 1.0.0-next.8

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.8
  - @agentick/runtime@1.0.0-next.8
  - @agentick/spec@1.0.0-next.8
  - @agentick/utils@1.0.0-next.8

## 1.0.0-next.7

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.7
  - @agentick/runtime@1.0.0-next.7
  - @agentick/spec@1.0.0-next.7
  - @agentick/utils@1.0.0-next.7

## 1.0.0-next.6

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.6
  - @agentick/runtime@1.0.0-next.6
  - @agentick/spec@1.0.0-next.6
  - @agentick/utils@1.0.0-next.6

## 1.0.0-next.5

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.5
  - @agentick/runtime@1.0.0-next.5
  - @agentick/spec@1.0.0-next.5
  - @agentick/utils@1.0.0-next.5

## 1.0.0-next.4

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.4
  - @agentick/runtime@1.0.0-next.4
  - @agentick/spec@1.0.0-next.4
  - @agentick/utils@1.0.0-next.4

## 1.0.0-next.3

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.3
  - @agentick/runtime@1.0.0-next.3
  - @agentick/spec@1.0.0-next.3
  - @agentick/utils@1.0.0-next.3

## 1.0.0-next.2

### Patch Changes

- Updated dependencies:
  - @agentick/pubsub@1.0.0-next.2
  - @agentick/runtime@1.0.0-next.2
  - @agentick/spec@1.0.0-next.2
  - @agentick/utils@1.0.0-next.2
