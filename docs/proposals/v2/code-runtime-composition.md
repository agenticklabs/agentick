# Code · Runtime · Sandbox — the composition surface

> Spec-as-README. This is the adopter-facing surface across four packages,
> written before the build so the example _is_ the acceptance test. Land it,
> then the package READMEs are excerpts of it.

## Three axes, three families

Running model-authored code decomposes into three orthogonal questions. Each is
owned by one package family. Nothing encodes another axis in its name.

| Axis          | Question                                            | Family                | Discriminator                          |
| ------------- | --------------------------------------------------- | --------------------- | -------------------------------------- |
| **Operation** | journaling, guards, abort, bindings, typed outcomes | `@agentick/code`      | — (one package)                        |
| **Engine**    | _how_ is the code interpreted?                      | `code-<engine>`       | engine: `host`, `isolate`, …           |
| **Placement** | _where_ does it run, what can it touch?             | `sandbox-<placement>` | placement: `local`, `docker`, `lambda` |

Engine × placement **compose at the app config** — never in a package name.
That is why there is no `code-docker` and no `code-runtime-sandbox`: docker is
placement (the sandbox family owns it), and "sandbox" is placement applied to an
engine (a composition, not an engine).

## Export map

| Package                             | Exports                                                          | Role                                        |
| ----------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| `@agentick/code`                    | `defineCode`, `RuntimeProvider`, `Runtime` contract              | operation + engine contract                 |
| `@agentick/code-host`               | `hostRuntime()`, `sandboxHost()`                                 | host **engine** provider (trusted + jailed) |
| `@agentick/code-isolate` _(future)_ | `isolateRuntime()`                                               | in-process isolate engine                   |
| `@agentick/sandbox`                 | `defineSandbox(config)`, `withSandbox`, `sandbox` slot, contract | placement contract + slot                   |
| `@agentick/sandbox-local`           | `defineSandbox()` (local baked), `localProvider`                 | placement provider                          |
| `@agentick/sandbox-docker`          | `defineSandbox()` (docker baked), `dockerProvider`               | placement provider                          |

`code-host` depends on `@agentick/sandbox`'s **contract** (to adopt a
`SandboxHandle` via the spawn port) but on **no** sandbox provider — it jails
into whatever the session mounted.

## The adopter surface

Four configurations, from most-trusted to most-contained. The only things that
move are the runtime provider and whether a `sandbox:` slot is present.

```ts
// 1. TRUSTED, zero-config — host engine, no jail, no code-host import.
//    `code`'s default-runtime resolves hostRuntime via optional dynamic import.
createApp(<Agent />, { model, code: {} });

// 2. TRUSTED, explicit — same engine, configured (language, env, cwd).
import { defineCode } from "@agentick/code";
import { hostRuntime } from "@agentick/code-host";
createApp(<Agent />, {
  model,
  code: defineCode({ runtime: hostRuntime({ language: "typescript" }) }),
});

// 3. JAILED, code owns its jail — nothing else needs a sandbox.
import { defineCode } from "@agentick/code";
import { sandboxHost } from "@agentick/code-host";
import { localProvider } from "@agentick/sandbox-local";
createApp(<Agent />, {
  model,
  code: defineCode({ runtime: sandboxHost({ provider: localProvider() }) }),
});

// 4. JAILED, shared jail — code adopts the session's sandbox, the SAME one the
//    file/shell tools reach through ctx.sandbox. One jailed workspace per
//    conversation: write_file drops a CSV, a program reads it, network denied
//    for both.
import { defineCode } from "@agentick/code";
import { sandboxHost } from "@agentick/code-host";
import { defineSandbox } from "@agentick/sandbox-local";
createApp(<Agent />, {
  model,
  sandbox: defineSandbox(),                       // placement, chosen by import
  code: defineCode({ runtime: sandboxHost() }),   // host engine, adopts it
});
```

Config 4 is the target. Swap the `defineSandbox` import from `sandbox-local` to
`sandbox-docker` and the _same_ `sandboxHost()` now runs in a container — engine
unchanged, placement swapped, one import touched.

## `defineSandbox` — granularity by import

Every provider package exports `defineSandbox()` (its provider baked) _and_ the
raw `<x>Provider`, mirroring how `@agentick/app/react` bakes `reactCompiler`
into `createApp`. The **import location is the provider choice** — because
sandbox has no safe default (local vs docker vs lambda are different trust
postures, so you must choose).

```ts
// most sugar — provider by import, its config passed through
import { defineSandbox } from "@agentick/sandbox-docker";
sandbox: defineSandbox({ image: "node:20-slim" })

// mid — generic define from the base, explicit provider
import { defineSandbox } from "@agentick/sandbox";
import { dockerProvider } from "@agentick/sandbox-docker";
sandbox: defineSandbox({ provider: dockerProvider({ image, socketPath }) })

// raw — the extension itself
extensions: [withSandbox({ provider: dockerProvider({ … }) })]
```

## `RuntimeProvider` — the engine contract

`hostRuntime()` and `sandboxHost()` are **runtime providers**, the exact peer of
`localProvider()` on the sandbox axis. The symmetry is one-to-one:

| sandbox                                        | code                                     |
| ---------------------------------------------- | ---------------------------------------- |
| `localProvider()` → `SandboxProvider`          | `sandboxHost()` → `RuntimeProvider`      |
| `.create(options)` → `SandboxHandle`           | `.resolve(installer)` → `Runtime`        |
| resolved by `withSandbox`                      | resolved by `withCode`, **per session**  |
| `defineSandbox({ provider: localProvider() })` | `defineCode({ runtime: sandboxHost() })` |

So `defineCode({ runtime: sandboxHost() })` is _provider-in-define_ — structurally
identical to `defineSandbox({ provider: localProvider() })`. There is no
`defineX` nested in a `defineX`; there is a `defineX` holding a provider, on both
sides. **There is no `defineRuntime`.** A custom engine implements
`RuntimeProvider`; a session-blind engine may pass a plain `Runtime`, auto-wrapped.

```ts
export interface RuntimeProvider {
  /**
   * Bind this engine to a session. Called once per session by withCode.
   * A session-blind engine (hostRuntime) ignores the installer or memoizes an
   * app-shared pool; a placed engine (sandboxHost) adopts the session's sandbox
   * from it. Capability-tiered — a plain Runtime is a RuntimeProvider whose
   * resolve returns itself.
   */
  resolve(installer: SessionInstaller): Runtime | Promise<Runtime>;
}
```

`sandboxHost().resolve(installer)` returns a `Runtime` whose `createContext`
**borrows** the session's `SandboxHandle` (via `ctx.sandbox` + the `spawn` port)
and never `destroy()`s it — the sandbox is owned by `withSandbox`, created and
disposed with the session. Borrow, never own (the live-instance lesson).

### Per-execution runtime override — rejected

`execute({ runtime })` is **not** a thing, on purpose. The runtime is bound at
config and resolved once per session; per-execution you get `bindings`,
`budgets`, and `signal` — nothing that picks the engine. Three reasons:

1. **Ambient property.** `ctx.code.execute(source)` works because the engine is
   pre-bound; a per-call runtime forces every call site to know the engine.
2. **Trust inversion.** The runtime is a deployment/containment decision (the
   app author's), not the model's or the caller's. A per-call override is a
   containment escape hatch — a model handed the choice picks the *un*jailed one.
3. **Persistence.** A per-execute swap throws away the warm subprocess and the
   shared workspace, the exact thing lazy session-lifetime resolution protects.

Two engines in one session is possible only as a _consequence_ of namespaces
being independent — mount `code` and a second slot, each with its own bound
runtime. There is no first-party need; it is not built for, only unobstructed.

Open implementation question, flagged not guessed: the sandbox namespace may not
be registered at the instant `withCode` installs (install-ordering). `resolve`
therefore reaches `ctx.sandbox` **lazily** — at first `createContext`, not at
install — so ordering between the two slots does not matter. Settle the exact
lazy seam in the build.

## What changes from today

| Today                                                         | After                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `withCode({ runtime })` takes a live, session-blind `Runtime` | takes a `RuntimeProvider` (`resolve(installer)`); a plain `Runtime` auto-wraps |
| `hostRuntime()` → `Runtime`                                   | `hostRuntime()` → `RuntimeProvider` (session-blind resolve)                    |
| —                                                             | `sandboxHost()` → `RuntimeProvider` that adopts `ctx.sandbox`                  |
| sandbox mounts only via `extensions: [withSandbox(...)]`      | also a top-level `sandbox:` slot                                               |
| `withSandbox({ provider: localProvider() })`                  | `defineSandbox()` from the provider package (provider baked)                   |
| _(proposed)_ `defineRuntime((installer) => Runtime)`          | **deleted** — the `RuntimeProvider` interface is the seam                      |

## Build checklist

1. **`@agentick/sandbox`** — add the `sandbox` `NamespaceSlot` +
   `registerNamespaceSlot("sandbox", { toExtension: withSandbox })`; export a
   generic `defineSandbox(config)` + `SandboxDefinition` type.
2. **`@agentick/sandbox-local`, `sandbox-docker`, `sandbox-lambda`** — export
   `defineSandbox()` with each provider baked (the `app/react` move).
3. **`@agentick/code`** — introduce `RuntimeProvider`; `withCode`/`defineCode`
   accept it and `resolve(installer)` per session; accept a plain `Runtime` by
   auto-wrapping; no `defineRuntime`.
4. **`@agentick/code-host`** — `hostRuntime()` and `sandboxHost()` become
   `RuntimeProvider`s; `sandboxHost` adopts `ctx.sandbox` lazily via the spawn
   port; depend on `@agentick/sandbox` contract only.
5. **ernesto** — the config reads exactly as target config 4.
