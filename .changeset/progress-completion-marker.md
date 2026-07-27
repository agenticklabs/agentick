---
"@agentick/spec": minor
"@agentick/transport": minor
"@agentick/gateway": minor
---

A progress token's stream now ends. `ProgressReporter.close()` sends
`notifications/progress/complete` (token only — a bounded stream reaching
its end is not a failure, which is why it is not
`notifications/subscription/closed`); the client transport closes the
matching stream on receipt, which ends the consumer's iterator and reaps
the token's registration.

Two bugs die with it: a client `handle.events()` loop no longer hangs on
a `next()` that will never resolve, and a completed `session/send` no
longer leaves its token in the transport's `progressStreams` map — the
registration leak.

The gateway's `session/send` arms the marker behind BOTH progress
fan-outs (execution events and ADR 64 signals) draining, so it can never
race the last pushed frame — and does it in a detached continuation, so
the RPC response is not held behind a slow tail frame. Pinned by a
no-drop test: a deliberately slow consumer still receives every frame,
including the terminal `result`, because `MultiplexedStream` empties its
buffer before signalling done.
