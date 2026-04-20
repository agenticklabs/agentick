# @agentick/client-multiplexer

## 0.14.45

### Patch Changes

- @agentick/client@0.14.45

## 0.14.44

### Patch Changes

- @agentick/client@0.14.44

## 0.14.43

### Patch Changes

- @agentick/client@0.14.43

## 0.14.42

### Patch Changes

- @agentick/client@0.14.42

## 0.14.41

### Patch Changes

- @agentick/client@0.14.41

## 0.14.40

### Patch Changes

- @agentick/client@0.14.40

## 0.14.39

### Patch Changes

- @agentick/client@0.14.39

## 0.14.38

### Patch Changes

- @agentick/client@0.14.38

## 0.14.37

### Patch Changes

- @agentick/client@0.14.37

## 0.14.36

### Patch Changes

- @agentick/client@0.14.36

## 0.14.35

### Patch Changes

- @agentick/client@0.14.35

## 0.14.34

### Patch Changes

- @agentick/client@0.14.34

## 0.14.33

### Patch Changes

- @agentick/client@0.14.33

## 0.14.32

### Patch Changes

- @agentick/client@0.14.32

## 0.14.31

### Patch Changes

- @agentick/client@0.14.31

## 0.14.30

### Patch Changes

- @agentick/client@0.14.30

## 0.14.29

### Patch Changes

- @agentick/client@0.14.29

## 0.14.28

### Patch Changes

- @agentick/client@0.14.28

## 0.14.27

### Patch Changes

- @agentick/client@0.14.27

## 0.14.26

### Patch Changes

- @agentick/client@0.14.26

## 0.14.25

### Patch Changes

- @agentick/client@0.14.25

## 0.14.24

### Patch Changes

- @agentick/client@0.14.24

## 0.14.23

### Patch Changes

- @agentick/client@0.14.23

## 0.14.22

### Patch Changes

- @agentick/client@0.14.22

## 0.14.21

### Patch Changes

- @agentick/client@0.14.21

## 0.14.20

### Patch Changes

- @agentick/client@0.14.20

## 0.14.19

### Patch Changes

- @agentick/client@0.14.19

## 0.14.18

### Patch Changes

- @agentick/client@0.14.18

## 0.14.17

### Patch Changes

- Updated dependencies [f27c004]
  - @agentick/client@0.14.17

## 0.14.16

### Patch Changes

- Updated dependencies [59a9281]
  - @agentick/client@0.14.16

## 0.14.15

### Patch Changes

- @agentick/client@0.14.15

## 0.14.14

### Patch Changes

- @agentick/client@0.14.14

## 0.14.13

### Patch Changes

- @agentick/client@0.14.13

## 0.14.12

### Patch Changes

- @agentick/client@0.14.12

## 0.14.11

### Patch Changes

- Updated dependencies [c7d36d3]
  - @agentick/client@0.14.11

## 0.14.10

### Patch Changes

- Updated dependencies [7e117f3]
  - @agentick/client@0.14.10

## 0.14.9

### Patch Changes

- @agentick/client@0.14.9

## 0.14.8

### Patch Changes

- @agentick/client@0.14.8

## 0.14.7

### Patch Changes

- @agentick/client@0.14.7

## 0.14.6

### Patch Changes

- Updated dependencies [6b72302]
  - @agentick/client@0.14.6

## 0.14.5

### Patch Changes

- @agentick/client@0.14.5

## 0.14.4

### Patch Changes

- @agentick/client@0.14.4

## 0.14.3

### Patch Changes

- @agentick/client@0.14.3

## 0.14.2

### Patch Changes

- @agentick/client@0.14.2

## 0.14.1

### Patch Changes

- @agentick/client@0.14.1

## 0.14.0

### Patch Changes

- @agentick/client@0.14.0

## 0.13.2

### Patch Changes

- Updated dependencies [a4464da]
  - @agentick/client@0.13.2

## 0.13.1

### Patch Changes

- Updated dependencies [7a414a0]
  - @agentick/client@0.13.1

## 0.13.0

### Patch Changes

- @agentick/client@0.13.0

## 0.12.3

### Patch Changes

- @agentick/client@0.12.3

## 0.12.2

### Patch Changes

- @agentick/client@0.12.2

## 0.12.1

### Patch Changes

- @agentick/client@0.12.1

## 0.12.0

### Minor Changes

- 2435355: **Breaking**: `TransportEventData` no longer spreads `data` into the top level. Event payloads are now in a structured `data` field.

  Before: `{ type: "content_delta", sessionId: "main", text: "hello", index: 0 }`
  After: `{ type: "content_delta", sessionId: "main", data: { text: "hello", index: 0 } }`

  The `[key: string]: unknown` index signature is removed. This prevents silent property collisions between envelope fields (`type`, `sessionId`) and payload properties, and makes `TransportEventData` a proper typed interface rather than a bag.

  `unwrapEventMessage()` return type changed from `Record<string, unknown>` to `TransportEventData | Record<string, unknown>`.

  **Migration**: Any code accessing payload properties directly on transport events (e.g., `event.delta`, `event.text`) must now access them through `event.data` (e.g., `(event.data as StreamEvent).delta`).

### Patch Changes

- Updated dependencies [2435355]
  - @agentick/client@0.12.0

## 0.11.2

### Patch Changes

- @agentick/client@0.11.2

## 0.11.1

### Patch Changes

- @agentick/client@0.11.1

## 0.11.0

### Patch Changes

- @agentick/client@0.11.0

## 0.10.1

### Patch Changes

- @agentick/client@0.10.1

## 0.10.0

### Patch Changes

- @agentick/client@0.10.0

## 0.9.6

### Patch Changes

- Updated dependencies [84752df]
  - @agentick/client@0.9.6

## 0.9.5

### Patch Changes

- @agentick/client@0.9.5

## 0.9.4

### Patch Changes

- @agentick/client@0.9.4

## 0.9.3

### Patch Changes

- @agentick/client@0.9.3

## 0.9.2

### Patch Changes

- @agentick/client@0.9.2

## 0.9.1

### Patch Changes

- @agentick/client@0.9.1

## 0.9.0

### Patch Changes

- @agentick/client@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [f84c8bb]
  - @agentick/client@0.8.0

## 0.7.0

### Patch Changes

- @agentick/client@0.7.0

## 0.4.1

### Patch Changes

- Updated dependencies [75960dd]
- Updated dependencies [e30960c]
- Updated dependencies [0350de3]
  - @agentick/client@0.5.0

## 0.4.0

### Minor Changes

- 842f92c: Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies [842f92c]
  - @agentick/client@0.4.0

## 0.2.1

### Patch Changes

- @agentick/client@0.2.1

## 0.2.0

### Minor Changes

- a9cf566: agentick convenience package now re-exports @agentick/agent and @agentick/guardrails. One install, one import source.

### Patch Changes

- Updated dependencies [a9cf566]
  - @agentick/client@0.2.0

## 0.1.9

### Patch Changes

- 3f5f0be: Add documentation website (VitePress + TypeDoc), AGENTS.md for cross-agent discovery, and agent skills for common development tasks.
- Updated dependencies [3f5f0be]
  - @agentick/client@0.1.9
