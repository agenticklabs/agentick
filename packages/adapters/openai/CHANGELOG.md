# @agentick/openai

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
