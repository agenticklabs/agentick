# The house rules

Custom oxlint rules for invariants this repo has paid to learn. Each rule
exists because a class of bug shipped once and must not ship twice — the
rule header names the incident or issue it encodes.

## How a bad pattern becomes a rule

1. **Name the class, not the instance.** A rule earns its place when the
   mistake is a _pattern_ someone will plausibly write again — not a
   one-off typo. Cite the incident/issue in the rule's header comment.
2. **Write the rule** in `rules/<kebab-name>.mjs` (one rule per file,
   ESLint-compatible `create(context)` — see the oxlint
   [JS plugins guide](https://oxc.rs/docs/guide/usage/linter/writing-js-plugins.html)),
   register it in `plugin.mjs`, and enable it in the root `.oxlintrc.json`.
3. **Fixture-test it** before trusting it: a scratch file with every bad
   form and every legal form, `npx oxlint <file>`, confirm both halves.
4. **Count the existing findings**, then pick the landing mode:
   - **0 findings** (codebase already migrated) → `"error"` immediately.
   - **A handful** → fix them in the same change, then `"error"`.
   - **A nuke** (dozens+) → land as `"warn"`, burn the backlog down in
     its own change(s), then promote to `"error"`. Never land an error
     rule that the repo currently fails.
5. **Pair with the publish gate when the stakes warrant it.** A lint rule
   is editor/CI feedback; a `scripts/*-gate.mjs` wired into
   `verify:publish` is a hard physical stop. Process-safety invariants
   get both (`no-floating-run-promise` + `detached-effect-gate.mjs`).

## Rules

| Rule                      | Class it prevents                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `no-floating-run-promise` | Floating `Effect.runPromise(...)` — an unobserved rejection is process death (#315). Use `runDetached`. |

## Type-aware lane

`oxlint-tsgolint` is installed and the repo is on TS 7, so
`oxlint --type-aware` works today (59 of 61 typescript-eslint type-aware
rules, including `typescript/no-floating-promises`). Measured 2026-08-27:
`no-floating-promises` with `ignoreVoid: false` reports **150 findings**
across ~20 packages — a nuke per §4; it stays off until deliberately
burned down. Syntactic house rules in this plugin stay preferable where
they suffice: they run in the fast path (~650ms repo-wide) with no type
graph.
