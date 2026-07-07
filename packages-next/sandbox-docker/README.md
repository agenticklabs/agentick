# @agentick/sandbox-docker-next

The **Docker `SandboxProvider`** (ADR 59, Wave 2b). One container per
sandbox (kept alive with `sleep infinity`), commands via `docker exec`,
file I/O via exec, atomic `editFile` through the base's shared `applyEdits`,
and coarse egress control via the container's `NetworkMode`.

Talks to the Docker Engine API over the Unix socket with a zero-dependency
`node:http` client — no `dockerode`, no external deps.

## Dependency posture

Deps the **base package** `@agentick/sandbox-next` — and nothing else —
mirroring `model-openai-next → model-next` (ADR 59). The base re-exports
everything this provider needs from a **single import source**: the
`SandboxProvider` / `SandboxHandle` / `SandboxCreateOptions` contracts, the
spec sandbox wire types (`SandboxExec*`, `SandboxEdit*`, `SandboxMount`,
`NetworkRule`), the error classes, and the layered-matching `applyEdits`
transform. The conformance suite it runs ships from
`@agentick/sandbox-next/testing`.

## Quick Start

```ts
import { dockerProvider } from "@agentick/sandbox-docker-next";

const provider = dockerProvider({ image: "node:22-slim" });
const sandbox = await provider.create({ workspace: true });

const { stdout } = await sandbox.exec("node -e 'console.log(1 + 1)'"); // "2\n"
await sandbox.writeFile("notes.md", "# Notes");
await sandbox.editFile("notes.md", [{ old: "# Notes", new: "# Journal" }]);

await sandbox.destroy(); // removes the container (+ auto volume)
```

## What it implements

- **`exec`** — `docker exec` (`sh -c`) in the workspace. Streams each
  stdout/stderr chunk through `opts.onOutput` as it arrives (via docker's
  multiplexed frame protocol); the final `stdout`/`stderr` stay
  authoritative. Honors `cwd`, `env`, `stdin` (piped in as decoded base64,
  since the thin client opens no hijacked stdin socket), `timeoutMs`, and an
  external `signal`; reports `exitCode`, `signaled`, `durationMs`.
- **`readFile` / `writeFile`** — path-confined to the workspace +
  create-time mounts (POSIX string validation; traversal/null-byte rejected
  via `SandboxEscapeError`, read-only-mount writes via
  `SandboxPermissionDeniedError`). `readFile` uses `cat`; `writeFile`
  base64-decodes into a temp file then `mv`s it into place — the
  provider-owned atomic write.
- **`editFile`** — read → the shared pure `applyEdits` (fuzzy layered
  matching, all modes) → the same atomic write.
- **`destroy`** — force-removes the container and its auto-created volume.

## Capability tiers (honest — never faked, ADR 59)

- **Runtime mounts.** `addMount` / `removeMount` / `listMounts` throw
  `SandboxUnsupportedError`. Docker cannot bind-mount a host directory onto
  a **running** container. Unlike `stat`/`readdir` (which `bash` subsumes),
  a host-side privileged mount can't be done from inside — so the methods
  exist to signal "unsupported" loudly rather than being silently absent or
  a silent no-op. **Create-time mounts via `-v` DO work** (declare them in
  `SandboxCreateOptions.mounts`) and are honored by path resolution.
- **Network.** Docker enforces egress via `NetworkMode` (ADR 59's
  three-layer split reserves the 127.0.0.1 proxy for `sandbox-local-next`):
  - `allow.network === true` → `NetworkMode: "bridge"` (egress allowed)
  - `false` / undefined → the configured `networkMode` (default `"none"`)
  - `NetworkRule[]` → `SandboxUnsupportedError` at `create`. Per-domain
    egress filtering is not expressible via `NetworkMode`; coarse-mapping a
    default-deny rule list to `bridge` (allow-all) or `none` (deny-all)
    would silently violate the rules. Use `sandbox-local-next`'s egress
    proxy, or a future firewall-sidecar provider, for per-rule egress.
- **Exec abort/timeout.** Detaches the HTTP stream and reports
  `exitCode: 124`, `signaled: true`. The in-container process is reaped on
  `destroy()` — docker exposes no per-exec kill via the Engine API. Carried
  forward from v1.

## API

- `dockerProvider(config?): SandboxProvider`
- `class DockerSandbox implements SandboxHandle`
- `class DockerAPI` — the zero-dep Engine API client (`probe()` gates the
  conformance suite on daemon availability)
- `resolveContainerPath`, `shellQuote`

## Status

Reference-complete for the ADR 59 Wave 2b contract. Passes
`runSandboxProviderConformance` against a **real docker container** where a
daemon is available; the suite skips cleanly where docker is absent.

## Roadmap & known gaps

- **Per-domain egress.** The docker tier is coarse (boolean `NetworkMode`).
  `NetworkRule[]` throws `SandboxUnsupportedError`. A firewall-sidecar /
  in-container `iptables` tier would close this — `TODO(ADR 59)`.
- **Per-exec kill.** Abort/timeout detaches the stream; the in-container
  process lingers until `destroy()`. Docker's Engine API has no exec-kill.
- **Disk limits.** `limits.diskMb` is not mapped (needs storage-driver
  quota support). Memory (`memoryMb`), CPU (`cpuPercent`), and wall-clock
  (`wallClockSec`, as a default per-exec timeout) are honored.
- **`stdin` for interactive processes.** Delivered via a base64 pipe, which
  works for feeding input but does not open a live TTY.
- **`restore` / hibernate.** Intentionally absent — `TODO(#223)`, deferred
  to a remote/CRIU-style provider per ADR 59.

## Verified by

- `src/__tests__/provider-conformance.spec.ts` — runs the real provider
  through `runSandboxProviderConformance` against a live container
  (exec + `onOutput` streaming, fs round-trip, atomic fuzzy + range
  `editFile`, destroy), **gated** on a `docker info` probe. Also pins the
  two capability tiers: runtime mounts throw `SandboxUnsupportedError`
  (docker-gated), and a `NetworkRule[]` throws at `create` (asserted
  without docker — it fails fast).
