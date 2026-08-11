---
"@agentick/code": minor
"@agentick/code-host": minor
---

**Bindings are a CONTEXT OBJECT, not a schema.** `CodeBindings` was three
reserved groups (`tools` / `fs` / `values`); it is now a recursive record on the
`vm.createContext` model. Every key injects VERBATIM as an ambient name: a
function becomes a callable, a nested record becomes a frozen namespace of the
same rule applied again, anything else is a value.

```ts
bindings: {
  tools: { search, fetch },   // tools.search(…)
  fs: { readFile },           // fs.readFile(…)
  tenantId,                   // tenantId
}
```

`tools` and `fs` survive as CONVENTIONS in prose and examples — a model has
strong priors about what `tools.search(...)` means and spending them is free —
but they are nowhere in the types, and flat is right where flat reads better.
The framework no longer has an opinion about the shape of what a program should
reach, which is the caller's design. `CodeBindingNameConflict` is deleted: one
record cannot claim a name twice, so the cross-group collision it guarded
against is now impossible by construction.

**The audit record carries DOTTED LEAF PATHS** — `["apiKey", "tools.recall"]` —
so `guardCodeExecute` vetoes precisely: `input.bindings.includes("tools.deleteAll")`
names the binding it means, not a bare leaf that could belong to any namespace.
Identifier validation applies PER SEGMENT at every depth (plain identifiers, no
`__proto__` / `constructor` / `prototype`), which is also what makes a dotted
path unambiguous: a key can never contain the separator, so `{ "tools.same": v }`
is refused rather than forging another binding's path. A record stops being a
namespace past `MAX_BINDING_DEPTH` (3) and is carried as one value, which bounds
both the walk and the journal — `{ dataset }` costs one line, not one per row.

One walk serves all three readings: `flattenBindings(bindings)` returns the
functions by dotted path, the value tree with callables removed, and the sorted
names, and both the harness and every provider call it. A provider that
re-derived the rule would be free to disagree with the record a guard already
decided on. `bindingNames`, `resolveBindingPath`, `freezeNamespaces`,
`BINDING_PATH_SEPARATOR` and `MAX_BINDING_DEPTH` ship alongside it.

**Namespaces are frozen**, so a program cannot swap `tools.search` for something
of its own — enforced in `@agentick/code-host`'s child and in `fakeCode` alike,
because the rule is the same everywhere. The conformance suite gains
`swapsBinding` to the source vocabulary (REQUIRED) plus two pins: a nested
binding round-trips through its namespace, and a swapped namespace still answers
with the original. `swapsBinding` swallows whatever the replacement attempt
raises on purpose — an engine that refuses loudly and one that refuses silently
are both conformant, and a pin that told them apart would be testing strictness
rather than the guarantee.

One cost, stated: a function NESTED in a namespace needs its parameter annotated
(`async (input: unknown) => …`) where a top-level one infers, because TypeScript
will not carry a contextual parameter type through a union member's index
signature and "an entry is a callable or a record" is that union.
