# @agentick/sandbox-local

Local sandbox provider for Agentick. Executes commands on the host machine with OS-level security rails.

## Quick Start

```typescript
import { localProvider } from "@agentick/sandbox-local";

const provider = localProvider();
const sandbox = await provider.create({ workspace: true });

const result = await sandbox.exec("echo hello");
console.log(result.stdout); // "hello\n"

await sandbox.writeFile("test.txt", "content");
const content = await sandbox.readFile("test.txt");

await sandbox.destroy();
```

## Sandbox Strategies

The provider automatically selects the best available isolation strategy:

| Strategy   | Platform | Isolation                                                     |
| ---------- | -------- | ------------------------------------------------------------- |
| `seatbelt` | macOS    | Apple Sandbox (`sandbox-exec`) with SBPL profiles             |
| `bwrap`    | Linux    | Bubblewrap with namespace isolation                           |
| `unshare`  | Linux    | `unshare` with user namespaces                                |
| `none`     | Any      | No OS sandboxing (workspace isolation + path validation only) |

```typescript
// Auto-detect (default)
const provider = localProvider();

// Force a specific strategy
const provider = localProvider({ strategy: "seatbelt" });
const provider = localProvider({ strategy: "none" }); // For testing
```

## Platform Detection

```typescript
import { detectCapabilities } from "@agentick/sandbox-local";

const caps = await detectCapabilities();
// {
//   platform: "darwin",
//   arch: "arm64",
//   hasSandboxExec: true,
//   recommended: "seatbelt",
//   ...
// }
```

## Network Rules

Control sandbox network access with fine-grained rules.

```typescript
const sandbox = await provider.create({
  workspace: true,
  permissions: {
    net: [
      { action: "allow", domain: "api.github.com" },
      { action: "allow", domain: "*.npmjs.org" },
      { action: "deny", domain: "*.evil.com" },
      { action: "allow", port: 443, methods: ["GET"] },
    ],
  },
});
```

Rules are evaluated in order. First match wins. Default action is **deny**.

When `NetworkRule[]` is provided, a transparent HTTP proxy is started. HTTPS connections are filtered at the CONNECT level (domain allow/block without TLS termination).

## Permissions

```typescript
const sandbox = await provider.create({
  workspace: true,
  permissions: {
    fs: true, // Filesystem access (default: true)
    net: false, // Network access (default: false)
    childProcess: true, // Fork processes (default: true)
    inheritEnv: false, // Inherit host env vars (default: false)
  },
});
```

## Mounts

Map host directories into the sandbox.

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
    memory: 512 * 1024 * 1024, // 512MB
    cpu: 0.5, // Half a core
    timeout: 30000, // 30s global timeout
    disk: 100 * 1024 * 1024, // 100MB workspace
    maxProcesses: 10,
  },
});
```

Resource limits use cgroups v2 on Linux. On macOS, timeout and disk limits are enforced; memory/CPU are advisory.

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
import { localProvider } from "@agentick/sandbox-local";

const MyAgent = () => (
  <Sandbox provider={localProvider()} workspace={true}>
    <Shell />
    <ReadFile />
    <WriteFile />
  </Sandbox>
);
```

## Testing

```typescript
import { createTestProvider, isDarwin } from "@agentick/sandbox-local/testing";

const provider = createTestProvider(); // strategy: "none"
const sandbox = await provider.create({ workspace: true });

// Platform-gated tests
describe.skipIf(!isDarwin)("seatbelt tests", () => { ... });
```

## Security Model

**Safe by default.** The sandbox denies access to sensitive resources unless explicitly allowed.

### macOS Seatbelt (reads)

Sandboxed processes can read system libraries and executables (required for bash/node), but **cannot** read:

| Denied Path               | Contains                                                           |
| ------------------------- | ------------------------------------------------------------------ |
| `/Users`                  | Home directories — SSH keys, `.env`, browser profiles, credentials |
| `/private/var/root`       | Root's home directory                                              |
| `/Volumes`                | Mounted drives, encrypted volumes, network shares                  |
| `/Network`                | Network-mounted resources                                          |
| `/Library/Keychains`      | System-level keychains and certificates                            |
| `/private/var/db/dslocal` | Local directory service (user account data)                        |

The workspace and any configured mounts are re-allowed via SBPL specificity rules (more-specific subpath allows override broader denies).

### Write restrictions

All strategies restrict writes to:

- The workspace directory
- Configured read-write mounts
- `/tmp` and `/dev`

### Additional protections

| Threat              | Mitigation                                                     |
| ------------------- | -------------------------------------------------------------- |
| Path traversal      | `realpath()` + bounds check                                    |
| Symlink escape      | Follow symlinks before validation                              |
| Null byte injection | Reject null bytes in all paths                                 |
| Output OOM          | 10MB cap per stream                                            |
| Env var injection   | Blocklist for `LD_PRELOAD`, `DYLD_*`                           |
| Process orphans     | Kill process group (`detached` + `-pid`), SIGTERM then SIGKILL |
| Zombie sandbox      | `destroyed` flag prevents use-after-destroy                    |
| Disk bomb           | Polling monitor kills processes on exceed                      |

### Platform requirements

**macOS**: `/usr/bin/sandbox-exec` (ships with macOS, no install needed).

**Linux**: One of:

- `bwrap` (bubblewrap) — install via `apt install bubblewrap` or equivalent
- `unshare` with unprivileged user namespaces enabled (`sysctl kernel.unprivileged_userns_clone=1`)
- cgroups v2 for memory/CPU/process limits (writable `/sys/fs/cgroup`)

**All platforms**: Falls back to `strategy: "none"` (workspace isolation + path validation only, no OS-level sandboxing) when no sandbox tooling is available.
