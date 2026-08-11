---
"@agentick/code": minor
"@agentick/code-host": minor
---

**`@agentick/code-host` is the DEFAULT runtime, and every definition field is
now optional.** `createApp({ code: {} })`, `defineCode()` and a bare
`withCode()` all mount a working namespace: the install imports
`@agentick/code-host` and uses `hostRuntime()`.

The no-default position EVOLVES rather than reverses. A default is refusable
only when it would ESCALATE, and this one does not: the program runs in a
subprocess of the engine the host app already runs, with the trust that process
already has, an empty environment unless the adopter fills it, bindings the
adopter supplied, and no path for a model to reach execution except a tool the
adopter wired. What stays refused is an implicit JAIL (it would imply
containment nobody built) or an implicit ISOLATE (a trust tier nobody chose).
Name a runtime and you get exactly that one.

Resolution is an optional dynamic import with a VARIABLE specifier, not a
dependency: `code-host` depends on `code`, so a manifest edge back would be a
cycle. It resolves for anyone who has the package and for nobody who does not —
in which case the namespace mounts INERT, `hasRuntime()` answers `false`, and
`CodeProviderMissing` names the install rather than lecturing about defaults.
Because resolution happens from where `@agentick/code` sits, a package manager
that nests strictly wants `@agentick/code-host` to be the app's own dependency;
both READMEs say so, and passing `runtime` explicitly never guesses.

**Definition-level `bindings` and `budgets` are a BASE LAYER.**
`defineCode({ bindings, budgets })` sets the context every program gets, and
`createContext({ bindings, budgets })` merges OVER it — deep, per leaf, context
wins (`mergeLayered`). A context adds `tools.audit` without restating
`tools.search`; naming `tools.search` again replaces that one leaf and nothing
else. Budgets layer per key, so raising `timeMs` for one context keeps the
inherited `outputBytes`. The merge happens in the HARNESS before the provider
sees anything, so the ceiling check, the identifier validation and the audit
record's dotted paths all describe the MERGED set — a guard reads what actually
ran, not what one layer asked for.

Budget layering was not asked for and is included on purpose: it is the same
mechanism, and a base ceiling nobody can raise per context is a policy hardcoded
where a default belongs.
