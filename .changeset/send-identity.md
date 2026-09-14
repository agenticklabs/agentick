---
"@agentick/spec": minor
"@agentick/session": minor
"@agentick/gateway": minor
"@agentick/connector": minor
"@agentick/utils": minor
---

`SendInput.identity` — who an execution acts AS, separate from who owns the
session.

The session's owning principal (ADR 48) stays construction-bound on the
record and remains the input to the wire gate. What changes per turn is the
initiator: `send({ identity })` makes that identity's `principal` the
execution's, so `ctx.principal` in every tool handler, store call, and model
envelope under the run names the person who asked, not the person who owns
the conversation. Absent, the execution runs as the session's own principal,
byte-identical to before.

The field is server-declared like `principal` and `internal`. The wire
`session/send` handler stamps it from the authenticated caller; the
connectors harness stamps it from the inbound's identity (closing the
`#302` per-message actor TODO on the routing hop); the wire params carry no
such slot, so a request body cannot claim one. In-process callers may pass
it.

Observable only where a caller is admitted to a session it does not own —
a custom authorizer overriding the same-principal target rule, or a
connector routing an identity-bearing inbound into a session opened under
another principal. There the execution now runs as the caller. Everywhere
else nothing changes; the conformance test asserts it.

`@agentick/utils` gains `pick(obj, keys)` — the pass-through half of
`omitUndefined`, so forwarding optional fields reads as one line.
