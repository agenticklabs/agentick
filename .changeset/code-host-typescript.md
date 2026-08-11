---
"@agentick/code-host": minor
---

`hostRuntime({ language: "typescript" })` — TypeScript as an opt-in mode, and a
README section on checking a program before it runs.

The mode is ADDITIVE, not a second engine. JavaScript is valid TypeScript, so a
TypeScript-mode runtime accepts every program a JavaScript-mode one does; the
proof is that the whole existing JavaScript conformance suite runs against it
unchanged, with no branch in the suite and no second source vocabulary. What
changes is that annotations, `interface`, `enum` and `as` stop being parse
errors, so the model can write in the language the bindings are documented in.

Types are stripped by esbuild in the PARENT process, before the source crosses
the membrane, which keeps the child the engine-neutral script it has always been
— a bare specifier in the child would have to resolve inside whatever placement
the child was put in. A program is an async function body, which no parser
accepts on its own, so the source is wrapped in a declaration for the transform
and the call is appended to the output. The cost is about a third of a
millisecond per execution once esbuild's service is warm.

**Transpile-only, and the distinction is load-bearing.** esbuild erases types
without checking them, so a program `tsc` would reject still runs: a type error
surfaces at runtime or not at all. Type CHECKING is a decision about what the
model may run, which makes it policy — `guardCodeExecute` — and the README now
carries two worked examples of it. The first is a parse gate, cheap enough to
run on every execution, built on the exported `transpiler()` so an adopter's
gate cannot disagree with the check the runtime itself performs. The second is
the shape for real type-checking as pre-execution feedback, with the
`typescript` API the adopter brings and an honest paragraph on the latency it
costs.

Capabilities name the mode (`host:node+ts`) and nothing else changes: the
transform happens before the child is involved, so the same budgets are enforced
the same way. The audit record is unaffected — `code:execute` journals the
TypeScript the adopter handed the harness and hashes that, because
transpilation happens inside the provider, below the audit boundary. Source that
will not parse reports `outcome: "threw"` with a `SyntaxError`, the same way the
engine reports its own, rather than as a runtime failure.
