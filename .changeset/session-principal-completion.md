---
"@agentick/spec": minor
---

The session-principal completion (ADR 48): principal stamped at
creation (host door + wire door from the authenticated identity;
params cannot set it), inherited by spawn/fork children, fork inherits
the metadata bag, onSessionCreate gains a reshape arm, and
SessionInstaller exposes principal + metadata at install. The
same-principal wire target rule now engages on the stamped value.
SessionRecord gains principal (durable stores should round-trip it).
Plus MCP: RFC-9728 protected-resource metadata endpoint and the HTTP
auth pre-gate (401 + WWW-Authenticate before SDK handling).
