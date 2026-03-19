# @agentick/sandbox-secure-exec

V8 isolate sandbox provider for Agentick using [secure-exec](https://github.com/rivet-dev/secure-exec). Provides lightweight JavaScript execution with ~3.4MB overhead and 16ms cold start — 75-150x less memory than Docker.

## Installation

```bash
pnpm add @agentick/sandbox-secure-exec
```

## Quick Start

```tsx
import { Sandbox, ReadFile, WriteFile, EditFile } from "@agentick/sandbox";
import { secureExecProvider, ExecJS } from "@agentick/sandbox-secure-exec";

const MyAgent = () => (
  <Sandbox provider={secureExecProvider({ network: true })}>
    <ExecJS />
    <ReadFile />
    <WriteFile />
    <EditFile />
  </Sandbox>
);
```

## Provider Configuration

```typescript
const provider = secureExecProvider({
  memoryLimit: 128, // MB (default: 128)
  cpuTimeLimitMs: 30_000, // per exec() call (default: 30,000)
  workspacePath: "/workspace", // VFS root (default: "/workspace")
  moduleAccess: process.cwd(), // host node_modules cwd, false to disable
  network: false, // enable fetch/HTTP (default: false)
  timingMitigation: "off", // "freeze" or "off" (default: "off")
  persistence: adapter, // optional PersistenceAdapter
});
```

## Architecture

### `exec()` runs JavaScript, not shell

Unlike Docker's `exec()` which runs bash commands, secure-exec's `exec()` runs JavaScript directly in a V8 isolate. The tool paired with the provider determines semantics:

- Docker provider → `<Bash />` tool (shell commands)
- secure-exec provider → `<ExecJS />` tool (JavaScript code)
- `ReadFile`/`WriteFile`/`EditFile` → unchanged (use `sandbox.readFile()`/`writeFile()`)

### File operations bypass the isolate

`readFile()`, `writeFile()`, and `editFile()` operate directly on the `MountAwareVFS` — no isolate round-trip. This is a major performance win over Docker which shells out for every file operation.

### Runtime reuse

The `NodeRuntime` is reused across `exec()` calls within a sandbox. State persists (variables, module cache) — same as Docker's `sleep infinity` container pattern. Concurrent `exec()` calls are serialized via queue.

## Tools

### ExecJS

Executes JavaScript code in the isolate. `console.log()` maps to stdout, `console.error()` to stderr. Node.js built-ins (`fs`, `path`, `http`, etc.) are available via `require()`.

### SecureExecTools

Convenience component that bundles `ExecJS` + `ReadFile` + `WriteFile` + `EditFile`:

```tsx
import { SecureExecTools } from "@agentick/sandbox-secure-exec";

<Sandbox provider={secureExecProvider()}>
  <SecureExecTools />
</Sandbox>;
```

## MountAwareVFS

Wraps secure-exec's `InMemoryFileSystem` with host mount pass-through:

- Paths within mounts → delegate to host `node:fs` (respects `ro`/`rw`)
- All other paths → delegate to in-memory VFS
- POSIX path validation prevents workspace/mount escapes

## PersistenceAdapter

Optional interface for saving/restoring VFS state (e.g., to EFS, S3, or disk):

```typescript
interface PersistenceAdapter {
  load(sandboxId: string, vfs: VirtualFileSystem): Promise<void>;
  save(sandboxId: string, vfs: VirtualFileSystem): Promise<void>;
}
```

## Permissions

Sandbox permissions from `SandboxCreateOptions` map to secure-exec's permission system:

| Agentick Permission        | secure-exec Mapping                |
| -------------------------- | ---------------------------------- |
| `fs: true/false`           | VFS handles path scoping           |
| `net: true/false/rules`    | Network adapter + permission check |
| `childProcess: true/false` | Child process permission check     |

## Resource Limits

| Agentick Limit          | secure-exec Mapping |
| ----------------------- | ------------------- |
| `limits.memory` (bytes) | `memoryLimit` (MB)  |
| `limits.timeout` (ms)   | `cpuTimeLimitMs`    |

## Node.js Compatibility

Requires Node.js < 25. The underlying `isolated-vm` native module has a known segfault on Node.js 25+. Use Node.js 22 (LTS) for production.
