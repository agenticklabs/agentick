---
"@agentick/core": patch
"@agentick/kernel": patch
"@agentick/shared": patch
"@agentick/gateway": patch
"@agentick/openai": patch
"@agentick/google": patch
"@agentick/ai-sdk": patch
---

Upgrade to React 19 and react-reconciler 0.33. useComState now uses useSyncExternalStore for correct external state synchronization. Clean up dead code from reconciler migration.
