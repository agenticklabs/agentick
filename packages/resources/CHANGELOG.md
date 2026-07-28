# @agentick/resources

## 1.0.0-next.20

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.20
  - @agentick/compiler-react@1.0.0-next.20
  - @agentick/pubsub@1.0.0-next.20
  - @agentick/runtime@1.0.0-next.20
  - @agentick/spec@1.0.0-next.20
  - @agentick/store@1.0.0-next.20
  - @agentick/utils@1.0.0-next.20

## 1.0.0-next.19

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
  - @agentick/compiler-react@1.0.0-next.19
  - @agentick/pubsub@1.0.0-next.19
  - @agentick/runtime@1.0.0-next.19
  - @agentick/spec@1.0.0-next.19
  - @agentick/store@1.0.0-next.19
  - @agentick/utils@1.0.0-next.19

## 1.0.0-next.18

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.18
  - @agentick/compiler-react@1.0.0-next.18
  - @agentick/pubsub@1.0.0-next.18
  - @agentick/runtime@1.0.0-next.18
  - @agentick/spec@1.0.0-next.18
  - @agentick/store@1.0.0-next.18
  - @agentick/utils@1.0.0-next.18

## 1.0.0-next.17

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.17
  - @agentick/compiler-react@1.0.0-next.17
  - @agentick/pubsub@1.0.0-next.17
  - @agentick/runtime@1.0.0-next.17
  - @agentick/spec@1.0.0-next.17
  - @agentick/store@1.0.0-next.17
  - @agentick/utils@1.0.0-next.17

## 1.0.0-next.16

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.16
  - @agentick/compiler-react@1.0.0-next.16
  - @agentick/pubsub@1.0.0-next.16
  - @agentick/runtime@1.0.0-next.16
  - @agentick/spec@1.0.0-next.16
  - @agentick/store@1.0.0-next.16
  - @agentick/utils@1.0.0-next.16

## 1.0.0-next.15

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.15
  - @agentick/compiler-react@1.0.0-next.15
  - @agentick/pubsub@1.0.0-next.15
  - @agentick/runtime@1.0.0-next.15
  - @agentick/spec@1.0.0-next.15
  - @agentick/store@1.0.0-next.15
  - @agentick/utils@1.0.0-next.15

## 1.0.0-next.14

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.14
  - @agentick/compiler-react@1.0.0-next.14
  - @agentick/pubsub@1.0.0-next.14
  - @agentick/runtime@1.0.0-next.14
  - @agentick/spec@1.0.0-next.14
  - @agentick/store@1.0.0-next.14
  - @agentick/utils@1.0.0-next.14

## 1.0.0-next.13

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.13
  - @agentick/compiler-react@1.0.0-next.13
  - @agentick/pubsub@1.0.0-next.13
  - @agentick/runtime@1.0.0-next.13
  - @agentick/spec@1.0.0-next.13
  - @agentick/store@1.0.0-next.13
  - @agentick/utils@1.0.0-next.13

## 1.0.0-next.12

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.12
  - @agentick/compiler-react@1.0.0-next.12
  - @agentick/pubsub@1.0.0-next.12
  - @agentick/runtime@1.0.0-next.12
  - @agentick/spec@1.0.0-next.12
  - @agentick/store@1.0.0-next.12
  - @agentick/utils@1.0.0-next.12

## 1.0.0-next.11

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.11
  - @agentick/compiler-react@1.0.0-next.11
  - @agentick/pubsub@1.0.0-next.11
  - @agentick/runtime@1.0.0-next.11
  - @agentick/spec@1.0.0-next.11
  - @agentick/store@1.0.0-next.11
  - @agentick/utils@1.0.0-next.11

## 1.0.0-next.10

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.10
  - @agentick/compiler-react@1.0.0-next.10
  - @agentick/pubsub@1.0.0-next.10
  - @agentick/runtime@1.0.0-next.10
  - @agentick/spec@1.0.0-next.10
  - @agentick/store@1.0.0-next.10
  - @agentick/utils@1.0.0-next.10

## 1.0.0-next.9

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.9
  - @agentick/compiler-react@1.0.0-next.9
  - @agentick/pubsub@1.0.0-next.9
  - @agentick/runtime@1.0.0-next.9
  - @agentick/spec@1.0.0-next.9
  - @agentick/store@1.0.0-next.9
  - @agentick/utils@1.0.0-next.9

## 1.0.0-next.8

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.8
  - @agentick/compiler-react@1.0.0-next.8
  - @agentick/pubsub@1.0.0-next.8
  - @agentick/runtime@1.0.0-next.8
  - @agentick/spec@1.0.0-next.8
  - @agentick/store@1.0.0-next.8
  - @agentick/utils@1.0.0-next.8

## 1.0.0-next.7

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.7
  - @agentick/compiler-react@1.0.0-next.7
  - @agentick/pubsub@1.0.0-next.7
  - @agentick/runtime@1.0.0-next.7
  - @agentick/spec@1.0.0-next.7
  - @agentick/store@1.0.0-next.7
  - @agentick/utils@1.0.0-next.7

## 1.0.0-next.6

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.6
  - @agentick/compiler-react@1.0.0-next.6
  - @agentick/pubsub@1.0.0-next.6
  - @agentick/runtime@1.0.0-next.6
  - @agentick/spec@1.0.0-next.6
  - @agentick/store@1.0.0-next.6
  - @agentick/utils@1.0.0-next.6

## 1.0.0-next.5

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.5
  - @agentick/compiler-react@1.0.0-next.5
  - @agentick/pubsub@1.0.0-next.5
  - @agentick/runtime@1.0.0-next.5
  - @agentick/spec@1.0.0-next.5
  - @agentick/store@1.0.0-next.5
  - @agentick/utils@1.0.0-next.5

## 1.0.0-next.4

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.4
  - @agentick/compiler-react@1.0.0-next.4
  - @agentick/pubsub@1.0.0-next.4
  - @agentick/runtime@1.0.0-next.4
  - @agentick/spec@1.0.0-next.4
  - @agentick/store@1.0.0-next.4
  - @agentick/utils@1.0.0-next.4

## 1.0.0-next.3

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.3
  - @agentick/compiler-react@1.0.0-next.3
  - @agentick/pubsub@1.0.0-next.3
  - @agentick/runtime@1.0.0-next.3
  - @agentick/spec@1.0.0-next.3
  - @agentick/store@1.0.0-next.3
  - @agentick/utils@1.0.0-next.3

## 1.0.0-next.2

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.2
  - @agentick/compiler-react@1.0.0-next.2
  - @agentick/pubsub@1.0.0-next.2
  - @agentick/runtime@1.0.0-next.2
  - @agentick/spec@1.0.0-next.2
  - @agentick/store@1.0.0-next.2
  - @agentick/utils@1.0.0-next.2
