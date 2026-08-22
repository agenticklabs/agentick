# @agentick/code

**Let the model write a program, and treat running it as a first-class act.** A model that can only call one tool per turn spends five turns fetching, filtering and summing what one loop would have done. Handing it a language fixes that — and immediately raises the questions a hand-rolled `eval` never answers: what ran, with what in scope, who could have stopped it, and what came back.

This package answers those. Running code is an **operation**: journaled with the program, its digest and the names of everything in scope; vetoable before a single line executes; abortable; and finished with a typed outcome instead of a scraped string. What the code is written in, what engine runs it and what contains it belong to a **runtime provider** — so one contract, one slot and one conformance suite cover a subprocess, an in-process isolate, and a language that isn't JavaScript.

> [!IMPORTANT]
> The default runtime is [@agentick/code-host](../code-host), which runs a program in a subprocess of the engine your app already runs. It is a default because it adds no trust boundary that was not already there: the program runs with the host process's own trust, its environment is empty unless you fill it, the bindings are yours, and the model reaches execution only through a tool you wired. What is refused is a default that **escalates** — an implicit jail would imply containment nobody built, and an implicit isolate a trust tier nobody chose. Name a runtime and you get exactly that one; install nothing and `session.code` mounts inert, failing `CodeProviderMissing` with the install in the message.

## Install

```bash
npm install @agentick/code
```

Subpaths: `/testing` (a working in-memory runtime, its conformance probe, and a harness factory).

## Quick start

Name a runtime, then run a program with tools in scope:

```ts
import { defineCode } from "@agentick/code";

// Naming the namespace is enough — the default runtime is @agentick/code-host.
const app = await createApp(<Agent />, { model, code: {} });
const session = await app.createSession();

// `session.code` is undefined unless something installed the namespace.
const code = session.code;
if (!code) throw new Error("no code runtime is mounted");

const result = await code.execute({
  source,
  bindings: {
    tools: { recall: (input: unknown) => session.tools.dispatch("recall", input) },
    tenantId: "acme",
  },
  budgets: { timeMs: 5_000, outputBytes: 64_000 },
});

if (result.outcome === "returned") console.log(result.value);
```

Narrow it once, as above, and the rest of your code works with a plain `code`. The examples below do the same.

Name a runtime when you want a specific one — a configured host, a jail, an engine that is not JavaScript:

```tsx
createApp(<Agent />, {
  model,
  code: defineCode({ runtime: hostRuntime({ cwd: "/srv/scratch" }) }),
});
```

And give every program a base context, so a caller adds to it rather than assembling it:

```tsx
createApp(<Agent />, {
  model,
  code: defineCode({
    bindings: { tools: { recall }, tenantId },
    budgets: { timeMs: 5_000, outputBytes: 64_000 },
  }),
});
```

A context merges **over** that base, per leaf. `createContext({ bindings: { tools: { audit } } })` leaves `tools.recall` and `tenantId` standing and adds `tools.audit`; naming `tools.recall` again replaces that one leaf and nothing else. Budgets layer the same way, per key — raise `timeMs` for one context and it keeps the inherited `outputBytes`. The audit record and the ceiling check both see the merged result, so a guard reads what actually ran.

## The value is the answer

A program narrates with its output streams and answers by returning. Both come back, and they are never confused for each other:

```ts
const result = await code.execute({ source });

result.stdout; // "checked 40 rows\n"  — narration
result.stderr; // ""
result.truncated; // []                — streams cut at the outputBytes ceiling

switch (result.outcome) {
  case "returned":
    return result.value; // structured, not string-munged
  case "no-value":
    return "the program ended without returning";
  case "threw":
    return `the program raised: ${result.error.message}`;
  case "budget-exceeded":
    return `stopped at the ${result.budget} ceiling of ${result.limit}`;
}
```

A program that throws is a **result**, not a rejection — it is an answer you hand back to the model. A rejection means the machinery failed: no runtime bound, a membrane that would not open, a context already disposed.

## Bindings are the program's context

`bindings` is the context the program runs in — the `vm.createContext` model. Every key is injected **verbatim** as an ambient name: a function becomes a callable, a nested record becomes a namespace, anything else is a value.

```ts
await code.execute({
  source: `
    const hits = await tools.recall({ q: "invoices", tenantId });
    const notes = await fs.readFile("/notes/latest.md");
    return { hits: hits.length, notes };
  `,
  bindings: {
    tools: { recall: (input: unknown) => session.tools.dispatch("recall", input) },
    fs: { readFile: (path: unknown) => session.resources!.read(String(path)) },
    tenantId,
    today: new Date().toISOString(),
  },
});
```

There are no reserved groups. `tools` and `fs` are **conventions** worth keeping — a model has strong priors about what `tools.search(...)` and `fs.readFile(...)` mean, and spending those priors costs nothing — but they are idioms in this sentence and nowhere in the types. Flat is right where flat reads better, which is why `tenantId` sits at the top.

A nested record is a namespace whether you meant it as an API or as data, and the program cannot tell the two apart. Namespaces are **frozen**, so a program cannot swap `tools.recall` for something of its own. Arrays and non-plain objects (a `Date`, a `Map`) are always values — they cross as data, not as scopes.

Every binding function is async, because every placement crosses some boundary and a synchronous one could not be honored at all of them. That is a **typing** contract: the signature requires a Promise, and the harness does not police a cast that defeats it.

> [!NOTE]
> A function nested in a namespace needs its parameter annotated — `(input: unknown)` above — where a top-level one infers. TypeScript will not carry a contextual parameter type through a union member's index signature, and "an entry is a callable **or** a record" is exactly that union. Every binding receives `unknown` regardless; the annotation only writes down what the type already said.

Names must be plain identifiers, and `__proto__`, `constructor` and `prototype` are refused **at every depth** — these become ambient names and property paths inside an engine. That rule is also what makes the audit record readable: a key can never contain a `.`, so the dotted paths below are unambiguous.

## Contexts, and the one-shot

`code.execute` is sugar for a context used once. Open one yourself when several programs should share state:

```ts
const context = await code.createContext({ bindings, budgets });
try {
  await context.execute(firstProgram);
  const answer = await context.execute(secondProgram); // sees what the first left behind
  return answer;
} finally {
  await context.dispose();
}
```

Executions on one context are **serialized** by the harness: a second call queues behind the first, so the REPL axis reads the same way against every provider instead of depending on whether that engine happens to be reentrant. Disposing **aborts** whatever is running — the program is stopped and the execution settles `CodeAborted`; the provider's context is torn down only once it has, never out from under a running program. The same rule governs session close.

Whether state actually survives between executions is the provider's claim — `code.capabilities().persistentContext` — and the conformance suite holds it to that claim in BOTH directions, including that one context never reads another's state.

## Budgets

Three ceilings, all optional, all per-execution:

| Budget        | Effect when exceeded                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `timeMs`      | The program is stopped: `outcome: "budget-exceeded"`.                                                         |
| `memoryMb`    | The program is stopped: `outcome: "budget-exceeded"`. No shipped runtime enforces it yet.                     |
| `outputBytes` | Output is **cut** — stdout and stderr share one combined ceiling — and the program runs on and still answers. |

`outputBytes` shapes rather than kills because discarding a computed answer over chatty logging is the wrong trade — the cut streams are named in `result.truncated`.

A provider declares which of the three it can actually enforce. Ask for one it does not, and you get an error rather than a ceiling that silently does nothing:

```ts
code.capabilities(); // { name: "fake", enforces: ["timeMs", "outputBytes"], persistentContext: true }

await code.createContext({ budgets: { memoryMb: 64 } });
// throws CodeBudgetUnsupported — the fake runtime does not enforce memoryMb
```

## Running TypeScript

What a program is written in belongs to the runtime, not to this package — nothing in the contract names a language. The default runtime accepts TypeScript on request:

```ts
import { hostRuntime } from "@agentick/code-host";

createApp(<Agent />, { code: defineCode({ runtime: hostRuntime({ language: "typescript" }) }) });
```

The mode is **additive**. JavaScript is valid TypeScript, so every program that ran before still runs; what you gain is that annotations, `interface`, `enum` and `as` stop being parse errors, so the model can write in the language your bindings are documented in:

```ts
const result = await code.execute({
  source: `
    interface Order { id: string; dueAt: string; shippedAt: string }
    const rows = (await tools.query({ table: "orders" })) as Order[];
    const late: Order[] = rows.filter((row) => row.shippedAt > row.dueAt);
    return { late: late.length };
  `,
});
```

> [!IMPORTANT]
> **Types are stripped, not checked.** The transform erases annotations without building a type graph, so a program `tsc` would reject still runs — `const n: number = "seven"` executes, and the mistake surfaces at runtime or not at all. Real checking is a decision about what the model is allowed to run, which makes it a [pre-run pipeline](#pre-run-pipelines): a guard that runs a checker and vetoes, or a hook that logs the diagnostics. [@agentick/code-host](../code-host#pre-run-pipelines) works both examples through.

The provider says which mode it is in — `code.capabilities().name` reads `host:node+ts` — and the audit record is unaffected: the journal carries the TypeScript you passed, and `codeHash` digests that, because transpilation happens inside the provider, below the audit boundary.

## Stopping a program

A budget is a ceiling you set in advance. Abort is the door you use when you change your mind:

```ts
const controller = new AbortController();
const running = code.execute({ source, signal: controller.signal });
controller.abort("the user navigated away");

await running; // rejects CodeAborted — the program was stopped, not answered
```

The signal reaches the program itself, not just the promise you were waiting on. Cancellation is a rejection rather than a fifth outcome, on the same line the outcomes already draw: an outcome is what the program _answered_, and a stopped program answered nothing.

You often need none of this. The framework already threads the enclosing operation's own signal into every execution, so a cancelled turn or an aborted tool dispatch tears down the running program with no signal passed here.

## Pre-run pipelines

Everything that should happen to a program between "the model wrote it" and "the engine ran it" hangs off one command, `code:execute`. Three seams carry it. Pick by what the pass needs to DO:

| The pass…                                        | Use                      | Style       |
| ------------------------------------------------ | ------------------------ | ----------- |
| rewrites the source (fix, format, instrument)    | `onBeforeCodeExecute`    | plain async |
| observes and proceeds (log, count, sample)       | `onBeforeCodeExecute`    | plain async |
| needs the answer too (time it, retry, `finally`) | `onCodeExecute`          | plain async |
| **refuses** the program outright                 | `guard({ codeExecute })` | plain async |

Hooks transform and observe; guards refuse — and every one of them is a plain function returning plain data. Nothing on this page needs Effect.

### Transforming: the pipeline that rewrites

`onBeforeCodeExecute` receives the command's input and returns it. Return a changed `source` and the changed program is what executes:

```ts
const codeHarness = session.code as CodeHarness;

codeHarness.hook({
  onBeforeCodeExecute: async (input) => {
    const fixed = await lintFix(input.source); // your linter, in your process
    return { ...input, source: fixed };
  },
});
```

Passes compose in registration order, each one seeing what the last produced — which is what makes this a pipeline rather than a hook:

```ts
codeHarness.hook({
  onBeforeCodeExecute: async (input) => ({ ...input, source: await format(input.source) }),
});
codeHarness.hook({
  onBeforeCodeExecute: async (input) => ({ ...input, source: instrument(input.source) }),
});
```

**A rewrite is recorded, not hidden.** The `requested` envelope is published before any hook runs, so it holds the program as ASKED FOR. When the string handed to the provider differs, the harness emits `code:execute:rewritten` carrying both digests and the source that actually ran. No such event means the requested envelope IS what ran — the absence is the guarantee, and it holds because the executed digest is re-derived from the exact string the provider received. A rewriting pass cannot leave the journal describing a program nobody executed.

### Observing: the pass that only watches

Return nothing and the input passes through untouched. The op's own logger is on `ctx`, so a warning correlates with the execution that provoked it:

```ts
codeHarness.hook({
  onBeforeCodeExecute: (input, ctx) => {
    const findings = lint(input.source);
    if (findings.length > 0) ctx.log.warn({ msg: "lint findings", count: findings.length });
  },
});
```

This is the shape to reach for first when you are not yet sure a rule should block. Ship it as a warning, read the logs, promote it to a guard once you know.

### Around: the pass that needs both faces

`onCodeExecute` is the whole middleware — `(input, next, ctx)` — for anything that must see the answer as well as the program: timing, `try`/`finally`, a retry:

```ts
codeHarness.hook({
  onCodeExecute: async (input, next, ctx) => {
    const startedAt = Date.now();
    try {
      return await next(input);
    } finally {
      ctx.log.info({ msg: "program finished", ms: Date.now() - startedAt });
    }
  },
});
```

Calling `next` is what runs the program. Not calling it short-circuits — but a refusal belongs in a guard, where it is recorded AS a refusal.

### Blocking is a guard, not a hook

A guard is where deployment policy reads a program and decides. It runs before the provider is touched, so a veto means nothing executed. `guard` takes a bag keyed by the command, and the decider — plain, sync or async — returns a verdict:

```ts
codeHarness.guard({
  codeExecute: (input) =>
    input.source.includes("child_process")
      ? { kind: "veto", reason: "no subprocess spawning" }
      : { kind: "proceed" },
});
```

`input` is typed from the command, so `source`, `codeHash`, `bindings` and `budgets` are all there with no annotation. A verdict is data — `proceed`, `veto`, `defer`, or `replace` with a result of your own — and returning nothing means proceed:

```ts
codeHarness.guard({
  codeExecute: (input) => {
    if (input.bindings.includes("tools.deleteAll")) {
      return { kind: "veto", reason: "destructive binding in scope" };
    }
    if (input.source.length > MAX_PROGRAM_BYTES) {
      return { kind: "veto", reason: "program too large to review" };
    }
  },
});
```

> [!WARNING]
> **`codeHash` identifies the program, not the program-in-context.** It is a digest of the source alone — the bindings, the values they close over and the identity they run as are all outside it. Two tenants running the same one-line program produce the same hash, so keying a result cache or a replay on it serves one tenant's answer to another. Use it to correlate and to allowlist; never to skip an execution.

The program itself is right there on `input.source`, which is what makes a **lint gate** the natural shape — and a better control than a name veto, because it constrains what the code DOES rather than what it could reach:

```ts
codeHarness.guard({
  codeExecute: (input) => {
    const findings = lint(input.source);
    if (findings.length > 0) return { kind: "veto", reason: `lint: ${findings[0]!.message}` };
  },
});
```

Nothing runs when it vetoes: the provider is never touched, and the caller sees the refusal.

`input.bindings` is every leaf of the context as a **dotted path** — `["tenantId", "tools.deleteAll", "tools.recall"]` — so a policy names exactly what was in scope, down to the namespace it sat in. A name-based veto is a real control, but know its edge: names are the CALLER's choice, so a policy that refuses `tools.deleteAll` is satisfied by a caller who binds the same function as `tools.cleanup`. It constrains the code the model writes, not the bindings your own code hands it — which is the right division, because the caller is the one you already trust.

### What the record says about all of it

The same op machinery writes the audit record: the **requested** envelope carries the `source`, its `codeHash`, and the **names** of what was in scope — never the binding functions or the values behind them, and `code:execute:rewritten` covers the case where a pass changed the program.

Be precise about how far that goes. It is a promise about what the harness copies into the record, not a guarantee that a secret cannot reach the journal: **results, output streams and error causes are journaled in full**, so a program that returns or prints an API key has published it. Redacting results is your policy layer; a guard is where a binding too sensitive to risk gets refused before it is ever in scope.

One ordering note: a guard that **replaces** a result short-circuits the operation, so `onAfterCodeExecute` never sees it. An audit sink that must observe every answer belongs in the guard, not the hook.

Every one of those envelopes is stamped with the context it ran in, so you can follow a single context out of a session that is running several:

```ts
app.events({ scope: { codeContextId: context.id } });
```

## Writing a runtime

A provider owns language, engine and isolation. The whole contract is three methods:

```ts
import type { Runtime, CodeRuntimeContext } from "@agentick/code";

export function myRuntime(config: MyConfig): Runtime {
  return {
    capabilities: { name: "mine", enforces: ["timeMs"], persistentContext: false },
    async createContext({ bindings, budgets }): Promise<CodeRuntimeContext> {
      const child = await spawnEngine(config, bindings, budgets);
      return {
        execute: (source, options) => child.run(source, options?.signal),
        dispose: () => child.kill(),
      };
    },
    async dispose() {},
  };
}
```

Honoring `options.signal` is required of every provider, not a capability you declare — a runtime that cannot stop a program cannot enforce a `timeMs` budget either. Check `signal.aborted` before you start _and_ register a listener; a listener attached after the abort never fires.

An engine that has to bind to a **session** — a placed one that adopts the session's sandbox — implements `RuntimeProvider` instead. It has two methods for two separate concerns. `capabilities()` describes the engine — name, enforced budgets, persistence — which no sandbox touches, so it takes no installer and is resolved once **at install**, sandbox-free, to keep `code.capabilities()` a plain synchronous read. `resolve(installer)` binds the full session runtime and is deferred to the **first program**: that is where a placed engine reaches the sandbox namespace (registered by then) and where the one warm engine per session is built. A session-blind engine writes only trivial versions of both; hand `defineCode({ runtime })` a plain `Runtime` and its `.capabilities` are read directly.

Then certify it. The suite cannot author source in your language, so you supply the vocabulary and it drives the contract through it:

```ts
import { runCodeConformance } from "@agentick/code/testing";

runCodeConformance({
  label: "myRuntime",
  makeRuntime: () => myRuntime(config),
  source: {
    returns: (value) => `return ${JSON.stringify(value)}`,
    noValue: () => `;`,
    throws: (message) => `throw new Error(${JSON.stringify(message)})`,
    callsBinding: (name, input) => `return await ${name}(${JSON.stringify(input)})`,
    readsValue: (name) => `return ${name}`,
    swapsBinding: (name) => `try { ${name} = null } catch {} return await ${name}({})`,
    writes: (stream, text) =>
      `console.${stream === "stdout" ? "log" : "error"}(${JSON.stringify(text)}); return "done"`,
    blocks: () => `await new Promise(() => {})`,
    exceeds: (budget, limit) => (budget === "timeMs" ? `await sleep(${limit * 2})` : `…`),
  },
});
```

Every budget you declare in `enforces` must come with an `exceeds` program that really overruns it, and `persistentContext: true` must come with `remembers` / `recalls`. A capability nobody can exercise is a capability nobody should believe. `blocks` has no such escape: the suite aborts it mid-flight and requires the run to settle.

## Mounting — a definition or a live instance

```ts
createApp(<Agent />, { code: defineCode({ runtime }) }); // the slot
createApp(<Agent />, { extensions: [withCode({ runtime })] }); // the escape hatch
createApp(<Agent />, { code: existingCodeHarness }); // a live instance you own
```

The slot and the extension take the same flat bag. An explicit `withCode(...)` overrides the slot. Hand over a live instance and its lifecycle stays yours — it is not closed with the session; a definition-built harness is, along with every context it opened and the runtime itself.

**Presence, in three states.** `session.code` is `undefined` until something installs the namespace — nothing is minted for a session that never asked, so an app that does not use code pays nothing and a handler reading `ctx.code?` gets a clear absence rather than a harness that cannot work. Installed with a runtime, it answers. Installed as a live instance you built but have not bound yet, it is present and every use fails `CodeProviderMissing` until you call `bindRuntime` — the one path to a mounted-but-unbound harness, and deliberately more work than naming a runtime:

```ts
const harness = new CodeHarness(id, journal, bus, inbox);
createApp(<Agent />, { code: harness }); // present; execute() throws CodeProviderMissing
harness.bindRuntime(await chooseRuntime()); // …and now it answers
```

Inside a tool handler, reach the same instance through `ctx.code`:

```ts
const executeCode = createTool({
  name: "execute_code",
  input: z.object({ source: z.string() }),
  async handler({ source }, { ctx }) {
    const result = await ctx.code?.execute({ source, bindings: { tools } });
    return [{ type: "text", text: JSON.stringify(result) }];
  },
});
```

## API

| Export               | What it is                                                                       |
| -------------------- | -------------------------------------------------------------------------------- |
| `defineCode`         | The namespace definition. Every field optional; inert until install.             |
| `withCode`           | The session-extension form of the same bag.                                      |
| `CodeHarness`        | The harness class. `guard`, `hook`, `bindRuntime`, `fx`.                         |
| `Runtime`            | The provider contract: `capabilities`, `createContext`, `dispose`.               |
| `RuntimeProvider`    | Binds an engine: `capabilities()` at install, `resolve(installer)` on first use. |
| `CodeRuntimeContext` | One live context: `execute`, `dispose`.                                          |

`defineCode` / `withCode` take:

| Field      | Default               | What it is                                                          |
| ---------- | --------------------- | ------------------------------------------------------------------- |
| `runtime`  | `@agentick/code-host` | A live `Runtime` or a `RuntimeProvider`. Absent → the default host. |
| `bindings` | none                  | The base context every program gets; a context merges over it.      |
| `budgets`  | none                  | Base ceilings, overridden per key by a context.                     |

The default runtime is `@agentick/code-host`, imported by name rather than depended on — that package depends on this one, and an edge back would be a cycle. The engine is resolved at install (to read its capabilities), so `code: {}` with the package absent fails `CodeProviderMissing` — naming it — at session creation rather than at boot. An explicit `runtime` skips the lookup entirely.

`runCodeConformance` ships from `@agentick/code/testing`, not from the main entry point — it imports vitest, and a production bundle should never load a test framework.

Session surface (`session.code`, `ctx.code`, `bridges.code` — all optional):

| Member                    | Returns                                                                   |
| ------------------------- | ------------------------------------------------------------------------- |
| `execute(input)`          | `Promise<CodeExecuteResult>` — the one-shot.                              |
| `createContext(options?)` | `Promise<CodeContext>`.                                                   |
| `capabilities()`          | `CodeCapabilities` — a sync read; the engine is resolved once at install. |
| `hasRuntime()`            | `boolean` — is an engine configured, asked without a throw.               |
| `fx.execute(input)`       | The Effect twin, for callers already inside an operation.                 |

The one-shot takes ONE bag — `{ source, bindings?, budgets?, signal? }`, typed `CodeOneShotInput` — which is exactly what `createContext` takes plus the program, because it IS a context used once. One object rather than a positional program beside its options, so every hook, guard and middleware handles the same shape.

The method is named for the command it rides. `context.execute(source)` on an OPEN context is the same verb, and stays positional on purpose: it is a REPL call whose whole point is that the context was already configured, and a guard sees the command's bag either way.

Errors: `CodeProviderMissing`, `CodeBudgetUnsupported`, `CodeContextDisposed`, `CodeRuntimeFailed`, `CodeAborted`, `CodeResultInvalid` (the provider broke the result contract), `CodeBindingNameInvalid` (refused at `createContext`), `CodeRuntimeAlreadyBound` (`bindRuntime` binds once), `CodeHarnessClosed`.

`fx.execute` takes only `{ contextId, source }`. The digest and the binding names in the audit record are the harness's to derive — if a caller could supply them, a guard deciding on those fields could be handed a description of a different program.

## Testing

`@agentick/code/testing` ships a working runtime whose language is a recorded instruction list — deliberately not a JavaScript evaluator, so a test that passes against it is a statement about the contract rather than about `eval`:

```ts
import { fakeCode, fakeCodeHarness, fakeCodeSource, fakeProgram } from "@agentick/code/testing";

const { harness, journal, close } = await fakeCodeHarness({ runtime: fakeCode() });
const result = await harness.execute({ source: fakeProgram({ op: "return", value: 42 }) });
```

`fakeCodeSource` is the vocabulary form of the same instruction set, so consumers can drive their own tests without knowing the encoding.

## Patterns

- **Sandboxed placement** — [@agentick/sandbox](../sandbox) contains a runtime rather than replacing it. There is no dependency between the two packages: a provider that accepts a process host takes a sandbox handle because the shapes line up, and you compose them at the call site.
- **Tools inside programs** — bind [@agentick/tool-executor](../tool-executor) dispatch under a `tools` namespace and every call the program makes is still a real, journaled dispatch with its own guards.
- **Files inside programs** — bind [@agentick/resources](../resources) reads under an `fs` namespace to give a program a read-only view of content that already exists somewhere else.

## Roadmap & known gaps

- **One runtime ships.** [@agentick/code-host](../code-host) runs programs in a subprocess of the host's own engine. `fakeCode` remains a test double, and an in-process isolate is still to come.
- **No model-facing tool.** Deciding which tools a program may reach, generating the type stubs that tell the model what is in scope, and the `execute_code` tool itself belong to a code-mode layer built on top of this one. Nothing here is exposed to a model by default.
- **Contexts do not survive a restart.** A context holds live provider resources; a checkpoint and resume recreate nothing. Programs are journaled, contexts are not.
- **`code:execute` is in-process only.** It is deliberately not addressable over the inbox or the wire, so there is no remote path to it and no client surface for it.
- **Multiple runtimes in one session** — a trusted runtime beside an untrusted one — is not built. Binding at config leaves room for it additively.
- **A signal is per-context, not per-execution.** Aborting a long-lived context cancels the program in flight and every one after it, because the signal stays aborted. For a single bounded program, use the one-shot `code.execute`, which is a context used once.

## Verified by

- `src/__tests__/conformance.spec.ts` runs the exported suite (`src/conformance.ts`) against the reference runtime twice — fully capable, and declaring neither budgets nor persistent context — so both sides of every capability branch execute. The suite holds ONLY provider-differentiating claims: the context lifecycle and the one-shot `execute`; all four result discriminants; function and value bindings reachable by name, a nested one reachable through its namespace, and a namespace that cannot be swapped; stdout staying a side channel; an undeclared budget refused; every declared budget really enforced, with `outputBytes` shaping (the value still returned) where the others kill; `persistentContext` asserted in both directions plus cross-context isolation; a mid-flight abort stopping the PROGRAM, proven by a sentinel binding a still-running program would have reached; and the requested envelope naming bindings without carrying their values, beside its honest counterpart — a program that RETURNS a secret publishes it.
- `src/__tests__/harness.spec.ts` — everything true of the envelope rather than of a provider: inert until `bindRuntime` and bound only once; a provider failure at context creation surfacing as `CodeRuntimeFailed`; the guard seeing source, digest and binding names, and being able to replace an answer without running it; `fx.execute` composing in the caller's fiber, journaling the true digest, and offering no field through which a binding-name veto could be defeated; interrupting the operation fiber reaching a program given no caller signal at all; dispose and close aborting an in-flight program and tearing down only after it settles; two concurrent executions on one context strictly ordered; duplicate, prototype-member and non-identifier binding names refused before the provider is touched; `createContext` after close refused; a malformed provider result rejected and an omitted `truncated` filled; the one-shot returning the answer when disposal fails; the verb's internal exposure and an inbox message naming it refused; every envelope carrying its `codeContextId`; `capabilities()` reading synchronously off the engine; and `defineCode` being identity plus a non-enumerable brand.
- `src/__tests__/readme-examples.type.spec.ts` — every example on this page, compiled against the current exports.
- [@agentick/app](../app) proves the adopter entry point: a bound runtime round-tripping through `session.code.execute` with `bridges.code` naming the same instance; an adopter-owned harness present, failing until `bindRuntime`, and — the point of the facade — surviving session close with its runtime undisposed; an omitted slot installing nothing; and a dispatched tool handler reaching the harness through `ctx.code`.
