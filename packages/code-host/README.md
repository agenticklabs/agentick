# @agentick/code-host

**Run the model's code on the engine you already trust to run your app.** This is the default runtime for [@agentick/code](../code), and its subprocess one: it spawns `process.execPath` — node or bun, whichever is running your host — hands the program its bindings as ambient async functions, and returns a typed outcome. There is no engine to pick and no toolchain to install, because the engine is the one you are already on.

What differs between those engines is declared, not hidden. `timeMs` and `outputBytes` are enforced by the parent process, so they hold whatever the child is. `memoryMb` needs the engine's own heap ceiling, and only one engine has one that works — so under bun that budget is absent from `capabilities.enforces` and asking for it is an error rather than a ceiling that quietly does nothing.

> [!WARNING]
> **This is placement, not containment.** The child is an ordinary process of the same user, with the same filesystem and the same network. It is isolated from your app's memory and nothing else. Read [Trust posture](#trust-posture) before you point it at a program you did not write.

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

const result = await code.run({
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

Any engine that is neither gets `timeMs` and `outputBytes`, since those are the parent's to enforce.

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
await code.run({
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
await code.run({
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
const result = await code.run({
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
const noisy = await code.run({ source: chattyProgram, budgets: { outputBytes: 1_000 } });

noisy.truncated; // ["stdout", "stderr"] — the streams that were cut
noisy.outcome; // "returned" — the answer survived the chatter
```

## Stopping a program

`timeMs` kills the child, which is what makes it hold against a program that never yields:

```ts
const result = await code.run({ source: `while (true) {}`, budgets: { timeMs: 1_000 } });
result.outcome; // "budget-exceeded"
result.budget; // "timeMs"
```

Abort is the same mechanism through a different door — the signal you pass, the enclosing operation's own signal, or disposing the context. The process is killed, not merely abandoned, so a runaway loop actually stops. The context does not survive it: an abort ends the child, and the next `execute` on that context is a clear failure rather than a silent new world.

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

Placement is where the boundary belongs, and it is a seam rather than a setting. `HostProcessPort` is the whole surface the runtime needs in order to have a child at all — spawn it, write to it, kill it — so a placement that _is_ a jail slots in without touching the protocol:

```ts
import { childProcessPort, type HostProcessPort } from "@agentick/code-host";

const audited: HostProcessPort = {
  spawn: (request) => {
    log.info({ msg: "spawning a code child", args: request.args });
    return childProcessPort().spawn(request);
  },
};

hostRuntime({ host: audited });
```

Pairing that port with a real sandbox is on the roadmap below. Until it lands, treat this runtime the way you would treat running the model's code in your own shell — because that is what it is.

## API

```ts
import { hostRuntime, detectEngine, childProcessPort } from "@agentick/code-host";
```

| Export                     | What it is                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `hostRuntime(config?)`     | The `Runtime` to hand to `withCode` / `defineCode`. Also what they resolve by default. |
| `detectEngine()`           | The engine this host is running: `{ name, execPath, heapLimitFlag? }`.                 |
| `hostCapabilities(engine)` | What that engine can be held to.                                                       |
| `childProcessPort()`       | The default placement — a direct child of this process.                                |

`HostRuntimeConfig`, all optional:

| Field            | Default              | Meaning                                          |
| ---------------- | -------------------- | ------------------------------------------------ |
| `host`           | `childProcessPort()` | Where the child is placed.                       |
| `env`            | `{}`                 | The child's environment. Empty inherits nothing. |
| `cwd`            | inherited            | The child's working directory.                   |
| `execArgv`       | `[]`                 | Extra engine flags, before the entry point.      |
| `spawnTimeoutMs` | `10_000`             | How long the child has to answer the handshake.  |

Types: `HostEngine`, `HostProcess`, `HostProcessPort`, `HostSpawnRequest`.

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

- **No containment.** `HostProcessPort` exists so a jailed placement can arrive as an implementation; pairing it with [@agentick/sandbox](../sandbox) is not built. Today the only placement is a direct child process.
- **JSON is the membrane.** Values cross as JSON, with no structured-clone path for `Date`, `Map`, `Set` or binary. An unmarshalable return value rejects.
- **One process per context.** A one-shot `run()` pays a process spawn (tens of milliseconds). There is no pooling of warm children.
- **`memoryMb` is classified from the engine's own report.** On node the verdict reads V8's heap-exhaustion message off stderr; a child killed by the OS out-of-memory reaper reports as a runtime failure instead.
- **No TypeScript transform.** Programs are JavaScript. Stripping types before execution belongs to the layer that decides what the model is allowed to write, not to the runtime that runs it.
- **`execArgv` is unguarded.** Flags reach the engine as given, including ones that would defeat a budget.
