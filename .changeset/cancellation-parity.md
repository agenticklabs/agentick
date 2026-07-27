---
"@agentick/loop-executor": minor
"@agentick/session": minor
---

Cancellation parity — BREAKING for anyone reading `outcome` on an
abort. Every cancellation entry point now lands `outcome: "canceled"`:
a caller-supplied `signal` abort reports exactly like `abort()` and
`timeoutMs` (it previously reported `succeeded`), with `stopReason`
naming which one fired (`"aborted"` / `"timeout"`). A signal that
aborts only after the run finished naturally does not relabel the
finished work. Session-side, a canceled terminal that carries a result
now RESOLVES `send()` with `stopReason: "aborted"` — as the session
README always promised — instead of rejecting; only a result-less
terminal rejects. Riding along: a derived-promise hygiene sweep (four
unhandled-rejection leaks fixed, the biggest on every harness's
`ready`), `CompilerFactory` deps widened to optional with a dep-less
`reactCompiler()` fallback, the model-executor's backward-compat
aliases deleted onto `ExecutorLifecycle`'s own API, and a workspace
docblock sweep (21 stale `-next` specifiers and dead contracts).
