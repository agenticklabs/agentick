---
"@agentick/client": minor
"@agentick/client-core": minor
---

Say which client to install. `@agentick/client` already carries every
built-in capability's client surface — `session.timeline`,
`session.tools`, `session.knobs` and the rest are registered by
importing it, with nothing to wire — while `@agentick/client-core` is
the lean core where you register each capability yourself. Nothing said
so. The first real consumer installed the core, hand-rolled five
`import "@agentick/<x>/client"` lines, missed one, and spent time
chasing a `tools/list` method-not-found at a server that was fine.

The fix is that both READMEs now state the choice in their first lines
— install `@agentick/client`; drop to the core only to trim a bundle —
and `createClient`'s own doc comment names the tradeoff at the point of
use, so the zero-config path is the one you find first.

Behind that, reading a capability slot you never registered now throws
`SessionSubHandleNotRegistered` instead of silently synthesizing a wire
namespace that fails at the first call; the message leads with
"install @agentick/client" and gives the single import as the
deliberate-lean-core alternative. Client-core gains no harness
dependency for it — a module-private dictionary of slot name →
`/client` specifier (string literals only), read on the one path where
synthesis would otherwise have happened, checked against the live
registry in both directions by an anti-rot test in `@agentick/client`.
Unknown names keep synthesizing (the gateway-porcelain
`session.billing.approve` case), and only property reads throw:
`"tools" in session`, `Object.keys`, and util.inspect report absence,
so logging a session is always safe.
