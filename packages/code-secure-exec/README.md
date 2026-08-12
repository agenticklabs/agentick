# @agentick/code-secure-exec

**Run the model's code in an isolate that contains by construction.** This is the isolate runtime for [@agentick/code](../code): it runs each program in an in-process V8 isolate — via [`isolated-vm`](https://github.com/laverdet/isolated-vm) — that has no filesystem, no network, no `require`, no `process`, and no host global. The only surface a program can reach is the bindings you inject. Because nothing is wired in, nothing needs to be jailed out: it needs no `bwrap`, no `unshare`, no seatbelt, and runs on an image that has none of them.

It is the sibling of [@agentick/code-host](../code-host). Same [`Runtime`](../code) contract, opposite trust mechanism: `code-host` contains by **confinement** (an OS jail around a real subprocess); `code-secure-exec` contains by **construction** (an isolate with nothing in it). One runs a full shell with real tools inside a jail; the other runs pure computation over injected data with zero reach to the host.

> [!IMPORTANT]
> Containment here means the program cannot reach **out**. It does not mean the program is free: CPU is bounded by the `timeMs` timeout (an infinite loop is _stopped_, not prevented) and memory by the isolate's `memoryLimit` (bounded, not free). See [What it does — and does not — contain](#what-it-does--and-does-not--contain).

## Install

```bash
npm install @agentick/code @agentick/code-secure-exec
```

`isolated-vm` is a native (node-gyp) dependency. It ships prebuilt binaries for common platforms and Node ABIs, so most installs need no toolchain; where no prebuild matches, it compiles on install and needs a C++ toolchain. It requires **Node ≥ 24**. See [The native-module reality](#the-native-module-reality).

Subpaths: `/testing` (the JavaScript source vocabulary this provider is certified with).

## Quick start

Name the isolate runtime explicitly — unlike `code-host`, it is not the default, because it deliberately reaches nothing and most programs need _something_:

```tsx
import { withCode } from "@agentick/code";
import { secureExec } from "@agentick/code-secure-exec";

const app = await createApp(<Agent />, {
  model,
  extensions: [withCode({ runtime: secureExec({ language: "typescript" }) })],
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
  budgets: { timeMs: 5_000, memoryMb: 128 },
});

if (result.outcome === "returned") console.log(result.value); // { late: 3, worst: {…} }
```

A program is an **async function body**: `return` answers, top-level `await` is ordinary, and every binding is a name already in scope. There are no imports and no exports — there is nothing to import.

The `bindings` you pass ARE the program's globals: keys inject verbatim, a nested record becomes a frozen namespace. Everything the program can do to the outside world, it does through one of them. A program with no bindings can compute, and nothing else.

## Running TypeScript

One option, and it is additive:

```ts
secureExec({ language: "typescript" });
```

JavaScript is valid TypeScript, so a TypeScript-mode isolate accepts every program a JavaScript-mode one does — the same conformance suite certifies both, unchanged. Types are **stripped, not checked**: [esbuild](https://esbuild.github.io) erases annotations on the way in, so a type error reaches the engine at runtime rather than stopping the program. Type _checking_ is a pre-run policy seam (`guard({ codeExecute })`), the same as it is for `code-host`.

## What it does — and does not — contain

The whole value is in the honest ledger.

**Removed by construction** — a program cannot reach any of these, because they were never wired into the isolate:

- `require` / `module` / dynamic `import` — there is no module system and no host loader.
- `process` — no `process.env`, no `process.exit`, no argv.
- `fetch` / `XMLHttpRequest` — no network client of any kind.
- the filesystem — there is no binding to it unless you inject one.
- `Buffer`, `setTimeout`, `setInterval`, `queueMicrotask`, `global`, `__dirname` — Node host globals, none present.

The only names in scope are JavaScript's own built-ins (`Math`, `JSON`, `Date`, `Array`, `Promise`, …), your injected bindings, and a `console` whose `log`/`error` write to the captured output buffer — not to the host's stdout.

**NOT removed** — the two things a budget bounds rather than a boundary blocks:

- **CPU** — an infinite `while (true) {}` is stopped by the `timeMs` timeout, not prevented. Without a `timeMs` budget, a synchronous loop runs until you abort it.
- **Memory** — allocation is capped by the isolate's `memoryLimit`; a program can still allocate up to that ceiling.

**The V8-boundary caveat** — isolate containment rests on V8's isolate boundary being sound. That boundary is _far_ stronger than a `node:vm` context (which is trivially escapable and must never be used for this), but it is not a hypervisor. For hostile multi-tenant code where a V8 zero-day is in your threat model, compose this _inside_ an OS jail as well — [`sandboxHost`](../code-host#code-owns-its-jail) on `code-host` is that jail, and the axes stack.

This ledger is not prose to trust — it is [pinned by a test](src/__tests__/containment.spec.ts) that runs each of these programs against the real isolate.

## Bindings cross as JSON

A binding is a named async function you pass on the context; the program calls it by name. The call crosses the isolate boundary as **copied data**, never as a live reference:

1. The program calls `tools.query({ table })`.
2. The argument is **deep-copied out** of the isolate into the host (via `isolated-vm`'s `ExternalCopy`).
3. Your real function runs on the **host**, with full Node reach — it is your code, not the model's.
4. Its resolved value is **deep-copied back** into the isolate.

So a binding is a controlled hole in the wall: the model decides _when_ to call `tools.query` and with _what_, and you decide what `tools.query` can actually do. No live object, socket, or file handle ever crosses — only JSON-shaped data. An argument that cannot be copied (a function, a class instance, a cyclic value) is refused **at the boundary**, and the program sees the refusal as a rejection it can catch:

```ts
try {
  await sink(() => 1); // a function cannot cross
} catch (err) {
  // err.message: "() => 1 could not be cloned."
}
```

Nested records become frozen namespaces, so a program cannot swap `tools.query` out from under itself. Binding names are plain identifiers at every depth (`tools.query`, not `tools["../etc"]`); the audit record the harness journals carries those dotted names, never the functions or values behind them.

## Budgets

Two budgets, both genuinely enforced — which is exactly what `capabilities.enforces` declares, and no more:

| Budget     | Mechanism                                | On overrun                                                                                          |
| ---------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `timeMs`   | `script.run({ timeout })` on the isolate | `outcome: "budget-exceeded"`, `budget: "timeMs"` — the isolate survives; the context stays usable   |
| `memoryMb` | `new Isolate({ memoryLimit })`           | `outcome: "budget-exceeded"`, `budget: "memoryMb"` — the isolate is torn down; the context is spent |

`outputBytes` is **not** enforced: the isolate captures narration but does not cut it, so the budget is left out of `enforces` and asking for it is a `CodeBudgetUnsupported` error rather than a ceiling that quietly does nothing. `timeMs` bounds **synchronous** execution — a program parked on an unresolved promise consumes no time; stop that with an abort, not a timeout.

`memoryLimitMb` on the config sets the ceiling for contexts that pass no `memoryMb` budget (default `128`).

## Stopping a program

Honoring an abort is mandatory, not a declared capability — a runtime that cannot stop a program cannot honestly enforce `timeMs` either. Pass an `AbortSignal` on the context, or let the enclosing operation's cancellation flow through:

```ts
const controller = new AbortController();
const running = code.execute({ source, signal: controller.signal });
controller.abort();
await running; // rejects CodeAborted
```

An isolate has no per-run interrupt for a program suspended on a promise, so an abort **disposes the isolate**: the in-flight run rejects, the harness reports `CodeAborted`, and the context is spent (open another). This is the same shape as `code-host`, where an abort SIGKILLs the child.

## When to use this — versus `code-host` + a jail

|                                         | `code-host` + `sandboxHost` | `code-secure-exec`         |
| --------------------------------------- | --------------------------- | -------------------------- |
| Contains via                            | OS jail (seatbelt / bwrap)  | isolate construction       |
| Needs jail primitives on the host       | **yes**                     | **no**                     |
| Runs where the image has no `bwrap`     | no                          | **yes**                    |
| Full shell / real tools (`npm`, `curl`) | yes (bash in the jail)      | no — bindings only         |
| Model code that needs fs / net          | yes (jailed)                | no (inject it as bindings) |
| Engine                                  | node or bun                 | V8 isolate                 |

Reach for `code-secure-exec` when the job is **pure computation over injected data** — the model runs an algorithm, transforms a payload, evaluates a rule — and you want zero reach to the host on any image, including hardened ones where a jail primitive cannot be guaranteed. It is not a replacement for the jailed-shell tier; it is the contained-compute tier that the jail tier cannot cover on a locked-down image.

## The native-module reality

`isolated-vm` is a `dependency`, not optional — the package is meaningless without it — and its node-gyp build is the install risk worth naming:

- It ships **prebuilt binaries** (via `node-gyp-build`), so a matching platform/Node-ABI pair installs with no compiler. Node **24.x** is the supported line (`engines.node: ">=24.0.0"`).
- Where no prebuild matches, it **compiles on install** and needs a C++ toolchain (`python3`, `make`, a C++ compiler).
- CI must build it on the **deploy image's** Node, not just the dev host — the ABI is what matters.

## API

```ts
function secureExec(config?: SecureExecConfig): RuntimeProvider;

interface SecureExecConfig {
  language?: "javascript" | "typescript"; // default "javascript"
  memoryLimitMb?: number; // isolate ceiling when no memoryMb budget (default 128)
}
```

`secureExec()` is session-blind: `capabilities()` reports the engine synchronously (no isolate built), and `resolve()` ignores the session installer and builds a fresh isolate `Runtime` per session — each session owns and disposes its own engine. One warm isolate is opened per code context and reused across executes on it (`persistentContext: true`), so state on the isolate's `globalThis` carries between programs on the same context.

`isolateCapabilities(config)`, `compiler(language)`, and the config/type exports are available for a layer building on top of this one.

## Certifying your own layer

If you wrap this runtime — a code-mode extension, an adopter's own provider — certify the wrapper against the same contract with the shipped vocabulary:

```ts
import { runCodeConformance } from "@agentick/code/testing";
import { isolateCodeProbe } from "@agentick/code-secure-exec/testing";

runCodeConformance(isolateCodeProbe());
runCodeConformance(isolateCodeProbe({ language: "typescript" }));
```

`isolateRuntimeInstance(config)` resolves the session-blind provider to a live `Runtime` for tests that drive the isolate directly.

## Roadmap & known gaps

- **CPU-time budget for async-blocked programs.** `timeMs` bounds synchronous execution (the `script.run` timeout); a program suspended on a never-resolving promise is stopped by an abort, not by the timeout. A wall-clock kill for that case would dispose the isolate the way a memory overrun does — deferred until a consumer needs it.
- **The portable tier is a separate package.** A `quickjs`-based engine (`quickjs-emscripten`, pure WASM, no native build, runs in the browser/edge) is the portable sibling on the same `Runtime` contract. It is intentionally _not_ this package — it is a smaller engine and a second build, warranted when a real edge/browser consumer appears, not before.
- **`outputBytes` is uncapped.** Narration is captured but never truncated; a chatty program's output is bounded only by its `memoryMb` ceiling.
- **Binding errors carry the host stack.** A binding that throws copies its `Error` back including `.stack`, which can reference host file paths — an _information_ leak (not an authority leak): a program that catches a binding error can read those paths. Scrub the error on the host side of a binding if the paths are sensitive.
