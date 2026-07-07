# @agentick/sandbox-local-next

The **local reference `SandboxProvider`** (ADR 59). Spawns commands in a
temp workspace, path-confines the file API, writes atomically, mounts host
directories at runtime, and routes egress through a 127.0.0.1 proxy.

It is the provider the conformance suite (`runSandboxProviderConformance`)
pins the contract against, and the baseline every other provider
(docker, remote, secure-exec) is measured against.

## Dependency posture

Deps the **base package** `@agentick/sandbox-next` — and nothing else —
mirroring `model-openai-next → model-next` (ADR 59). The base re-exports
everything this provider needs from a **single import source**:

- the `SandboxProvider` / `SandboxHandle` / `SandboxCreateOptions`
  construction contracts;
- the spec sandbox wire types (`SandboxExec*`, `SandboxEdit*`,
  `SandboxMount`, `NetworkRule`, `ProxiedRequest`) + the error classes;
- the layered-matching `applyEdits` transform;
- the pure egress matcher `matchRequest` / `matchDomain`.

The conformance suite it runs (`runSandboxProviderConformance`) ships from
`@agentick/sandbox-next/testing`.

## Quick Start

```ts
import { localProvider } from "@agentick/sandbox-local-next";

const provider = localProvider();
const sandbox = await provider.create({ workspace: true });

const { stdout } = await sandbox.exec("echo hello"); // "hello\n"
await sandbox.writeFile("notes.md", "# Notes");
await sandbox.editFile("notes.md", [{ old: "# Notes", new: "# Journal" }]);

await sandbox.destroy();
```

## What it implements

- **`exec`** — `bash -c` in the workspace, own process group (killable
  tree). Streams each stdout/stderr chunk through `opts.onOutput` as it
  arrives; the final `stdout`/`stderr` stay authoritative. Honors `cwd`,
  `env`, `stdin`, `timeoutMs`, and an external `signal`; reports
  `exitCode`, `signaled`, `durationMs`.
- **`readFile` / `writeFile`** — path-confined to the workspace + allowed
  mounts (symlink-resolved, traversal/null-byte rejected via
  `SandboxEscapeError`). `writeFile` creates parent dirs and writes
  **atomically** (temp + rename, with a direct-write fallback for
  NFS/FUSE `EIO`/`EXDEV`).
- **`editFile`** — the provider-owned file-wrapper: read → the shared
  pure `applyEdits` (fuzzy layered matching, all modes) → the same atomic
  write. This is the temp+rename the ADR says the provider owns, not the
  harness.
- **Dynamic mounts** (`addMount`/`removeMount`/`listMounts`) — extends the
  confinement allow-set and symlinks the sandbox path to the host dir. The
  harness gates `addMount` against the construction-time `mountAllow`
  ceiling; the provider just performs the mount.
- **Network proxy** — when `allow.network` is a `NetworkRule[]`, a
  127.0.0.1 HTTP proxy + CONNECT tunnel enforces the rules via the base's
  `matchRequest`, injects `HTTP(S)_PROXY` into the spawned env, and keeps a
  `ProxiedRequest` audit log. No MITM (HTTPS is tunneled opaquely).

## Testing double

The in-memory `fakeSandboxProvider()` (real `applyEdits`, programmable
`exec`) ships from the base package's `@agentick/sandbox-next/testing`
subpath — the double lives WITH the `SandboxProvider` contract it
implements (ADR 59). It is a fake for wiring harness/bridge tests without
spawning processes, not a conformance-grade provider.

## API

- `localProvider(config?): SandboxProvider`
- `class LocalSandbox implements SandboxHandle`
- `class NetworkProxyServer`
- `createWorkspace`, `destroyWorkspace`, `resolveMount(s)`, `resolveSafePath`, `filterEnv`

## Status

Reference-complete for the ADR 59 Wave 2a contract. Passes
`runSandboxProviderConformance` against real temp dirs + a real shell.

## Roadmap & known gaps

- **Isolation tier.** `exec` runs as an ordinary child process — the file
  API is path-confined and egress is proxied, but there is no
  seatbelt/bwrap/namespace jail on `exec`. `TODO(ADR 59)`: port v1's
  seatbelt/bwrap/unshare executor strategies + cgroup enforcement as an
  opt-in hardening tier (see `packages/sandbox-local/src/executor/*`).
- **Resource limits.** Only `limits.wallClockSec` is honored (as a default
  per-exec timeout). Memory/CPU/disk need cgroups (same TODO).
- **`restore` / hibernate.** Intentionally absent — `TODO(#223)`, deferred
  to a remote/CRIU-style provider per ADR 59.

## Verified by

- `src/__tests__/provider-conformance.spec.ts` — runs the real provider
  through `runSandboxProviderConformance`: exec + `onOutput` streaming, fs
  round-trip, atomic fuzzy + range `editFile`, mount add/list/remove,
  destroy.
- `src/__tests__/proxy.spec.ts` — egress allow/deny/default-deny + audit
  log, and `HTTP(S)_PROXY` env injection through the provider.
