---
"@agentick/code": minor
"@agentick/code-host": minor
---

**`run` takes a single input bag.** `code.run({ source, bindings?, budgets?, signal? })`
replaces `run(source, options?)`. Every other command in the house hands its
hooks, guards and middleware one object; `run` was the positional odd one out,
and the motivating case — a linter or transform reading `input.source` in
`onBeforeCodeExecute` — is exactly where that inconsistency bites.

`CodeRunInput` EXTENDS `CodeContextOptions` rather than restating its fields, so
the equivalence stays literal in the type: `run` is a context used once. The
field is `source`, matching `CodeExecuteInput` and the audit record — one
vocabulary from `run` through the command, the guard and the journal. Its
`bindings` and `budgets` layer over the definition's base by the same
`mergeLayered` rule `createContext` uses; there is one merge, not two.

`CodeContext.execute(source)` stays POSITIONAL, deliberately. It is the REPL
verb, whose whole point is that the context was already configured, and a guard
sees the command's bag either way.

**The digest now describes what RAN.** `codeHash` is derived at the door, before
the interceptor cascade — so a middleware that rewrites `input.source` (an
autofix, a transform, an instrumentation pass) would have left the journal
naming a program nobody executed: the exact lie the C1 fix closed at the door,
reopened mid-chain. The command body now re-derives the digest from the final
`input.source` it is about to execute and, when it differs, emits
`code:execute:rewritten` carrying both digests and the executed source.

The `requested` envelope is left alone on purpose. Its phase contract is
"argument bound", so it truthfully records what was ASKED; the runner publishes
it before any interceptor runs, and rewriting history there would be the
dishonest fix. The coherent record is two facts — the request, and the
execution when it differs — with the ABSENCE of a rewrite event meaning the
requested envelope is what ran. The digest is taken from the exact string handed
to the provider, so no hook can leave the record describing a different program.
