# @agentick/client

## 1.0.0-next.21

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.21
  - @agentick/elicitation@1.0.0-next.21
  - @agentick/gates@1.0.0-next.21
  - @agentick/knobs@1.0.0-next.21
  - @agentick/prompts@1.0.0-next.21
  - @agentick/resources@1.0.0-next.21
  - @agentick/skills@1.0.0-next.21
  - @agentick/state@1.0.0-next.21
  - @agentick/tasks@1.0.0-next.21
  - @agentick/timeline@1.0.0-next.21
  - @agentick/tool-executor@1.0.0-next.21

## 1.0.0-next.20

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.20
  - @agentick/elicitation@1.0.0-next.20
  - @agentick/gates@1.0.0-next.20
  - @agentick/knobs@1.0.0-next.20
  - @agentick/prompts@1.0.0-next.20
  - @agentick/resources@1.0.0-next.20
  - @agentick/skills@1.0.0-next.20
  - @agentick/state@1.0.0-next.20
  - @agentick/tasks@1.0.0-next.20
  - @agentick/timeline@1.0.0-next.20
  - @agentick/tool-executor@1.0.0-next.20

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

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.19
  - @agentick/elicitation@1.0.0-next.19
  - @agentick/gates@1.0.0-next.19
  - @agentick/knobs@1.0.0-next.19
  - @agentick/prompts@1.0.0-next.19
  - @agentick/resources@1.0.0-next.19
  - @agentick/skills@1.0.0-next.19
  - @agentick/state@1.0.0-next.19
  - @agentick/tasks@1.0.0-next.19
  - @agentick/timeline@1.0.0-next.19
  - @agentick/tool-executor@1.0.0-next.19

## 1.0.0-next.18

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.18
  - @agentick/elicitation@1.0.0-next.18
  - @agentick/gates@1.0.0-next.18
  - @agentick/knobs@1.0.0-next.18
  - @agentick/prompts@1.0.0-next.18
  - @agentick/resources@1.0.0-next.18
  - @agentick/skills@1.0.0-next.18
  - @agentick/state@1.0.0-next.18
  - @agentick/tasks@1.0.0-next.18
  - @agentick/timeline@1.0.0-next.18
  - @agentick/tool-executor@1.0.0-next.18

## 1.0.0-next.17

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.17
  - @agentick/elicitation@1.0.0-next.17
  - @agentick/gates@1.0.0-next.17
  - @agentick/knobs@1.0.0-next.17
  - @agentick/prompts@1.0.0-next.17
  - @agentick/resources@1.0.0-next.17
  - @agentick/skills@1.0.0-next.17
  - @agentick/state@1.0.0-next.17
  - @agentick/tasks@1.0.0-next.17
  - @agentick/timeline@1.0.0-next.17
  - @agentick/tool-executor@1.0.0-next.17

## 1.0.0-next.16

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.16
  - @agentick/elicitation@1.0.0-next.16
  - @agentick/gates@1.0.0-next.16
  - @agentick/knobs@1.0.0-next.16
  - @agentick/prompts@1.0.0-next.16
  - @agentick/resources@1.0.0-next.16
  - @agentick/skills@1.0.0-next.16
  - @agentick/state@1.0.0-next.16
  - @agentick/tasks@1.0.0-next.16
  - @agentick/timeline@1.0.0-next.16
  - @agentick/tool-executor@1.0.0-next.16

## 1.0.0-next.15

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.15
  - @agentick/elicitation@1.0.0-next.15
  - @agentick/gates@1.0.0-next.15
  - @agentick/knobs@1.0.0-next.15
  - @agentick/prompts@1.0.0-next.15
  - @agentick/resources@1.0.0-next.15
  - @agentick/skills@1.0.0-next.15
  - @agentick/state@1.0.0-next.15
  - @agentick/tasks@1.0.0-next.15
  - @agentick/timeline@1.0.0-next.15
  - @agentick/tool-executor@1.0.0-next.15

## 1.0.0-next.14

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.14
  - @agentick/elicitation@1.0.0-next.14
  - @agentick/gates@1.0.0-next.14
  - @agentick/knobs@1.0.0-next.14
  - @agentick/prompts@1.0.0-next.14
  - @agentick/resources@1.0.0-next.14
  - @agentick/skills@1.0.0-next.14
  - @agentick/state@1.0.0-next.14
  - @agentick/tasks@1.0.0-next.14
  - @agentick/timeline@1.0.0-next.14
  - @agentick/tool-executor@1.0.0-next.14

## 1.0.0-next.13

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.13
  - @agentick/elicitation@1.0.0-next.13
  - @agentick/gates@1.0.0-next.13
  - @agentick/knobs@1.0.0-next.13
  - @agentick/prompts@1.0.0-next.13
  - @agentick/resources@1.0.0-next.13
  - @agentick/skills@1.0.0-next.13
  - @agentick/state@1.0.0-next.13
  - @agentick/tasks@1.0.0-next.13
  - @agentick/timeline@1.0.0-next.13
  - @agentick/tool-executor@1.0.0-next.13

## 1.0.0-next.12

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.12
  - @agentick/elicitation@1.0.0-next.12
  - @agentick/gates@1.0.0-next.12
  - @agentick/knobs@1.0.0-next.12
  - @agentick/prompts@1.0.0-next.12
  - @agentick/resources@1.0.0-next.12
  - @agentick/skills@1.0.0-next.12
  - @agentick/state@1.0.0-next.12
  - @agentick/tasks@1.0.0-next.12
  - @agentick/timeline@1.0.0-next.12
  - @agentick/tool-executor@1.0.0-next.12

## 1.0.0-next.11

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.11
  - @agentick/elicitation@1.0.0-next.11
  - @agentick/gates@1.0.0-next.11
  - @agentick/knobs@1.0.0-next.11
  - @agentick/prompts@1.0.0-next.11
  - @agentick/resources@1.0.0-next.11
  - @agentick/skills@1.0.0-next.11
  - @agentick/state@1.0.0-next.11
  - @agentick/tasks@1.0.0-next.11
  - @agentick/timeline@1.0.0-next.11
  - @agentick/tool-executor@1.0.0-next.11

## 1.0.0-next.10

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.10
  - @agentick/elicitation@1.0.0-next.10
  - @agentick/gates@1.0.0-next.10
  - @agentick/knobs@1.0.0-next.10
  - @agentick/prompts@1.0.0-next.10
  - @agentick/resources@1.0.0-next.10
  - @agentick/skills@1.0.0-next.10
  - @agentick/state@1.0.0-next.10
  - @agentick/tasks@1.0.0-next.10
  - @agentick/timeline@1.0.0-next.10
  - @agentick/tool-executor@1.0.0-next.10

## 1.0.0-next.9

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.9
  - @agentick/elicitation@1.0.0-next.9
  - @agentick/gates@1.0.0-next.9
  - @agentick/knobs@1.0.0-next.9
  - @agentick/prompts@1.0.0-next.9
  - @agentick/resources@1.0.0-next.9
  - @agentick/skills@1.0.0-next.9
  - @agentick/state@1.0.0-next.9
  - @agentick/tasks@1.0.0-next.9
  - @agentick/timeline@1.0.0-next.9
  - @agentick/tool-executor@1.0.0-next.9

## 1.0.0-next.8

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.8
  - @agentick/elicitation@1.0.0-next.8
  - @agentick/gates@1.0.0-next.8
  - @agentick/knobs@1.0.0-next.8
  - @agentick/prompts@1.0.0-next.8
  - @agentick/resources@1.0.0-next.8
  - @agentick/skills@1.0.0-next.8
  - @agentick/state@1.0.0-next.8
  - @agentick/tasks@1.0.0-next.8
  - @agentick/timeline@1.0.0-next.8
  - @agentick/tool-executor@1.0.0-next.8

## 1.0.0-next.7

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.7
  - @agentick/elicitation@1.0.0-next.7
  - @agentick/gates@1.0.0-next.7
  - @agentick/knobs@1.0.0-next.7
  - @agentick/prompts@1.0.0-next.7
  - @agentick/resources@1.0.0-next.7
  - @agentick/skills@1.0.0-next.7
  - @agentick/state@1.0.0-next.7
  - @agentick/tasks@1.0.0-next.7
  - @agentick/timeline@1.0.0-next.7
  - @agentick/tool-executor@1.0.0-next.7

## 1.0.0-next.6

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.6
  - @agentick/elicitation@1.0.0-next.6
  - @agentick/gates@1.0.0-next.6
  - @agentick/knobs@1.0.0-next.6
  - @agentick/prompts@1.0.0-next.6
  - @agentick/resources@1.0.0-next.6
  - @agentick/skills@1.0.0-next.6
  - @agentick/state@1.0.0-next.6
  - @agentick/tasks@1.0.0-next.6
  - @agentick/timeline@1.0.0-next.6
  - @agentick/tool-executor@1.0.0-next.6

## 1.0.0-next.5

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.5
  - @agentick/elicitation@1.0.0-next.5
  - @agentick/gates@1.0.0-next.5
  - @agentick/knobs@1.0.0-next.5
  - @agentick/prompts@1.0.0-next.5
  - @agentick/resources@1.0.0-next.5
  - @agentick/skills@1.0.0-next.5
  - @agentick/state@1.0.0-next.5
  - @agentick/tasks@1.0.0-next.5
  - @agentick/timeline@1.0.0-next.5
  - @agentick/tool-executor@1.0.0-next.5

## 1.0.0-next.4

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.4
  - @agentick/elicitation@1.0.0-next.4
  - @agentick/gates@1.0.0-next.4
  - @agentick/knobs@1.0.0-next.4
  - @agentick/prompts@1.0.0-next.4
  - @agentick/resources@1.0.0-next.4
  - @agentick/skills@1.0.0-next.4
  - @agentick/state@1.0.0-next.4
  - @agentick/tasks@1.0.0-next.4
  - @agentick/timeline@1.0.0-next.4
  - @agentick/tool-executor@1.0.0-next.4

## 1.0.0-next.3

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.3
  - @agentick/elicitation@1.0.0-next.3
  - @agentick/gates@1.0.0-next.3
  - @agentick/knobs@1.0.0-next.3
  - @agentick/prompts@1.0.0-next.3
  - @agentick/resources@1.0.0-next.3
  - @agentick/skills@1.0.0-next.3
  - @agentick/state@1.0.0-next.3
  - @agentick/tasks@1.0.0-next.3
  - @agentick/timeline@1.0.0-next.3
  - @agentick/tool-executor@1.0.0-next.3

## 1.0.0-next.2

### Patch Changes

- Updated dependencies:
  - @agentick/client-core@1.0.0-next.2
  - @agentick/elicitation@1.0.0-next.2
  - @agentick/gates@1.0.0-next.2
  - @agentick/knobs@1.0.0-next.2
  - @agentick/prompts@1.0.0-next.2
  - @agentick/resources@1.0.0-next.2
  - @agentick/skills@1.0.0-next.2
  - @agentick/state@1.0.0-next.2
  - @agentick/tasks@1.0.0-next.2
  - @agentick/timeline@1.0.0-next.2
  - @agentick/tool-executor@1.0.0-next.2
