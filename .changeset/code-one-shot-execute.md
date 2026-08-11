---
"@agentick/code": minor
"@agentick/code-host": minor
---

**Breaking: the one-shot `Code.run` is now `Code.execute`.** The command it rides
is `code:execute`, and the public method that rides it should have its name —
one verb from the door through the command, the guard and the journal.
`session.code.execute({ source, bindings?, budgets?, signal? })` takes the same
single bag it always did; only the name changed, and `run` does not survive as
an alias. `context.execute(source)` on an open context is unchanged: the same
verb at a different scope, positional because the context is already configured.

The bag's type is renamed `CodeRunInput` → `CodeOneShotInput`, named for its
shape rather than its verb because two neighbours already hold the obvious
names: `CodeExecuteInput` is the command's input — the audit record the harness
derives and the journal carries — and `CodeExecuteRequest` is the `fx` door's
`{ contextId, source }`. Three inputs reach one verb, and none of them may share
a name.

**Breaking: `CodeHarness.guardCodeExecute` is removed.** It was a delegation to
a protected Effect-only primitive, published as though it were the way to guard
this verb — but `BaseHarness.guard` already accepts a bag keyed by the command,
types the input from the registry, and takes a PLAIN sync or async decider:

```ts
codeHarness.guard({
  codeExecute: (input) =>
    input.source.includes("child_process")
      ? { kind: "veto", reason: "no subprocess spawning" }
      : { kind: "proceed" },
});
```

Same interceptor, same outermost ordering, and scoped to `code:execute` rather
than to every command on the harness. A verdict is data — `proceed`, `veto`,
`defer`, or `replace` with a result of your own — and returning nothing means
proceed.

**Pre-run pipelines are now documented as what they are: three seams, all
plain.** A pass that rewrites the program (a lint autofix, a formatter, an
instrumentation pass) or merely observes it is `onBeforeCodeExecute`, a plain
async `(input, ctx)` — return a changed input to rewrite, return nothing to let
it through. A pass that needs the answer too (timing, `try`/`finally`, a retry)
is `onCodeExecute`, the plain async `(input, next, ctx)` middleware. A pass that
must REFUSE is a guard. Hooks transform and observe; guards block. Both READMEs
say so at the guard itself, so nobody writes a "gate" out of a hook that cannot
stop anything.

Between them these mean the code packages' documented surface needs **no Effect
at all** — it is available where it composes (the `fx` twin, for a caller
already inside an operation) and required nowhere.

A rewriting pass stays honest: the `requested` envelope holds the program as
asked for, and when the executed string differs the harness emits
`code:execute:rewritten` with both digests. The absence of that event is the
guarantee that the requested envelope is what ran.

Both packages also gain a **Running TypeScript** section — the mode is additive
(JavaScript is valid TypeScript) and transpile-only (types are stripped, never
checked), with real type-checking shown as a pipeline rather than implied to be
part of the mode.
