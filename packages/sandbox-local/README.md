# @agentick/sandbox-local

**The reference `SandboxProvider`, and the one that tells you the truth about how confined you actually are.** It spawns `exec` through a real OS jail — macOS seatbelt, Linux bubblewrap or `unshare` — path-confines the file API, writes atomically, mounts host directories at runtime, and routes egress through a loopback proxy.

Where no jail primitive exists it reports `isolation: "none"` and keeps running unconfined rather than claiming containment it doesn't have. That honesty is the point: a caller can read the tier off the handle and decide whether to trust `exec` with the code it's about to run.

## Install

```bash
npm install @agentick/sandbox @agentick/sandbox-local
```

Single entry point, no subpaths. It depends on [@agentick/sandbox](../sandbox) and nothing else — the base re-exports the contracts, the wire types, `applyEdits`, and the egress matcher, so a provider has one import source.

## Quick start

```ts
import { localProvider, type LocalSandbox } from "@agentick/sandbox-local";

const provider = localProvider(); // strategy: "auto" — strongest jail the host has
const sandbox = (await provider.create({ workspace: true })) as LocalSandbox;

console.log(sandbox.isolation); // "seatbelt" | "bwrap" | "unshare" | "none"

const { stdout } = await sandbox.exec("echo hello"); // "hello\n"
await sandbox.writeFile("notes.md", "# Notes");
await sandbox.editFile("notes.md", [{ old: "# Notes", new: "# Journal" }]);

await sandbox.destroy(); // kills the process tree, removes the temp workspace
```

Under an agent you rarely call the handle directly — mount it with `<Sandbox provider={provider}>` and the four built-in tools drive it. See [@agentick/sandbox](../sandbox).

## Fail closed on an unjailed host

`"auto"` picks the strongest jail available and falls back to `"none"` on a host with nothing. Naming a strategy explicitly makes it a **requirement**: if the host can't honor it, `create()` throws instead of quietly downgrading.

```ts
const provider = localProvider({ strategy: "seatbelt" }); // throws on Linux
```

To decide before you allocate anything, probe the host:

```ts
import { detectCapabilities, localProvider, selectStrategy } from "@agentick/sandbox-local";

const caps = await detectCapabilities(); // { platform, hasSandboxExec, hasBwrap, hasCgroupsV2, ... }
const strategy = selectStrategy(caps); // what "auto" would choose
if (strategy === "none") throw new Error("refusing to run untrusted code unjailed");

const provider = localProvider({ strategy });
```

`detectCapabilities()` memoizes; `resetCapabilitiesCache()` clears it for tests that fake the host.

## Isolation tiers

| Strategy   | Platform | Mechanism                                                                    | What `exec` is confined by                                                                                                                 |
| ---------- | -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `seatbelt` | macOS    | `sandbox-exec` with a compiled SBPL profile                                  | Kernel. Reads deny home, keychains, volumes; writes limited to workspace, mounts, tmp; inet denied, AF_UNIX open under workspace + mounts. |
| `bwrap`    | Linux    | `bubblewrap` — `--unshare-all`, read-only system binds, private proc/dev/tmp | Namespaces. Only bound paths exist at all; no network unless `--share-net`.                                                                |
| `unshare`  | Linux    | `unshare --mount --pid --fork --user --map-root-user` (+ `--net` on deny)    | Namespaces, lighter. The fallback when `bubblewrap` is absent but user namespaces work.                                                    |
| `none`     | any      | bare `bash -c`                                                               | **Nothing.** Path-confined file API and proxied egress only; `exec` runs with the host user's permissions.                                 |

> [!WARNING]
> This provider is the security boundary; the harness above it is not. With a real jail, `exec` is kernel- or namespace-confined. With `isolation: "none"` the spawned command is an ordinary child process holding **the host user's full permissions** — path confinement and the egress proxy are the only limits, and a determined process bypasses both. Read `LocalSandbox.isolation` before trusting `exec` with code you don't control. Tool allowlists and approval prompts one layer up are policy, not containment.

## What each handle method does

**`exec`** spawns through the selected jail in its own process group, so a timeout kills the whole tree. Each stdout/stderr chunk streams through `options.onOutput` as it arrives while the final `stdout`/`stderr` stay authoritative. Honors `cwd`, `env`, `stdin`, `timeoutMs`, and an external `signal`; reports `exitCode`, `signaled`, and `durationMs`.

**`readFile` / `writeFile`** resolve symlinks and reject traversal and null bytes with `SandboxEscapeError`, confined to the workspace plus allowed mounts. Writes create parent directories and land atomically via temp-and-rename, with a direct-write fallback for NFS and FUSE volumes that return `EIO`, `ENOENT`, or `EXDEV`.

**`editFile`** is read, then the shared `applyEdits` from the base package, then the same atomic write. The provider owns atomicity; the transform stays pure.

**`addMount` / `removeMount` / `listMounts`** extend the confinement allow-set and symlink the sandbox path to the host directory. The ceiling check against `mountAllow` happens in the harness above; the provider performs the mount.

## Egress

Set `allow.network` to a rule list and the provider starts a loopback HTTP proxy with a CONNECT tunnel, injects `HTTP_PROXY` and `HTTPS_PROXY` into the spawned environment, and evaluates every request through the base's `matchRequest` — first match wins, default deny. HTTPS is tunneled opaquely; there is no MITM.

```ts
const sandbox = await provider.create({
  workspace: true,
  allow: {
    network: [
      { action: "allow", domain: "registry.npmjs.org" },
      { action: "allow", domain: "*.github.com", methods: ["GET"] },
      { action: "deny", domain: "*" },
    ],
  },
});
```

Audit every request that transits, or block-log it, through the proxy config:

```ts
const provider = localProvider({
  network: {
    onRequest: (req) => console.log(req.method, req.url),
    onBlock: (req) => console.warn("blocked", req.host),
    maxAuditEntries: 1000,
  },
});
```

`NetworkProxyServer` is exported if you want to run one standalone: construct it with rules, `start()`, read `proxyUrl`, `getAuditLog()`, `stop()`.

> [!IMPORTANT]
> The two egress controls are not equally strong. `allow.network: false` is enforced by the jail itself — seatbelt's `deny network*`, or bubblewrap and `unshare` withholding the network namespace — and is unbypassable. Per-domain rules ride on `HTTP(S)_PROXY` environment variables, and a process inside the jail can open a direct socket around them once network is on at all. Treat the boolean deny as hard and per-domain filtering as best-effort. The hard deny is scoped to the network: filesystem (AF_UNIX) sockets under the workspace and mounts stay connectable on every jail, so a supervisor can speak to jailed code over a workspace socket while egress stays shut.

## Resource limits, mapped honestly

`SandboxCreateOptions.limits` reaches the jail where the platform supports it. Where it doesn't, that's documented rather than silently dropped:

| Limit          | Linux                            | macOS                        | `none`      |
| -------------- | -------------------------------- | ---------------------------- | ----------- |
| `wallClockSec` | per-exec timeout                 | per-exec timeout             | timeout     |
| `diskMb`       | `DiskMonitor` poll (best-effort) | `DiskMonitor` poll           | poll        |
| `memoryMb`     | cgroup v2 `memory.max`           | **unsupported** — no cgroups | unsupported |
| `cpuPercent`   | cgroup v2 `cpu.max`              | **unsupported** — no cgroups | unsupported |

`memoryMb` and `cpuPercent` need a writable cgroups-v2 hierarchy. Where it isn't writable, `CgroupManager` degrades to a no-op and reports `isActive === false` — the jail still confines, only the resource ceiling goes best-effort. `diskMb` is a `du` poll every five seconds, so a burst between samples can overshoot before the process group is killed.

## API

| Export                                                     | Purpose                                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| `localProvider(config?)`                                   | The provider. Config: `strategy`, `network`, `tmpBase`, `cleanupWorkspace`. |
| `LocalSandbox`                                             | The handle class, plus `readonly isolation: SandboxStrategy`.               |
| `NetworkProxyServer` / `ProxyServerConfig`                 | The egress proxy, usable standalone.                                        |
| `detectCapabilities()` / `selectStrategy(caps, override?)` | Probe the host and resolve `"auto"` before creating.                        |
| `resetCapabilitiesCache()`                                 | Clear the detection memo (tests).                                           |
| `SandboxStrategy` / `PlatformCapabilities`                 | The tier union and the detection result shape.                              |
| `CgroupManager` / `DiskMonitor`                            | Linux cgroup v2 limits and the disk poll.                                   |
| `selectExecutor(strategy, cgroup?)` / `CommandExecutor`    | The spawn strategy behind `exec`.                                           |
| `createWorkspace` / `destroyWorkspace`                     | Temp workspace allocation and teardown.                                     |
| `resolveMount` / `resolveMounts` / `ResolvedMount`         | Host-to-sandbox mount resolution.                                           |
| `resolveSafePath` / `filterEnv` / `ENV_BLOCKLIST`          | Path confinement and environment scrubbing.                                 |

## Patterns

**Under an agent.** [@agentick/sandbox](../sandbox) wraps this handle in a harness that adds journaling, the approval gate, and the four model-facing tools.

**Other providers.** [@agentick/sandbox-docker](../sandbox-docker) and [@agentick/sandbox-lambda](../sandbox-lambda) implement the same contract with container and serverless isolation.

**Test double.** `fakeSandboxProvider()` ships from `@agentick/sandbox/testing` — the double lives with the contract it implements. It's for wiring tests without spawning processes, not a conformance-grade provider.

## Roadmap & known gaps

- **`memoryMb` and `cpuPercent` are unsupported on macOS.** There are no cgroups; the honest mapping is documented above rather than pretending `ulimit` enforces them. A best-effort `ulimit`-in-shell wrapper would approximate them.
- **`diskMb` is a poll, not a quota.** Five-second sampling means a fast write can exceed the ceiling briefly before the process group is killed.
- **Per-domain egress is bypassable.** It rides on proxy environment variables. Only `allow.network: false` is kernel-hard.
- **`restore` is not implemented.** Hibernate is deferred to a provider with real checkpointing; the contract seam stays optional and this provider leaves it off.
- **Windows has no jail.** `detectCapabilities()` reports the platform, but no restricted-token or job-object strategy is implemented, so Windows resolves to `"none"`.
- **`isolation` needs a cast to reach.** `SandboxProvider.create()` returns the base `SandboxHandle`, which has no `isolation`, so reading the tier off a handle means narrowing to `LocalSandbox`. The contract has no place for a provider to declare its tier generically.

## Verified by

- `src/__tests__/provider-conformance.spec.ts` — the real provider through `runSandboxProviderConformance`: exec with `onOutput` streaming, filesystem round-trip, atomic fuzzy and range `editFile`, mount add/list/remove, destroy.
- `src/__tests__/proxy.spec.ts` — egress allow, deny, and default-deny; the audit log; `HTTP(S)_PROXY` injection through the provider.
- `src/__tests__/isolation.spec.ts` — confinement proof rather than a functional check. A jailed `exec` is denied writing outside the workspace, denied reading a sensitive path (`/Users` on macOS, unbound host paths on Linux), and denied network egress when `allow.network` is false. Each case is paired with a `strategy: "none"` control that **performs** the same escape, which is what proves the denial is the jail's doing. Per-platform gated, and each case asserts `isolation === <the jail>` so it can never pass on an unconfined process.
