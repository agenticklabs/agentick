---
"@agentick/gateway": minor
---

Add `broadcast(event, data)` to `PluginContext`. Plugins can push events to clients subscribed via synthetic `$plugin:{pluginId}` session keys. Subscribe/unsubscribe routing, disconnect cleanup, and plugin removal cleanup are all handled automatically.
