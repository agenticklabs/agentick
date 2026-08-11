---
"@agentick/code": minor
---

`@agentick/code` — running model-authored code as an operation. `code:execute`
is a declared command, so a program the model wrote is journaled with its
source, its digest and the NAMES of its bindings (never their functions or
values), vetoable through `guardCodeExecute` before the provider is touched,
and hookable via `onBefore/AfterCodeExecute`. Abort reaches the program itself:
the operation fiber's signal is threaded into the provider call and merged with
the caller's own `signal`, so a cancelled turn stops a running program rather
than abandoning it, and a stopped program raises `CodeAborted` — cancellation
is not an answer, so it is not an outcome. Language, engine and
isolation belong to a `Runtime` provider, so one slot, one contract and one
conformance suite cover a subprocess, an in-process isolate and a runtime whose
language is not JavaScript.

Mount with `createApp({ code: defineCode({ runtime }) })` or
`withCode({ runtime })`; reach it at `session.code` / `ctx.code`, both optional
— nothing is minted for a session that never asked. `runtime` is required:
mounting the namespace and choosing what runs the code are the same act, and
there is deliberately no default, because an implicit one would mean unjailed
host execution is what you get by not deciding. An adopter who needs the
harness before the provider is chosen builds one and calls `bindRuntime`;
`CodeProviderMissing` guards that window.

`fx.execute` takes only `{ contextId, source }` — the digest and the binding
names in the audit record are the harness's to derive, so a guard deciding on
them cannot be handed a description of a different program. Disposing a context
or closing the harness ABORTS whatever is running and tears down only once it
has settled, and executions on one context are serialized. Binding names are
refused at `createContext` when they collide across groups or are not plain
identifiers.

On privacy, precisely: the REQUESTED envelope carries binding NAMES and never
their values — but results, output streams and error causes are journaled in
full, so a program that returns or prints a secret has published it. Redaction
of results is the adopter's policy layer.

`runCodeConformance(probe)` certifies any provider in any language: the probe
supplies the source vocabulary, the suite drives the contract and holds every
declared capability to account. `@agentick/code/testing` ships `fakeCode`, a
working in-memory runtime whose language is a recorded instruction list rather
than an evaluator.

Every `code:execute` envelope is stamped with a `codeContextId` scope
dimension, so `app.events({ scope: { codeContextId } })` follows one context's
executions out of a session running several.

The contract and the `CodeError` family live in this package —
`@agentick/spec` and `@agentick/session` are untouched. No provider package and
no model-facing tool ship here, and `runCodeConformance` ships from the
`/testing` subpath so no production bundle loads vitest.
