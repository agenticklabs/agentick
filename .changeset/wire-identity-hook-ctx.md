---
"@agentick/spec": patch
---

Per-request ingress identity now reaches wire hook/middleware ctx
(ctx.identity: IngressIdentity, riding EventScope like origin) and
WireExtensionContext.identity carries the structured object beside the
principal string — enabling adopter-space principal-override hooks on
session-creating wire methods.
