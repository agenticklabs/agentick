---
"@agentick/kernel": patch
"@agentick/gateway": patch
---

Fix EventBuffer dual-consumption bug where multiple async iterators on the same buffer caused duplicate and missed events. The shared waiter mechanism now wakes all iterators and each reads from the buffer at its own index.

Gateway plugin routes now enforce auth by default. Plugins can opt out with `{ auth: false }`. Auth enforcement centralized in `dispatchPluginRoute()` covering both embedded and HTTP transport paths. Added `validateAuth()` to `PluginContext` for custom plugin auth logic.
