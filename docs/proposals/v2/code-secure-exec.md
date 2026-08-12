# `@agentick/code-secure-exec` — the isolate engine

> Spec-as-README, for judgment before build. A code **engine** (not a sandbox)
> on the engine axis, the sibling of `code-host`. It runs model code in an
> in-process isolate that **contains by construction** — no filesystem, no
> network, no `require`, no ambient authority — so it needs **no OS jail
> primitive** (`bwrap`/`unshare`/seatbelt). That property is the point: it is
> the prod-hardening path for images where the jail can't be guaranteed.

## Where it sits

```
OPERATION            ENGINE (runtime family)              PLACEMENT (sandbox family)
@agentick/code   →   code-host      hostRuntime()          sandbox-local  (OS jail)
 RuntimeProvider     code-secure-exec  secureExec()  ←──    (none needed — contained
 contract            code-<engine>  …                        by construction)
```

`code-host` contains by **confinement** (an OS jail around a real subprocess).
`code-secure-exec` contains by **construction** (an isolate with nothing wired
in). Same `Runtime` contract; opposite trust mechanism. It is **session-blind**
like `hostRuntime` — `resolve()` ignores the installer and builds a fresh engine
per session; it adopts no sandbox, because there is nothing to jail.

```ts
import { defineCode } from "@agentick/code";
import { secureExec } from "@agentick/code-secure-exec";

createApp(<Agent />, {
  model,
  code: defineCode({ runtime: secureExec({ language: "typescript" }) }),
});
```

## THE DECISION — which isolate (rule on this before I build)

The engine axis has room for both; the question is which one this package _is_.

|              | **isolated-vm** (V8 isolate)                | **QuickJS-WASM** (`quickjs-emscripten`)         |
| ------------ | ------------------------------------------- | ----------------------------------------------- |
| Engine       | full modern V8                              | smaller engine, ~ES2020                         |
| Isolation    | V8 isolate boundary                         | WASM linear-memory boundary                     |
| Native build | **yes** — node-gyp, coupled to the Node ABI | **no** — pure WASM                              |
| Runs where   | Node only                                   | Node, **browser, edge, lambda**                 |
| Speed        | fast                                        | slower (WASM)                                   |
| Maintenance  | thin (maintainer stepped back at times)     | active                                          |
| Bindings     | `Reference`/`Callback` marshaling           | host-function marshaling over the WASM boundary |

**My recommendation: build on `isolated-vm` first.** The immediate need is
ernesto on a Node server (assistant-api) — full JS, fast, and it already
removes the OS-jail dependency (a V8 isolate needs no `bwrap`). QuickJS is the
_portable_ tier (browser/edge, no native build) and the better long-term story,
but it's a smaller engine that model code can trip over, and it's a second build.
So: **`code-secure-exec` = isolated-vm now; `code-quickjs` later** if the
portable tier earns it (userland-first — build it when a real edge/browser
consumer appears, not before). If you'd rather pay the portability tax up front
and skip the native module entirely, we start with QuickJS instead — your call,
because it changes the whole implementation.

Everything below assumes the isolated-vm choice; the shape is identical for
QuickJS, only the leaf calls differ.

## The implementation, mirroring `hostRuntime`

`secureExec(config)` returns a `RuntimeProvider`:

```ts
export function secureExec(config: SecureExecConfig = {}): RuntimeProvider {
  return {
    capabilities: () => isolateCapabilities(config), // engine-only, sync, sandbox-free
    resolve: () => buildIsolateRuntime(config), // session-blind
  };
}
```

`buildIsolateRuntime` returns a `Runtime` whose `createContext` opens **one
isolate + context per code context** (warm across executes on it, so
`persistentContext: true`), and whose `dispose` tears every isolate down.

- **execute**: `isolate.compileScript(transpiled)` → `script.run(context, { timeout })`. The `timeout` is the `timeMs` budget; on overrun isolated-vm throws and we map it to a `CodeAborted`/budget outcome.
- **bindings**: the harness hands named async functions (`flattenBindings` from `@agentick/code`, same as code-host). Each is injected as an `ivm.Reference`/`ivm.Callback`; the program calls it by name, args marshal across as **JSON** (a `ExternalCopy`), the host runs the real function, the result marshals back. Async bindings resolve over the boundary via a returned-promise reference. Data-only by construction — no live objects cross, exactly the code-host membrane.
- **budgets**: `timeMs` → `script.run({ timeout })`; `memoryBytes` → `new ivm.Isolate({ memoryLimit })`. These are the two `enforces` the caps declare — and honestly, not more.

## TypeScript

Same as code-host: `language: "typescript"` runs esbuild **transpile-only** (types stripped, not checked) before `compileScript`. Type-checking a program is a pre-run pipeline concern, documented as such.

## Containment — the honest tier

`handle.isolation`-equivalent on the caps: the isolate reports what it actually enforces.

- **Removed by construction:** filesystem, network, `require`/`import`, `process`, timers-to-escape, any host global. The only reachable surface is the bindings you inject.
- **NOT removed:** CPU (an infinite loop is stopped by the `timeMs` timeout, not prevented) and memory (bounded by `memoryLimit`, not free). A program can still burn its whole budget; it just can't reach _out_.
- **The V8-bug caveat:** isolate containment rests on V8's isolate boundary being sound. It is far stronger than a `node:vm` context (which is trivially escapable and must never be used for this), but it is not a hypervisor. For hostile multi-tenant code where a V8 0-day is in scope, compose it _inside_ an OS jail too — the axes stack.

## `when to use` — the matrix

|                                         | `code-host` + `sandbox-local` | `code-secure-exec`       |
| --------------------------------------- | ----------------------------- | ------------------------ |
| Contains via                            | OS jail (seatbelt/bwrap)      | isolate construction     |
| Needs jail primitives on the host       | **yes**                       | **no**                   |
| Full shell / real tools (`npm`, `curl`) | yes (bash in the jail)        | no — bindings only       |
| Runs where the image has no `bwrap`     | no                            | **yes**                  |
| Model code that needs fs/net            | yes (jailed)                  | no (inject via bindings) |

So `code-secure-exec` is for **pure computation over injected data** — the model
runs an algorithm, transforms a payload, evaluates a rule — with zero reach to
the host, on any image. It is not a replacement for the jailed-shell tier; it's
the contained-compute tier that the jail tier can't cover on a hostile image.

## Packaging notes (the native-module reality)

- `isolated-vm` is a `dependency` (not optional) — the package is meaningless without it — but its node-gyp build is the install risk. Pin a version known to build on the target Node ABI; document the Node range in `engines`; CI must build it on the deploy image's Node, not just the dev host.
- Conformance: `runCodeConformance` (from `@agentick/code/testing`) certifies it against the same contract as code-host — abort honored, budgets enforced, outcomes normalized, bindings marshaled. The isolate must pass the _same_ suite; that's how we know the engine swap is truthful.
- Reconcile the stale `@agentick/sandbox-secure-exec` entry in the website config — secure-exec runs _code_, so it belongs on the **code** axis (`code-secure-exec`), never as a sandbox provider.

## Build checklist

1. `packages/code-secure-exec/` — `package.json` (dep `@agentick/code` peer + `isolated-vm`; `@agentick/spec`/`utils`/`effect`), `tsconfig`(.build), `src/index.ts`.
2. `src/runtime.ts` — `secureExec()` `RuntimeProvider` + the isolate `Runtime`/context, mirroring `host-runtime.ts`.
3. `src/isolate-context.ts` — one isolate+context; execute (compile+run+timeout), bindings marshaling (`Reference`/`Callback`, JSON), dispose.
4. `src/capabilities.ts` — `isolateCapabilities` (`name: "isolate"`, `enforces: [timeMs, memoryBytes]`, `persistentContext: true`).
5. `src/language.ts` — esbuild transpile-only for TS (or share code-host's).
6. `README.md` + workspace registration (pnpm-workspace fixed-version group + release lane, typedoc entry, website group).
7. Conformance spec + a containment spec (asserts no fs/net/require reachable from a program; a program that tries `require("fs")` fails).
