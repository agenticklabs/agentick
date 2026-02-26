---
"@agentick/shared": minor
"@agentick/core": minor
"@agentick/react": minor
"@agentick/tui": minor
"@agentick/sandbox": minor
"@agentick/sandbox-local": minor
"@agentick/gateway": minor
---

### Cache metrics & CacheHealth widget

- Surface `cachedInputTokens`, `cacheCreationTokens`, and `cacheHitRatio` through ContextInfo, protocol payloads, streaming events, and devtools
- New `CacheHealth` status bar widget with configurable color thresholds

### Shell → Bash rename

- Rename Shell tool to Bash across sandbox packages
- Fix base executor to use `bash -c` instead of `sh -c` (enables brace expansion)

### Mode-aware mount consolidation

- `addMount()` now respects mount modes: rw parents consume all children, ro parents only consume ro children
- Redundant child mounts skipped when parent already covers them
- Mode promotion (ro → rw) on exact path match
- Confirmation messages show the directory being mounted, not the individual file

### useEvents batching fix

- Replace single-event useState with microtask-batched queue to prevent React state batching from dropping events

### Empty response guard

- Detect empty model responses and replace with corrective event instead of persisting empty assistant messages

### Gateway logging

- Debug/trace logging for RPC requests, event streaming, and send method flow
- Logging config (level, file) in gateway FileConfig
