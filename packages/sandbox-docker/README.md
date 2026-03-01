# @agentick/sandbox-docker

Docker sandbox provider for Agentick. Executes commands inside Docker containers with full process isolation.

## Quick Start

```typescript
import { dockerProvider } from "@agentick/sandbox-docker";

const provider = dockerProvider();
const sandbox = await provider.create({ workspace: true });

const result = await sandbox.exec("echo hello");
console.log(result.stdout); // "hello\n"

await sandbox.writeFile("test.txt", "content");
const content = await sandbox.readFile("test.txt");

await sandbox.destroy();
```

## How It Works

One container per sandbox. The container runs `sleep infinity` as its main process. All commands execute via `docker exec`. File I/O uses exec internally (`cat` for reads, base64 piping for writes). No host-level filesystem access — the container boundary is the isolation boundary.

Communication with Docker uses the Engine API over `/var/run/docker.sock` via `node:http`. Zero external dependencies.

## Configuration

```typescript
const provider = dockerProvider({
  image: "node:22-slim", // Docker image (default)
  socketPath: "/var/run/docker.sock", // Docker socket
  workspacePath: "/workspace", // Path inside container
  networkMode: "none", // Default network mode
  cleanupContainers: true, // Remove on destroy
  cleanupVolumes: true, // Remove on destroy
  labels: { "my.label": "value" },
});
```

## Workspace

When `workspace: true` (default), a Docker volume is created and mounted at `/workspace`. When a string path is provided, it becomes a bind mount.

```typescript
// Auto volume (default)
const sandbox = await provider.create({ workspace: true });

// Host bind mount
const sandbox = await provider.create({ workspace: "/host/path" });
```

## Mounts

Map host directories into the container.

```typescript
const sandbox = await provider.create({
  workspace: true,
  mounts: [
    { host: "/data/shared", sandbox: "/mnt/shared", mode: "ro" },
    { host: "/data/output", sandbox: "/mnt/output", mode: "rw" },
  ],
});
```

## Resource Limits

```typescript
const sandbox = await provider.create({
  workspace: true,
  limits: {
    memory: 512 * 1024 * 1024, // 512MB (--memory)
    cpu: 0.5, // Half a core (--cpus)
    maxProcesses: 10, // (--pids-limit)
  },
});
```

Resource limits map directly to Docker's container constraints.

## Network

Network is denied by default (`NetworkMode: "none"`). Set `net: true` to enable bridge networking.

```typescript
const sandbox = await provider.create({
  workspace: true,
  permissions: { net: true }, // Enables bridge networking
});
```

## Streaming Output

```typescript
const result = await sandbox.exec("npm install", {
  onOutput: (chunk) => {
    process.stdout.write(`[${chunk.stream}] ${chunk.data}`);
  },
});
```

## With Agentick Components

```tsx
import { Sandbox, Shell, ReadFile, WriteFile } from "@agentick/sandbox";
import { dockerProvider } from "@agentick/sandbox-docker";

const MyAgent = () => (
  <Sandbox provider={dockerProvider()} workspace={true}>
    <Shell />
    <ReadFile />
    <WriteFile />
  </Sandbox>
);
```

## Swapping from Local

Replace one import — the `Sandbox` contract is identical.

```diff
-import { localProvider } from "@agentick/sandbox-local";
+import { dockerProvider } from "@agentick/sandbox-docker";

-const provider = localProvider();
+const provider = dockerProvider();
```

## Security Model

| Threat         | Mitigation                                         |
| -------------- | -------------------------------------------------- |
| Path traversal | POSIX normalize + prefix check (defense-in-depth)  |
| Path escape    | Container filesystem provides the real boundary    |
| Null bytes     | Rejected in all paths                              |
| Output OOM     | 10MB cap per stream                                |
| Zombie sandbox | `destroyed` flag prevents use-after-destroy        |
| Resource abuse | Docker enforces memory, CPU, PID limits            |
| Network escape | `NetworkMode: "none"` by default                   |
| Container leak | Force-remove on destroy, labels for identification |

## Requirements

- Docker Engine running and accessible via `/var/run/docker.sock`
- Docker image available locally (not pulled automatically)

## Testing

Integration tests require a running Docker daemon. Tests skip automatically when Docker is unavailable.

```bash
docker pull node:22-slim
npx vitest run packages/sandbox-docker/
```
