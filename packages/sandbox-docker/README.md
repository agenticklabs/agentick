# @agentick/sandbox-docker

**One container per sandbox, and an honest account of what a container can't do.** Commands run through `docker exec` with output streaming as it arrives, file I/O rides the same channel, `editFile` reuses the base package's transform behind an atomic write, and egress is the container's `NetworkMode`.

It talks to the Docker Engine API over the Unix socket through a `node:http` client written here — no `dockerode`, no third-party dependency. The whole package deps [@agentick/sandbox](../sandbox) and nothing else.

## Install

```bash
npm install @agentick/sandbox @agentick/sandbox-docker
```

Single entry point, no subpaths. Requires a reachable Docker daemon.

## Quick start

```ts
import { dockerProvider } from "@agentick/sandbox-docker";

const provider = dockerProvider({ image: "node:22-slim" });
const sandbox = await provider.create({ workspace: true });

const { stdout } = await sandbox.exec("node -e 'console.log(1 + 1)'"); // "2\n"
await sandbox.writeFile("notes.md", "# Notes");
await sandbox.editFile("notes.md", [{ old: "# Notes", new: "# Journal" }]);

await sandbox.destroy(); // force-removes the container and its auto volume
```

The container is created, started, and kept alive with `sleep infinity` for the sandbox's lifetime. Under an agent you mount the provider with `<Sandbox provider={provider}>` rather than driving the handle yourself — see [@agentick/sandbox](../sandbox).

## Configuration

```ts
const provider = dockerProvider({
  image: "node:22-slim", // default
  socketPath: "/var/run/docker.sock", // default
  workspacePath: "/workspace", // where the workspace lives inside the container
  networkMode: "none", // NetworkMode when network isn't explicitly allowed
  cleanupContainers: true, // remove on destroy
  cleanupVolumes: true,
  labels: { "com.example.owner": "agentick" }, // applied to containers and volumes
});
```

## What each handle method does

**`exec`** runs `sh -c` in the workspace via `docker exec`, decoding Docker's multiplexed frame protocol so each stdout and stderr chunk reaches `options.onOutput` as it arrives; the final `stdout` and `stderr` stay authoritative. Honors `cwd`, `env`, `stdin`, `timeoutMs`, and an external `signal`; reports `exitCode`, `signaled`, and `durationMs`.

**`readFile` / `writeFile`** are confined to the workspace plus create-time mounts. Traversal and null bytes are rejected with `SandboxEscapeError`, and a write into a read-only mount raises `SandboxPermissionDeniedError`. Reads use `cat`; writes base64-decode into a temp file and `mv` it into place, which is the provider-owned atomic write.

**`editFile`** reads, runs the base package's `applyEdits` with its layered matching, and writes through the same atomic path.

**`destroy`** force-removes the container and the volume it created.

## What Docker can't do, stated plainly

Both limits below throw `SandboxUnsupportedError` rather than degrading. The methods exist specifically so the failure is loud — a silently absent method looks like a provider that forgot, and a silent no-op looks like success.

**Runtime mounts.** `addMount`, `removeMount`, and `listMounts` throw. Docker cannot bind-mount a host directory onto an already-running container. Unlike listing and metadata — which `bash` subsumes — a host-side mount cannot be performed from inside, so there is no workaround to fall back to.

Create-time mounts **do** work. Declare them and path resolution honors them:

```ts
const sandbox = await provider.create({
  workspace: true,
  mounts: [{ hostPath: "/Users/me/repo", sandboxPath: "/workspace/repo", readOnly: true }],
});
```

**Per-domain egress.** `NetworkMode` is the only egress control a container gives you, and it's boolean:

| `allow.network`     | Result                                         |
| ------------------- | ---------------------------------------------- |
| `true`              | `NetworkMode: "bridge"` — egress allowed       |
| `false`/`undefined` | The configured `networkMode`, default `"none"` |
| `NetworkRule[]`     | `SandboxUnsupportedError` thrown at `create`   |

The rule list throws rather than approximating. Coarse-mapping a default-deny rule list onto `bridge` would allow everything the rules deny, and onto `none` would deny everything they allow — either way the caller's stated policy is violated while the call appears to succeed. For per-rule egress use [@agentick/sandbox-local](../sandbox-local), whose loopback proxy evaluates rules directly.

## Exec abort has no per-exec kill

Aborting or timing out detaches the HTTP stream and reports `exitCode: 124` with `signaled: true`. The in-container process keeps running until `destroy()` reaps the container, because the Docker Engine API exposes no way to kill an individual exec. Budget for that in long-running commands: cancellation frees your side of the stream, not the container's CPU.

## The Engine API client

`DockerAPI` is exported because it's occasionally useful on its own — most often `probe()`, which is how the conformance suite decides whether a daemon is even there:

```ts
import { DockerAPI, DockerAPIError } from "@agentick/sandbox-docker";

const api = new DockerAPI(); // or new DockerAPI("/custom/docker.sock")
if (!(await api.probe(3000))) {
  console.log("no docker daemon — skipping");
}
```

It covers `ping`, `probe`, `pullImage`, `createContainer`, `startContainer`, `removeContainer`, `execCreate`, `execStart`, `execInspect`, `createVolume`, and `removeVolume`. Failures surface as `DockerAPIError`.

## API

| Export                                                                        | Purpose                                                                                                                       |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `dockerProvider(config?)`                                                     | The provider. Config: `image`, `socketPath`, `workspacePath`, `networkMode`, `cleanupContainers`, `cleanupVolumes`, `labels`. |
| `DockerSandbox` / `DockerSandboxInit`                                         | The handle class and its constructor input.                                                                                   |
| `MountInfo`                                                                   | A resolved create-time mount: `hostPath`, `containerPath`, `readOnly`.                                                        |
| `DockerAPI` / `DockerAPIError`                                                | The zero-dependency Engine API client and its error.                                                                          |
| `ContainerConfig` / `ExecConfig` / `ExecStreamCallbacks` / `ExecStreamResult` | Engine API request and response shapes.                                                                                       |
| `resolveContainerPath` / `shellQuote`                                         | Path resolution and shell quoting, exported for provider-adjacent tooling.                                                    |

## Patterns

**Under an agent.** [@agentick/sandbox](../sandbox) wraps this handle with journaling, the approval gate, and the four model-facing tools.

**Choosing a provider.** [@agentick/sandbox-local](../sandbox-local) gives per-domain egress and runtime mounts with OS-level jails; this one gives container-level isolation and image reproducibility; [@agentick/sandbox-lambda](../sandbox-lambda) gives ephemeral serverless execution.

**Certifying your own.** `runSandboxProviderConformance` from `@agentick/sandbox/testing` is what pins this provider, and what a new one should run.

## Roadmap & known gaps

- **No per-domain egress.** `NetworkRule[]` throws. A firewall sidecar or in-container `iptables` tier would close the gap; neither is built.
- **No per-exec kill.** Abort detaches the stream; the process lingers until `destroy()`.
- **`limits.diskMb` is not mapped.** It needs storage-driver quota support. `memoryMb`, `cpuPercent`, and `wallClockSec` (as a default per-exec timeout) are honored.
- **`stdin` is a pipe, not a TTY.** Input is delivered base64-decoded, which feeds a process fine but doesn't open an interactive terminal.
- **`restore` is not implemented.** Hibernate is deferred to a provider with real checkpointing.

## Verified by

- `src/__tests__/provider-conformance.spec.ts` — the real provider through `runSandboxProviderConformance` against a live container: exec with `onOutput` streaming, filesystem round-trip, atomic fuzzy and range `editFile`, destroy. Gated on a `docker info` probe, so it skips cleanly where no daemon exists.
- The same file pins both capability tiers: runtime mounts throw `SandboxUnsupportedError` (Docker-gated), and a `NetworkRule[]` throws at `create` — asserted without Docker, because it fails fast before any container is created.
