---
"@agentick/shared": patch
"@agentick/gateway": patch
---

Fix tool-confirm RPC: correct method name (`tool-response` → `tool-confirm`), map field names (`toolUseId` → `callId`, `approved` → `confirmed`), and forward `always` flag through gateway so "Always Allow" works for remote clients.
