# @agentick/sandbox-local-next

The **local reference `SandboxProvider`** (ADR 59). Spawns commands THROUGH a
platform OS jail (macOS seatbelt / Linux bwrap / unshare, or an honest
unjailed passthrough where none exists) in a temp workspace, path-confines the
file API, writes atomically, mounts host directories at runtime, and routes
egress through a 127.0.0.1 proxy.

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

- **`exec`** — the command is spawned THROUGH the selected OS jail (see
  [Isolation](#isolation-os-jail)) in its own process group (killable tree).
  Streams each stdout/stderr chunk through `opts.onOutput` as it arrives; the
  final `stdout`/`stderr` stay authoritative. Honors `cwd`, `env`, `stdin`,
  `timeoutMs`, and an external `signal`; reports `exitCode`, `signaled`,
  `durationMs`.
- **`readFile` / `writeFile`** — path-confined to the workspace + allowed
  mounts (symlink-resolved, traversal/null-byte rejected via
  `SandboxEscapeError`). `writeFile` creates parent dirs and writes
  **atomically** (temp + rename, with a direct-write fallback for
  NFS/FUSE `EIO`/`ENOENT`/`EXDEV`).
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

## Isolation (OS jail)

`exec` runs **through an OS-level jail**, selected per host capability
(`localProvider({ strategy })` — default `"auto"` picks the strongest; an
explicit strategy the host cannot honor **throws** at `create`, never silently
downgrades). The effective tier is surfaced honestly on the handle as
`LocalSandbox.isolation` — a caller can read it before trusting `exec` to
confine. **A jail that doesn't confine is worse than none**, so a host with no
jail primitive reports `"none"` (unconfined) rather than a false claim.

| Strategy   | Platform | Mechanism                                                                 | `exec` confinement                                                                                     |
| ---------- | -------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `seatbelt` | macOS    | `sandbox-exec -f <SBPL profile>`                                          | Kernel-enforced: reads (deny home/keychains/volumes), writes (workspace+mounts+tmp only), network deny |
| `bwrap`    | Linux    | `bubblewrap` — `--unshare-all`, ro system binds, private /proc+/dev+tmpfs | Namespace-enforced: only bound paths exist; network off unless `--share-net`                           |
| `unshare`  | Linux    | `unshare --mount --pid --fork --user --map-root-user` (+ `--net` on deny) | Namespace isolation (fallback when `bwrap` absent + userns available)                                  |
| `none`     | any      | bare `bash -c`                                                            | **UNCONFINED** — path-confined fs + proxied egress only; surfaced as `isolation: "none"`               |

Probe host capability up front with the exported `detectCapabilities()` /
`selectStrategy(caps, override)`.

### Resource limits — honest per-platform mapping

`SandboxCreateOptions.limits` maps to the jail where the platform supports it;
unsupported limits are documented here, never silently ignored:

| Limit          | Linux                            | macOS                            | passthrough |
| -------------- | -------------------------------- | -------------------------------- | ----------- |
| `wallClockSec` | per-exec timeout (handle)        | per-exec timeout (handle)        | timeout     |
| `diskMb`       | `DiskMonitor` poll (best-effort) | `DiskMonitor` poll (best-effort) | poll        |
| `memoryMb`     | cgroup v2 `memory.max`           | **unsupported** (no cgroups)     | unsupported |
| `cpuPercent`   | cgroup v2 `cpu.max`              | **unsupported** (no cgroups)     | unsupported |

`memoryMb`/`cpuPercent` require a writable cgroups-v2 hierarchy; where it isn't
writable the `CgroupManager` degrades to a no-op (`isActive === false`) — the
jail still confines, only the resource ceiling is best-effort.

### Network honesty

Kernel-level network **deny** (`allow.network: false`) is enforced by the jail
(seatbelt `deny network*`; bwrap/unshare withhold the network namespace).
Per-domain `NetworkRule[]` egress is enforced by the 127.0.0.1 proxy via
`HTTP(S)_PROXY` injection — this is env-based and a determined in-jail process
could open a direct socket around it (seatbelt/bwrap allow egress once network
is on). The hard, unbypassable control is the boolean deny; per-domain
filtering is best-effort. (Carried forward from v1; same coarseness the docker
provider documents.)

> **This provider is the security boundary; the harness above it is not.** With a
> real jail (`seatbelt` / `bwrap` / `unshare`) `exec` is kernel- or
> namespace-confined. With `strategy: "none"` — or `"auto"` on a host with no jail
> primitive — the spawned command is a plain child process running with **the host
> user's full permissions**; path-confinement and the egress proxy are the only
> limits, and both are bypassable by a determined process (see
> [Network honesty](#network-honesty)). Read `LocalSandbox.isolation` before
> trusting `exec` to contain code you don't control, and reserve `"none"` for code
> you already trust. The tool allow-lists and ACL prompts one layer up are policy,
> not containment — the jail is.

## Testing double

The in-memory `fakeSandboxProvider()` (real `applyEdits`, programmable
`exec`) ships from the base package's `@agentick/sandbox-next/testing`
subpath — the double lives WITH the `SandboxProvider` contract it
implements (ADR 59). It is a fake for wiring harness/bridge tests without
spawning processes, not a conformance-grade provider.

## API

- `localProvider(config?): SandboxProvider` — `config.strategy?: SandboxStrategy | "auto"`
- `class LocalSandbox implements SandboxHandle` — plus `readonly isolation: SandboxStrategy`
- `class NetworkProxyServer`
- `detectCapabilities()`, `selectStrategy(caps, override?)`, `resetCapabilitiesCache()`
- `class CgroupManager`, `class DiskMonitor`, `selectExecutor(strategy, cgroup?)`
- `createWorkspace`, `destroyWorkspace`, `resolveMount(s)`, `resolveSafePath`, `filterEnv`

## Status

Reference-complete for the ADR 59 Wave 2a contract **plus the #240 OS-isolation
stack**. Passes `runSandboxProviderConformance` against real temp dirs + a real
shell, and the jail-confinement suite proves seatbelt/bwrap/unshare actually
confine a real jailed `exec` (per-platform gated).

## Roadmap & known gaps

- **`memoryMb`/`cpuPercent` on macOS.** Unsupported — macOS has no cgroups;
  the honest mapping is documented in [Resource limits](#resource-limits--honest-per-platform-mapping)
  rather than pretending `ulimit` enforces them. A future best-effort
  `ulimit`-in-shell wrapper could approximate them (`TODO(#240)` in `provider.ts`).
- **`diskMb`.** Best-effort poll (`du` every 5s), not a hard quota — a burst
  between samples can exceed it briefly before the process group is killed.
- **Per-domain egress is proxy-based** (env `HTTP(S)_PROXY`), bypassable by a
  determined in-jail process; only the boolean network deny is kernel-hard.
  See [Network honesty](#network-honesty).
- **`restore` / hibernate.** Intentionally absent — `TODO(#223)`, deferred
  to a remote/CRIU-style provider per ADR 59.

## Verified by

- `src/__tests__/provider-conformance.spec.ts` — runs the real provider
  through `runSandboxProviderConformance`: exec + `onOutput` streaming, fs
  round-trip, atomic fuzzy + range `editFile`, mount add/list/remove,
  destroy.
- `src/__tests__/proxy.spec.ts` — egress allow/deny/default-deny + audit
  log, and `HTTP(S)_PROXY` env injection through the provider.
- `src/__tests__/isolation.spec.ts` — **jail-confinement proof** (security,
  not functional): a real jailed `exec` is DENIED writing outside the
  workspace, DENIED reading a sensitive path (`/Users` on macOS; unbound host
  paths on Linux), and DENIED network egress when `allow.network` is false —
  each paired with a passthrough (`strategy: "none"`) CONTROL that PERFORMS the
  same escape, proving the denial is the jail's doing. Per-platform gated
  (seatbelt cases where `sandbox-exec` exists; bwrap/unshare where a Linux
  namespace jail exists); each case guards on `isolation === <the jail>` so it
  can never pass on an unconfined process.
