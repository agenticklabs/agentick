---
"@agentick/core": patch
---

Add `session.pushEvent(event)` to the public Session interface. Injects an event into a session's event stream with full enrichment (id, tick, timestamp, sequence, devtools forwarding). Enables external event routing between sessions not connected via spawn.
