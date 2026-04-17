# @agentick/openai

## 0.14.41

### Patch Changes

- Updated dependencies [86f043a]
  - @agentick/core@0.14.41
  - @agentick/shared@0.14.41

## 0.14.40

### Patch Changes

- @agentick/core@0.14.40
- @agentick/shared@0.14.40

## 0.14.39

### Patch Changes

- @agentick/shared@0.14.39
- @agentick/core@0.14.39

## 0.14.38

### Patch Changes

- @agentick/core@0.14.38
- @agentick/shared@0.14.38

## 0.14.37

### Patch Changes

- @agentick/core@0.14.37
- @agentick/shared@0.14.37

## 0.14.36

### Patch Changes

- Updated dependencies [e4aa633]
  - @agentick/core@0.14.36
  - @agentick/shared@0.14.36

## 0.14.35

### Patch Changes

- @agentick/shared@0.14.35
- @agentick/core@0.14.35

## 0.14.34

### Patch Changes

- @agentick/core@0.14.34
- @agentick/shared@0.14.34

## 0.14.33

### Patch Changes

- @agentick/shared@0.14.33
- @agentick/core@0.14.33

## 0.14.32

### Patch Changes

- @agentick/core@0.14.32
- @agentick/shared@0.14.32

## 0.14.31

### Patch Changes

- @agentick/shared@0.14.31
- @agentick/core@0.14.31

## 0.14.30

### Patch Changes

- Updated dependencies [29ddb7a]
  - @agentick/core@0.14.30
  - @agentick/shared@0.14.30

## 0.14.29

### Patch Changes

- Updated dependencies [d8b1984]
  - @agentick/core@0.14.29
  - @agentick/shared@0.14.29

## 0.14.28

### Patch Changes

- @agentick/shared@0.14.28
- @agentick/core@0.14.28

## 0.14.27

### Patch Changes

- @agentick/shared@0.14.27
- @agentick/core@0.14.27

## 0.14.26

### Patch Changes

- @agentick/shared@0.14.26
- @agentick/core@0.14.26

## 0.14.25

### Patch Changes

- Updated dependencies [b602b9b]
  - @agentick/core@0.14.25
  - @agentick/shared@0.14.25

## 0.14.24

### Patch Changes

- @agentick/shared@0.14.24
- @agentick/core@0.14.24

## 0.14.23

### Patch Changes

- @agentick/shared@0.14.23
- @agentick/core@0.14.23

## 0.14.22

### Patch Changes

- @agentick/shared@0.14.22
- @agentick/core@0.14.22

## 0.14.21

### Patch Changes

- @agentick/shared@0.14.21
- @agentick/core@0.14.21

## 0.14.20

### Patch Changes

- @agentick/shared@0.14.20
- @agentick/core@0.14.20

## 0.14.19

### Patch Changes

- @agentick/shared@0.14.19
- @agentick/core@0.14.19

## 0.14.18

### Patch Changes

- @agentick/shared@0.14.18
- @agentick/core@0.14.18

## 0.14.17

### Patch Changes

- @agentick/shared@0.14.17
- @agentick/core@0.14.17

## 0.14.16

### Patch Changes

- Updated dependencies [59a9281]
  - @agentick/core@0.14.16
  - @agentick/shared@0.14.16

## 0.14.15

### Patch Changes

- @agentick/shared@0.14.15
- @agentick/core@0.14.15

## 0.14.14

### Patch Changes

- @agentick/shared@0.14.14
- @agentick/core@0.14.14

## 0.14.13

### Patch Changes

- @agentick/shared@0.14.13
- @agentick/core@0.14.13

## 0.14.12

### Patch Changes

- Updated dependencies [04451f0]
  - @agentick/core@0.14.12
  - @agentick/shared@0.14.12

## 0.14.11

### Patch Changes

- @agentick/shared@0.14.11
- @agentick/core@0.14.11

## 0.14.10

### Patch Changes

- @agentick/shared@0.14.10
- @agentick/core@0.14.10

## 0.14.9

### Patch Changes

- @agentick/shared@0.14.9
- @agentick/core@0.14.9

## 0.14.8

### Patch Changes

- @agentick/shared@0.14.8
- @agentick/core@0.14.8

## 0.14.7

### Patch Changes

- @agentick/shared@0.14.7
- @agentick/core@0.14.7

## 0.14.6

### Patch Changes

- Updated dependencies [6b72302]
  - @agentick/shared@0.14.6
  - @agentick/core@0.14.6

## 0.14.5

### Patch Changes

- Updated dependencies [d0e35be]
  - @agentick/shared@0.14.5
  - @agentick/core@0.14.5

## 0.14.4

### Patch Changes

- 5024822: fix: guard response.data and response.error in embed function

  OpenAI-compatible endpoints may return an error object in the response
  body instead of throwing (e.g. when the model doesn't support embeddings).
  Previously this caused a cryptic `.sort() of undefined` crash.

  Now checks response.error first (with descriptive message), then guards
  response.data before accessing it.

- Updated dependencies [cc1ee21]
  - @agentick/core@0.14.4
  - @agentick/shared@0.14.4

## 0.14.3

### Patch Changes

- @agentick/shared@0.14.3
- @agentick/core@0.14.3

## 0.14.2

### Patch Changes

- @agentick/shared@0.14.2
- @agentick/core@0.14.2

## 0.14.1

### Patch Changes

- @agentick/shared@0.14.1
- @agentick/core@0.14.1

## 0.14.0

### Patch Changes

- @agentick/shared@0.14.0
- @agentick/core@0.14.0

## 0.13.2

### Patch Changes

- @agentick/shared@0.13.2
- @agentick/core@0.13.2

## 0.13.1

### Patch Changes

- @agentick/shared@0.13.1
- @agentick/core@0.13.1

## 0.13.0

### Minor Changes

- 8e568d1: Unified EmbedInput API and embed support on adapters
  - **EmbedInput**: New single-object input shape (`{ input, model?, dimensions?, taskType? }`) mirroring ModelInput style. Replaces previous `(texts, options)` positional params.
  - **embed as Procedure**: `EngineModel.embed` is now a Procedure with middleware, ALS context, and telemetry support.
  - **OpenAI adapter**: Added `embeddingModel` config option and `embed()` support via OpenAI embeddings API.
  - **Google adapter**: Added `embeddingModel` config option and `embed()` support via Google embedContent API, including `dimensions` and `taskType` passthrough.
  - **Per-request model override**: API adapters (OpenAI, Google) respect `input.model` to override the configured embedding model per-request.
  - **Custom XML tag passthrough**: Collector and markdown renderer now pass through unrecognized XML tags as custom blocks.

### Patch Changes

- Updated dependencies [8e568d1]
  - @agentick/shared@0.13.0
  - @agentick/core@0.13.0

## 0.12.3

### Patch Changes

- @agentick/core@0.12.3
- @agentick/shared@0.12.3

## 0.12.2

### Patch Changes

- @agentick/shared@0.12.2
- @agentick/core@0.12.2

## 0.12.1

### Patch Changes

- @agentick/shared@0.12.1
- @agentick/core@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [2435355]
  - @agentick/shared@0.12.0
  - @agentick/core@0.12.0

## 0.11.2

### Patch Changes

- Updated dependencies [6d169a8]
  - @agentick/core@0.11.2
  - @agentick/shared@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [336c439]
  - @agentick/shared@0.11.1
  - @agentick/core@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [10023a7]
  - @agentick/shared@0.11.0
  - @agentick/core@0.11.0

## 0.10.1

### Patch Changes

- Updated dependencies [84a0400]
  - @agentick/shared@0.10.1
  - @agentick/core@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies [619c448]
  - @agentick/core@0.10.0
  - @agentick/shared@0.10.0

## 0.9.6

### Patch Changes

- Updated dependencies [84752df]
  - @agentick/core@0.9.6
  - @agentick/shared@0.9.6

## 0.9.5

### Patch Changes

- Updated dependencies [dc26053]
  - @agentick/core@0.9.5
  - @agentick/shared@0.9.5

## 0.9.4

### Patch Changes

- @agentick/shared@0.9.4
- @agentick/core@0.9.4

## 0.9.3

### Patch Changes

- Updated dependencies [1a4c9b0]
  - @agentick/core@0.9.3
  - @agentick/shared@0.9.3

## 0.9.2

### Patch Changes

- @agentick/core@0.9.2
- @agentick/shared@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [596eba0]
  - @agentick/shared@0.9.1
  - @agentick/core@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [d3f9b8d]
  - @agentick/shared@0.9.0
  - @agentick/core@0.9.0

## 0.8.0

### Patch Changes

- @agentick/shared@0.8.0
- @agentick/core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [c73753e]
  - @agentick/core@0.7.0
  - @agentick/shared@0.7.0

## 0.5.1

### Patch Changes

- Updated dependencies [e30960c]
- Updated dependencies [4750f5e]
  - @agentick/core@0.6.0
  - @agentick/shared@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [156bc2f]
  - @agentick/core@0.5.0

## 0.4.0

### Minor Changes

- 842f92c: Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies [842f92c]
  - @agentick/shared@0.4.0
  - @agentick/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [d38460c]
  - @agentick/core@0.3.0

## 0.2.1

### Patch Changes

- 07b630c: Upgrade to React 19 and react-reconciler 0.33. useComState now uses useSyncExternalStore for correct external state synchronization. Clean up dead code from reconciler migration.
- Updated dependencies [07b630c]
  - @agentick/core@0.2.1
  - @agentick/shared@0.2.1

## 0.2.0

### Minor Changes

- a9cf566: agentick convenience package now re-exports @agentick/agent and @agentick/guardrails. One install, one import source.

### Patch Changes

- Updated dependencies [a9cf566]
  - @agentick/core@0.2.0
  - @agentick/shared@0.2.0

## 0.1.9

### Patch Changes

- 3f5f0be: Add documentation website (VitePress + TypeDoc), AGENTS.md for cross-agent discovery, and agent skills for common development tasks.
- Updated dependencies [3f5f0be]
  - @agentick/core@0.1.9
  - @agentick/shared@0.1.9

## 0.1.8

### Patch Changes

- 1fe6118: Add usage to TickState, set XML as default renderer for claude (ai-sdk)
- Updated dependencies [1fe6118]
  - agentick@0.1.8
  - @agentick/shared@0.1.8

## 0.1.7

### Patch Changes

- Updated dependencies [e5604a0]
  - agentick@0.1.7

## 0.1.6

### Patch Changes

- fd23113: Breaking changes: Stream events, threadId handling moved to metadata
- Updated dependencies [fd23113]
  - @agentick/shared@0.1.5
  - agentick@0.1.6

## 0.1.5

### Patch Changes

- f227330: BREAKING: tool parameters -> input, add optional output, update docs
- Updated dependencies [f227330]
  - @agentick/shared@0.1.4
  - agentick@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [90c59d0]
  - agentick@0.1.4

## 0.1.3

### Patch Changes

- ae37abc: New stream events and fork/spawn apis
- Updated dependencies [ae37abc]
  - @agentick/shared@0.1.3
  - agentick@0.1.3

## 0.1.2

### Patch Changes

- BREAKING: new stream events and fork/spawn API for root (previously 'agent')
- Updated dependencies
  - agentick@0.1.2
  - @agentick/shared@0.1.2

## 0.1.1

### Patch Changes

- Initial release
- Updated dependencies
  - agentick@0.1.1
  - @agentick/shared@0.1.1
