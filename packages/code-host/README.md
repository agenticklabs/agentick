# @agentick/code-host

**Run the model's code on the engine you already trust to run your app.** This is the default runtime for [@agentick/code](../code), and its subprocess one: it spawns `process.execPath` — node or bun, whichever is running your host — hands the program its bindings as ambient async functions, and returns a typed outcome. There is no engine to pick and no toolchain to install, because the engine is the one you are already on.

What differs between those engines is declared, not hidden. `timeMs` and `outputBytes` are enforced by the parent process, so they hold whatever the child is. `memoryMb` needs the engine's own heap ceiling, and only one engine has one that works — so under bun that budget is absent from `capabilities.enforces` and asking for it is an error rather than a ceiling that quietly does nothing.

> [!WARNING]
> **By default this is placement, not containment.** The child is an ordinary process of the same user, with the same filesystem and the same network. Containment is one argument away — `hostRuntime({ host: sandboxHostPort(sandbox) })` runs the same program inside a jail — but you have to ask for it. Read [Trust posture](#trust-posture) before you point the default at a program you did not write.

## Install

```bash
npm install @agentick/code @agentick/code-host
```

Subpaths: `/testing` (the JavaScript source vocabulary this provider is certified with).

## Quick start

**This is the default runtime.** Install it and name the namespace — there is no token to pass:

```tsx
const app = await createApp(<Agent />, { model, code: {} });
```

`@agentick/code` resolves this package at install, so `code: {}`, `defineCode()` and a bare `withCode()` all land here. Name it explicitly when you want to configure it:

```tsx
import { withCode } from "@agentick/code";
import { hostRuntime } from "@agentick/code-host";

const app = await createApp(<Agent />, {
  model,
  extensions: [withCode({ runtime: hostRuntime({ cwd: "/srv/scratch" }) })],
});

const session = await app.createSession();
const code = session.code!;

const result = await code.execute({
  source: `
    const rows = await tools.query({ table: "orders", since });
    const late = rows.filter((row) => row.shippedAt > row.dueAt);
    console.log(\`checked \${rows.length} orders\`);
    return { late: late.length, worst: late.at(-1) };
  `,
  bindings: {
    tools: { query: (input: unknown) => session.tools.dispatch("query", input) },
    since: "2026-01-01",
  },
  budgets: { timeMs: 5_000, outputBytes: 64_000 },
});

if (result.outcome === "returned") console.log(result.value); // { late: 3, worst: {…} }
```

A program is an **async function body**: `return` answers, top-level `await` is ordinary, and every binding is a name already in scope. No imports, no wrapper, no exports.

The `bindings` you pass ARE the program's globals — keys inject verbatim, and a nested record becomes a namespace object. `tools` and `fs` are conventions the model already has priors for, not framework schema; put a plain value at the top level when that reads better.

## Running TypeScript

One option, and it is additive:

```ts
hostRuntime({ language: "typescript" });
```

JavaScript is valid TypeScript, so a TypeScript-mode runtime accepts every program a JavaScript-mode one does — the same conformance suite certifies both, unchanged. What you gain is that annotations, `interface`, `enum` and `as` no longer break the parse, so the model can write in the language your bindings are documented in:

```ts
const result = await code.execute({
  source: `
    interface Order { id: string; dueAt: string; shippedAt: string }
    const rows = (await tools.query({ table: "orders", since })) as Order[];
    const late: Order[] = rows.filter((row) => row.shippedAt > row.dueAt);
    return { late: late.length };
  `,
});
```

Types are stripped by [esbuild](https://esbuild.github.io) in **your** process, before the source crosses the membrane, and the child stays the plain engine it always was. That costs about a third of a millisecond per execution once esbuild's service is warm, against roughly seven for the first program that pays to start it.

> [!IMPORTANT]
> **This is a transpiler, not a typechecker.** esbuild erases types without checking them, so a program `tsc` would reject still runs — `const n: number = "seven"` executes, and the mistake surfaces as a runtime error later, or never. Type _checking_ is a decision about what the model is allowed to run, which makes it policy: [Pre-run pipelines](#pre-run-pipelines) is where it goes.

The capability name carries the marker, so a journal reader can tell which mode ran:

```ts
code.capabilities(); // { name: "host:node+ts", enforces: [...], persistentContext: true }
```

The audit record does not change: `code:execute` journals the TypeScript you handed the harness, and its `codeHash` is a digest of that. Transpilation happens inside the provider, below the audit boundary — hashing the emitted JavaScript instead would make an allowlist entry depend on which esbuild version ran.

## What the engine gives you

`capabilities` is measured, not assumed — the numbers below come from running an allocation loop under each engine and watching what happened.

|             | `timeMs` | `outputBytes` | `memoryMb`                   | `persistentContext` |
| ----------- | -------- | ------------- | ---------------------------- | ------------------- |
| `host:node` | yes      | yes           | yes — `--max-old-space-size` | yes                 |
| `host:bun`  | yes      | yes           | **no**                       | yes                 |

bun accepts `--max-old-space-size` _and_ `--smol`, exits zero on both, and enforces neither: an allocation loop outlives a 3-second watch at every setting, where node dies in about a tenth of a second at the same limit. Accepting a flag is not enforcing a budget, so bun's capabilities leave `memoryMb` out and the harness refuses it up front:

```ts
code.capabilities(); // { name: "host:bun", enforces: ["timeMs", "outputBytes"], persistentContext: true }

await code.createContext({ budgets: { memoryMb: 64 } });
// throws CodeBudgetUnsupported — bun has no heap ceiling this provider can stand behind
```

Any engine that is neither gets `timeMs` and `outputBytes`, since those are the parent's to enforce. The language shapes only the name — `host:node+ts` enforces exactly what `host:node` does, because the transform happens before the child is involved at all.

## A context is a process

`persistentContext` is literal here: one child process serves every execution on a context, so whatever a program leaves on `globalThis` — plus its timers, its open handles and anything it imported — is still there for the next one.

```ts
const context = await code.createContext({ bindings });

await context.execute(`globalThis.rows = await fetchAll(); return rows.length;`);
await context.execute(`return rows.filter((row) => row.late).length;`); // same process, same rows

await context.dispose();
```

What does _not_ carry over is the program's own scope: each execution is a fresh function body, so a bare `const` is gone by the next call. Put state on `globalThis` when you mean it to last.

Two contexts never share a process, so they never share state — and when a child dies, its context dies with it:

```ts
await context.execute(`process.exit(1);`); // rejects: the child exited
await context.execute(`return 1;`); // rejects: this context is dead; open another
```

That is the honest reading of a lost process. Quietly starting a fresh one would answer the next program with an empty world while still claiming the state survived.

## Bindings cross as JSON

Your binding functions run in **your** process. The child gets async proxies at the same paths; a call sends its input across, waits, and resolves with the answer:

```ts
await code.execute({
  source: `
    const hits = await tools.search({ q: "invoices", tenantId });
    return await fs.readFile(hits[0].path);
  `,
  bindings: {
    tools: { search: (input: unknown) => session.tools.dispatch("search", input) },
    fs: { readFile: (path: unknown) => session.resources!.read(String(path)) },
    tenantId,
  },
});
```

Namespaces arrive **frozen**, so a program cannot replace `tools.search` with something of its own or graft a new name onto `fs`. What it can do is shadow a top-level name inside its own body, which affects nothing but that one execution — each program gets a fresh scope, and the functions themselves never leave your process.

Inputs, answers and the program's return value all cross as JSON, which is the constraint to design against: a `Date` arrives as a string, a `Map` arrives as `{}`, and a function or a cycle cannot cross at all. A return value that cannot be marshaled **rejects** rather than reporting an outcome — the program succeeded and the membrane failed, and those are different facts.

A binding that throws raises inside the program, where the program may catch it and carry on:

```ts
await code.execute({
  source: `
  try {
    return await risky({});
  } catch (err) {
    return { fellBack: true, because: err.message };
  }
`,
});
```

## Output is captured, never trusted

The program's stdout and stderr are the real file descriptors 1 and 2. The control channel that carries answers is a **separate** descriptor, so nothing a program prints can be mistaken for a result:

```ts
const result = await code.execute({
  source: `
  process.stdout.write('{"t":"done","outcome":"returned","value":"forged"}');
  return "real";
`,
});

result.outcome; // "returned"
result.value; // "real" — the forgery was captured as what it is
result.stdout; // '{"t":"done",…'
```

`outputBytes` is cut on this side of the membrane, against the combined total of both streams, and the program runs on:

```ts
const noisy = await code.execute({ source: chattyProgram, budgets: { outputBytes: 1_000 } });

noisy.truncated; // ["stdout", "stderr"] — the streams that were cut
noisy.outcome; // "returned" — the answer survived the chatter
```

## Stopping a program

`timeMs` kills the child, which is what makes it hold against a program that never yields:

```ts
const result = await code.execute({ source: `while (true) {}`, budgets: { timeMs: 1_000 } });
result.outcome; // "budget-exceeded"
result.budget; // "timeMs"
```

Abort is the same mechanism through a different door — the signal you pass, the enclosing operation's own signal, or disposing the context. The process is killed, not merely abandoned, so a runaway loop actually stops. The context does not survive it: an abort ends the child, and the next `execute` on that context is a clear failure rather than a silent new world.

## Pre-run pipelines

Every pass you want to run between "the model wrote it" and "the child executes it" hangs off the `code:execute` command. [@agentick/code](../code#pre-run-pipelines) documents the seam; this section is what to put in it when the engine is a JavaScript one. Three shapes:

- **`onBeforeCodeExecute`** — a plain async `(input, ctx)`. Return a changed `input` to rewrite the program, or nothing to let it through.
- **`onCodeExecute`** — the plain async `(input, next, ctx)` middleware, when the pass needs the answer too.
- **`guard({ codeExecute })`** — a plain sync/async decider returning a verdict. The only one that can refuse.

### Transforming: prepend a strict-mode directive

An async function body is **sloppy mode**, which is why a program assigning over a frozen namespace fails silently. A one-line rewrite makes those mistakes loud, and loud mistakes are feedback the model can act on:

```ts
import type { CodeExecuteInput, CodeHarness } from "@agentick/code";

const codeHarness = session.code as CodeHarness;

codeHarness.hook({
  onBeforeCodeExecute: (input: CodeExecuteInput) => ({
    ...input,
    source: `"use strict";\n${input.source}`,
  }),
});
```

```ts
// tools.search = async () => "swapped"; return await tools.search({});
// sloppy: { outcome: "returned", value: "original" }  — the assignment vanished
// strict: { outcome: "threw", error: { name: "TypeError", … } } — and the model can read it
```

The rewrite is recorded: because the executed source differs from what was asked for, the harness emits `code:execute:rewritten` with both digests, so the journal shows the program the model wrote _and_ the one that ran.

> [!WARNING]
> **Do not put the TypeScript transform in a hook.** Reaching for `transpiler()` here to pre-strip types would work and would be wrong: every execution would fire a rewrite event, and the journal would carry emitted JavaScript instead of the program its author would recognize. `language: "typescript"` does the transform inside the provider, below the audit boundary, which is exactly why the record stays readable.

### Observing: watch without touching

Return nothing and the input passes through unchanged. The op's own logger is on `ctx`, so what you write correlates with the execution that provoked it:

```ts
codeHarness.hook({
  onBeforeCodeExecute: (input: CodeExecuteInput, ctx) => {
    if (input.source.length > 8_000) {
      ctx.log.warn({ msg: "large program", bytes: input.source.length, hash: input.codeHash });
    }
  },
});
```

Start here when you are not yet sure a rule should block. Ship it as a warning, read what it catches, promote it to a guard once you know.

### Blocking: does it parse?

The cheapest useful gate, and the one you can afford on every execution. `transpiler` is the runtime's own check, exported so your gate cannot disagree with it — a program is an async function _body_, which no parser accepts on its own, so a hand-rolled `esbuild.transform(input.source)` would reject every program with a top-level `return`:

```ts
import { transpiler } from "@agentick/code-host";

const parses = transpiler("typescript");

codeHarness.guard({
  codeExecute: async (input) => {
    const checked = await parses(input.source);
    if (!checked.ok) return { kind: "veto", reason: `will not parse — ${checked.message}` };
  },
});
```

> [!NOTE]
> **Only a guard can stop a program.** Returning early from `onBeforeCodeExecute` does not refuse anything — the hook is a transform, and a hook that "decides" is a gate that cannot actually close. That mix-up is the most common way to ship a policy that never blocks.

Use `transpiler("typescript")` whichever mode the runtime is in: TypeScript's grammar is a superset, so it parses JavaScript too, and it is the only one of the two that can fail.

### Blocking: does it typecheck?

Same seam, a real checker behind it. esbuild cannot do this — it never builds a type graph — so the checker is the `typescript` compiler API, which this package deliberately does not bundle. You bring it, and you decide what it knows about: the declarations for your bindings are what make the check worth anything.

```ts
declare function diagnose(source: string): readonly string[]; // your ts.LanguageService

codeHarness.guard({
  codeExecute: (input) => {
    const problems = diagnose(input.source);
    if (problems.length > 0) return { kind: "veto", reason: `typecheck: ${problems.join("; ")}` };
  },
});
```

Be clear-eyed about the price. A parse is microseconds; a typecheck is a program built against `lib.d.ts` and your declarations, which is tens of milliseconds against a warm `LanguageService` you keep between executions and hundreds if you build one per call. You are buying a diagnostic the model can act on now instead of a `TypeError` it discovers three tool calls later — worth it when programs are long-lived and bindings are richly typed, and not worth it for one-line queries.

One variation worth knowing: a guard can return `{ kind: "replace", result }` instead of a veto, which hands the diagnostics back as an ordinary `CodeExecuteResult`. The model then reads them as its program's answer rather than as a failed operation, which is often the shape you want when the check exists to teach rather than to enforce.

## Trust posture

`hostRuntime()` runs the program as a plain child of your app, under your user, with your filesystem and your network. What it gives you is memory isolation from the host process and a kill switch. What it does **not** give you is a jail.

Two things are in your hands today:

```ts
hostRuntime({
  env: { DATA_DIR: "/srv/scratch" }, // the default is an EMPTY environment
  cwd: "/srv/scratch",
});
```

The environment is empty unless you fill it, so a program inherits none of your host's secrets by accident — but `env` and `cwd` are conveniences, not a boundary, and a program can read anything the user can.

Placement is where the boundary belongs, and it is a seam rather than a setting. `HostProcessPort` is the whole surface the runtime needs in order to have a child at all — spawn it, write to it, kill it — so a placement that _is_ a jail slots in without touching the protocol.

### Running the child in a jail

Hand `sandboxHostPort` a live `SandboxHandle` and the same supervisor runs inside that sandbox's confinement:

```ts
import { localProvider } from "@agentick/sandbox-local";
import { hostRuntime, sandboxHostPort } from "@agentick/code-host";

const sandbox = await localProvider().create({
  workspace: true,
  allow: { network: false },
});

hostRuntime({ host: sandboxHostPort(sandbox) });
```

Nothing else changes. Bindings still resolve, `console.log` still comes back as `stdout`, budgets still hold — because the jail is under the protocol, not in it. What changes is reach: on a host with a real jail, a program can no longer `fetch()` an external address or read a file outside its workspace, while it can still call its bindings and write the workspace it was given.

Two things are worth knowing before you rely on it.

**The provider states what it actually enforces.** `@agentick/sandbox-local` picks the strongest jail the host supports — macOS seatbelt, Linux bubblewrap — and reports the result on `handle.isolation`. Where no jail primitive exists, that reads `"none"` and the placement confines nothing. It is a claim you can assert on, and it never lies; check it in production rather than assuming the jail you tested with is the one you deployed onto.

**A jail is not a sandbox in the V8 sense.** The program still runs on a full engine with the whole standard library. What the jail removes is reach to the filesystem and the network; what it does not remove is the engine's own surface. A provider that denies capability by construction rather than by confinement is a different runtime, and composes inside this one.

Not every provider can offer a live process — `SandboxHandle.spawn` is capability-tiered — so `sandboxHostPort` throws `SandboxUnsupportedError` at wiring time when the handle you gave it has no such surface, rather than on the first program a model writes.

## API

```ts
import { hostRuntime, detectEngine, childProcessPort, sandboxHostPort } from "@agentick/code-host";
```

| Export                                | What it is                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `hostRuntime(config?)`                | The `Runtime` to hand to `withCode` / `defineCode`. Also what they resolve by default. |
| `detectEngine()`                      | The engine this host is running: `{ name, execPath, heapLimitFlag? }`.                 |
| `hostCapabilities(engine, language?)` | What that engine, in that language, can be held to.                                    |
| `childProcessPort()`                  | The default placement — a direct child of this process.                                |
| `sandboxHostPort(handle)`             | Placement inside a `SandboxHandle`'s jail. Throws if the provider has no live process. |
| `transpiler(language)`                | The type-stripping parse the runtime itself runs. A gate's other door.                 |

`HostRuntimeConfig`, all optional:

| Field            | Default              | Meaning                                             |
| ---------------- | -------------------- | --------------------------------------------------- |
| `language`       | `"javascript"`       | `"typescript"` strips types before the engine runs. |
| `host`           | `childProcessPort()` | Where the child is placed. `sandboxHostPort` jails. |
| `env`            | `{}`                 | The child's environment. Empty inherits nothing.    |
| `cwd`            | inherited            | The child's working directory.                      |
| `execArgv`       | `[]`                 | Extra engine flags, before the entry point.         |
| `spawnTimeoutMs` | `10_000`             | How long the child has to answer the handshake.     |

Types: `HostEngine`, `HostLanguage`, `HostProcess`, `HostProcessPort`, `HostSpawnRequest`, `Transpiled`.

## Certifying your own layer

The programs this provider is certified with ship from `/testing`, so a layer built on top of it — a code-mode extension, your own wrapper runtime — can certify itself with the same vocabulary instead of inventing one:

```ts
import { runCodeConformance } from "@agentick/code/testing";
import { hostCodeProbe, hostCodeSource } from "@agentick/code-host/testing";

runCodeConformance(hostCodeProbe()); // this provider, end to end

runCodeConformance({
  label: "my wrapper",
  makeRuntime: () => myWrapperAround(hostRuntime()),
  source: hostCodeSource,
});
```

## How the default is found

`@agentick/code` imports `"@agentick/code-host"` at install and uses `hostRuntime()` if the import resolves. It does not DEPEND on this package — the dependency runs the other way, and an edge back would be a cycle — so the specifier has to resolve from where `@agentick/code` sits. Installing this package in your app is what makes that true, and a package manager that nests dependencies strictly needs it to be **your** dependency rather than a transitive one.

Nothing breaks when it does not resolve: the namespace mounts inert, `hasRuntime()` answers `false`, and the first program fails `CodeProviderMissing` with the install named in the message. If you would rather not rely on resolution at all, pass the runtime explicitly — `withCode({ runtime: hostRuntime() })` is one import and never guesses.

## Roadmap & known gaps

- **The default placement contains nothing.** Containment is opt-in through `sandboxHostPort`; the default is a direct child with your user's reach.
- **The Linux jail's control channel is unverified.** The supervisor talks to its child over an inherited descriptor, which is proven to survive macOS seatbelt (`sandbox-exec` execs the program rather than proxying it) and is expected to survive bubblewrap for the same reason — but no Linux host with `bwrap` has run the suite. Verify `packages/sandbox-local`'s jailed-spawn cases on your target before trusting the jail in production there.
- **A jailed program still has the whole engine.** The jail removes filesystem and network reach, not the engine's own surface. Denying capability by construction is a different runtime.
- **JSON is the membrane.** Values cross as JSON, with no structured-clone path for `Date`, `Map`, `Set` or binary. An unmarshalable return value rejects.
- **One process per context.** A one-shot `execute()` pays a process spawn (tens of milliseconds). There is no pooling of warm children.
- **`memoryMb` is classified from the engine's own report.** On node the verdict reads V8's heap-exhaustion message off stderr; a child killed by the OS out-of-memory reaper reports as a runtime failure instead.
- **TypeScript is stripped, never checked.** `language: "typescript"` is esbuild's erasure and nothing more; a type error executes. Checking is a guard you write, and the `typescript` API it needs is not bundled here.
- **No JSX.** The TypeScript loader is `ts`, not `tsx`, so `<div/>` in a program is a parse error rather than an element.
- **A transpiled program is reprinted.** In TypeScript mode a runtime stack trace's line numbers — and its extra `__agentick_program` frame — refer to the emitted JavaScript, not to the source you passed. No source map crosses the membrane.
- **`execArgv` is unguarded.** Flags reach the engine as given, including ones that would defeat a budget.
