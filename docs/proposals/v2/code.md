# code — running model-authored code as a capability

Status: draft for judgment. Proposed home once approved: agentick
`docs/proposals/v2/code.md` (companion to W20; supersedes the runtime half of
`docs/proposals/code-mode.md`).

## Thesis

Model-written code is a first-class act the framework currently cannot see:
ernesto's `execute_code` hand-rolls evaluation, isolation, tool reach, and
audit inside one app tool. The capability deserves to become a **built-in,
language-neutral harness** — `@agentick/code` — holding a `Runtime` provider.
Code execution then becomes an _operation_ with the full envelope, and every
consumer (code-mode, eval, executable skills, adopter plugins) rides one
mechanism.

**Language-neutral is the load-bearing choice.** The capability is "run
model-authored code, safely, with tool bindings, returning a value." Language,
engine, and isolation are all properties of the _provider_, never of the
harness. So `session.code` holds whatever `Runtime` was bound; `code-node`
runs JavaScript, a future `code-pyodide` runs Python, and the harness slot,
the contract, and the conformance suite are identical across them. This is the
reconciliation of the earlier "would we ever want python?" question:
**yes — and it is another provider under the same slot, not a second harness.**

**Built-in, and `resources` is the exact precedent.** `code` is a bundled
workspace package (ADR 27): `session.code` is always present and `ctx.code` is
a first-class handler slot, so code-mode reaches it through the same door
`ctx.tools` opened — no app wiring. The lifecycle is resources' verbatim:
resources is built-in yet "the harness stores none" — always present, inert
until resolvers are registered. `code` is the same — always present, inert
until a provider is bound — with the provider/placement _mechanics_ borrowed
from sandbox (ADR 24). `createContext`/`run` throws `CodeProviderMissing` (the
`CompactStrategyMissing` analogue) until an adopter binds one. Forever home,
zero cost when unused, no implicit provider — the safety position below holds
_because_ presence and provider are separate.

## Null hypothesis, answered

Could this stay app code? Three consumers say no:

1. ernesto's `execute_code` (exists, and its debt list is the evidence the
   abstraction is being reinvented ad hoc);
2. the framework's own code-mode (W20 names it the sharpest item on the list;
   a `<CodeMode>` surface cannot depend on app-side evaluation);
3. standalone adopters — isolate evaluation is useful to apps that install no
   sandbox packages at all (scoring functions in `@agentick/eval`,
   user-authored transforms, executable skill scripts).

Could it be an adapter family like `model → model-anthropic`? No — executing
model-written code is a **privileged act that wants the operation envelope**:
journaling (an audit trail of every program the model ran, with its bindings
named), derived hooks, and above all **`guardCodeExecute`** — the seam where
deployment policy vetoes, rewrites, or budget-caps code _before it runs_.
Adapters project I/O; harnesses own operations. This is an operation.

## The contract — language-agnostic in shape

```
@agentick/code
  harness.ts        CodeHarness — commands, guards, provider registry
  contract.ts       Runtime / RuntimeContext / ExecuteInput / ExecuteResult
  augment.ts        HookBridges slot
  extension.ts      withCode() — session extension, lifecycle-bound
  conformance.ts    runCodeConformance — certifies any provider, any language
  /testing          fakeCode
```

`nodeRuntime({...})` / `secureExec({...})` are the provider (the
`sandbox-local` analogue); `defineCode({ runtime })` / `withCode({ runtime })`
are the slot / extension — `runtime:` is the key because the value _is_ a
Runtime; `session.code` is the handle. The runtime IS the capability the
harness holds, so it CREATES contexts — it is not itself created by a
`createCode`.

**The provider binds once; bindings and budgets are per-execution.** A
provider factory takes _stable_ config — engine, isolation, placement,
memory/CPU ceilings, permission drivers — because that is the same for every
execution in the session. `bindings` (which tools/fs/values are in scope) and
`budgets` (the time/output ceiling for THIS code) change per call, so they sit
on `createContext`, not in the factory. Config-binding is also what lets
`ctx.code.run(...)` reach the runtime ambiently: a per-call runtime argument
would force every caller to know the engine.

```ts
withCode({ runtime: secureExec({ permissions, memoryLimit: 64, cpuTimeLimitMs: 5000 }) });
//   or:  nodeRuntime({ host: sandbox.get("primary") })
```

Multiple runtimes in one session (trusted node beside untrusted isolate) is
NOT built now — no third consumer — but binding-at-config leaves the door
open to the sandbox-registry pattern additively: `defineCode({ runtimes: {
default: …, untrusted: … } })` + `createContext({ runtime: "untrusted" })`.

**The shared contract is genuinely language-neutral; only the marshaling
differs per provider:**

```ts
const ctx = await session.code.createContext({ bindings, budgets }); // async — a placement crosses a membrane
const result = await ctx.execute("const x = await recall({ q }); return x");
await ctx.dispose();
```

Identical shape for a Python provider — `bindings` in, source in, `value` out,
`budgets` enforced. What a provider owns: how source loads (esbuild for TS,
none for py), how bindings inject (ambient globals + `.d.ts` vs builtins +
`.pyi`), how the value returns. What the contract owns: the four-line surface
above. That is why `code` is interchangeable at the contract level (one
conformance suite certifies any provider) while a given `execute` is
language-bound (the code-mode extension picks the provider AND generates the
matching stubs, so it always knows the language).

`createContext`/`execute` are async because at least one placement (a jail
over a socket) cannot answer synchronously — the contract is async or it lies
about a placement. A one-shot is a context used once (sugar:
`session.code.run(code)`). The context is the REPL axis — persistent state
across executions in one session — which every mature code surface grows into;
the interface costs one method now and forecloses nothing.

**The value is `return`ed; stdout is a side channel.** The completion value is
the answer — structured-clone-able, typed, never string-munged; ernesto's
stdout-only result is the debt, not the design. The JS envelope is therefore
an **async function body**, not an ES module: `return` is legal, top-level
`await` is free, tools are **ambient** (`await recall(...)`, no import).
`ExecuteResult` carries `value` plus captured `stdout`/`stderr` as distinct
observability fields — a program narrates with `console.log` and answers with
`return`. (Module semantics would force `export default` + `import`; we keep
`return` and let the generated `.d.ts` declare tools as ambient globals, so
the model gets full typing without import ceremony. The Python provider makes
the analogous choice with a designated return + `.pyi`.)

**Bindings are named async functions and values, injected as ambient names.**

```ts
bindings: {
  tools:  { recall: async (input) => …, web_fetch: async (input) => … },
  fs:     { readFile: async (path) => …, readdir: async (path) => … },
  values: { sessionId, budgetMs },
}
```

Async-only because every placement crosses _some_ boundary — a sync binding is
a lie somewhere. The runtime injects and marshals; it does not interpret. Tool
proxies, the `/knowledge` fs-bridge, stub generation, reachable-tool policy
all live in the **code-mode extension** (tool-executor territory) that
_consumes_ `code`. The harness knows nothing about tools — that is what keeps
it generic for the eval-scoring and plugin cases, and language-neutral.

**Execution is a declared command** (`code:execute`): journaled with code hash

- binding names (not binding internals), guardable, hookable, abortable by the
  standard op machinery. Typed outcomes, not string parsing —
  `truncated`/limit/`no-value` are result discriminants.

**Budgets** — `timeMs`, `memoryMb`, `outputBytes` — contract-level; a provider
that cannot enforce one SAYS so in its capabilities (the conformance suite
asserts declared capabilities are real).

## Providers — engine is the discriminator, language falls out of it

`<role>-<discriminator>` with role `code` and the discriminator the concrete
runtime. Language is implicit in the engine, never a naming level:

- **`code-node`** — esbuild-transform + subprocess node; the extraction of
  ernesto's shipped mechanics. Honest capability declaration: _no
  language-level containment_ — its trust story is its placement. (JavaScript.)
- **`code-isolate`** — in-process V8 isolate; deny-by-default with
  permissions-as-functions that map 1:1 onto the bindings contract (its fs/net
  driver hooks ARE our binding functions). Built ON **secure-exec** (rivet) —
  itself a driver framework (system driver × runtime-driver-factory) — the way
  `sandbox-local` is built on seatbelt/bwrap: secure-exec is the
  implementation dependency, not the name. Trust story: isolate boundary;
  capability-trimming, recommended inside a jail for hostile input.
  (JavaScript.)
- later, if wanted: `code-quickjs` (wasm — strongest in-process JS story),
  `code-bun` / `code-deno` (other JS runtimes), `code-pyodide` /
  `code-cpython` (Python — the proof the harness is language-neutral).

The three axes a provider collapses — **language × engine × isolation** — are
real and orthogonal (secure-exec proves engine ≠ isolation: it self-isolates
in-process without an OS sandbox). We are NOT settling that taxonomy in the
abstract. We lock the contract now and let the provider names fall out of
building two that differ on isolation — one subprocess (`code-node`), one
in-process (`code-isolate`) — rather than naming ahead of implementation.

## Placement — composition by structural port

`code-node` accepts a **process-host port** (spawn/exec/kill + stdio +
mounts), defaulting to `child_process`. `SandboxHandle` satisfies it
structurally. **No dependency edge from `code` to `sandbox`** — the pairing is
the adopter's composition:

```ts
withCode({ provider: nodeRuntime({ host: sandbox.get("primary") }) });
```

Every cell is coherent: node-on-host (trusted), node-in-jail (ernesto today),
isolate-in-process (lightweight, no sandbox packages), isolate-in-jail
(defense in depth). The supervisor protocol — tool door + fs-bridge — is one
spine every placement shares; only the marshaling differs.

## No implicit default provider — deliberately

`sandbox` requires choosing a provider; code execution deserves the same. An
implicit `code-node` default means "unjailed host execution is what you get by
not deciding" — the exact place a generous default is a foot-gun (the
unannotated-MCP precedent: safe-by-default where the blast radius is real).
Docs recommend a first choice loudly, with the pairing table; ergonomic
defaults apply to budgets, never to the trust decision.

## Migration — the cleanup circle-back

Ernesto's `execute-code/` decomposes with nothing left behind:

| today (ernesto)                              | home                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| esbuild + `main.mjs` + subprocess + timeouts | `code-node`                                                                                      |
| dispatch server + socket auth                | code-mode extension (the spine)                                                                  |
| `tools.mjs` / `tools.d.ts` stub generation   | code-mode extension — the `.d.ts` is also the tool-search corpus (task #9)                       |
| `CODE_REACHABLE_TOOLS` static list           | code-mode policy seam — dynamic, exposure-driven, closes the TODO                                |
| per-session workspace + teardown             | `withCode` lifecycle + sandbox mounts                                                            |
| skills reachability                          | bundle **materialization** into the workspace (`skill://…/references/*` already resources)       |
| `/knowledge` reads                           | fs-bridge → `resources_read`; later the host-side FUSE bind-mount (KNOWLEDGE-FILESYSTEM phase 5) |

`execute_code` the _tool_ stays app-side (its prompt, its result rendering) —
one page over the extension.

## Open questions (yours)

1. **No-implicit-default ruling** — I hold the position above; overrule if you
   want a true default.
2. **Context persistence in v1** — design the interface now (cheap); does
   ernesto's tool adopt persistent contexts immediately or stay one-shot until
   a consumer wants the REPL?
3. **Where code-mode lives** — extension in `@agentick/tool-executor`, or its
   own `@agentick/code-mode` consuming `code` + tool-executor? My lean: its
   own package — it has its own surface (stubs, SDK generation, policy) and is
   not thin.
4. **Provider taxonomy timing** — I recommend locking the contract now and
   deferring final provider names until `code-node` and `code-isolate` both
   exist and we have seen what varies. Agree, or name them now?
