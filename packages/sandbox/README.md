# @agentick/sandbox

Sandbox primitive layer for Agentick. Provides types, React context, a `<Sandbox>` JSX component, and pre-built tools (Shell, ReadFile, WriteFile, EditFile) for sandboxed code execution.

Provider adapters (`@agentick/sandbox-local`, `@agentick/sandbox-docker`, etc.) implement `SandboxProvider` and plug in via the `provider` prop.

## Installation

```bash
pnpm add @agentick/sandbox
```

## Quick Start

```tsx
import { Sandbox, Shell, ReadFile, WriteFile, EditFile } from "@agentick/sandbox";
import { localProvider } from "@agentick/sandbox-local";

function CodingAgent() {
  return (
    <Sandbox provider={localProvider()} workspace="/tmp/project">
      <Shell />
      <ReadFile />
      <WriteFile />
      <EditFile />
      <System>You are a coding assistant with sandbox access.</System>
    </Sandbox>
  );
}
```

## Component

### `<Sandbox>`

Creates a sandbox instance and provides it to children via React context.

```tsx
<Sandbox
  provider={localProvider()} // Required — SandboxProvider implementation
  workspace="/tmp/project" // Path or true for auto temp dir (default: true)
  mounts={[{ host: "./src", sandbox: "/app/src", mode: "rw" }]}
  allow={{ fs: true, net: false }} // Advisory permissions
  env={{ NODE_ENV: "development" }} // Env vars (string or () => string)
  limits={{ memory: 512_000_000 }} // Resource constraints
  setup={async (sb) => {
    // Post-creation setup
    await sb.exec("npm install");
  }}
>
  {children}
</Sandbox>
```

Uses `useData` for async initialization and `useOnUnmount` for cleanup.

## Hook

### `useSandbox()`

Access the nearest `Sandbox` from the component tree. Throws if no provider is found.

```tsx
import { useSandbox } from "@agentick/sandbox";

const sandbox = useSandbox();
const result = await sandbox.exec("ls -la");
```

Primary use: the `use()` hook on `createTool` for tree-scoped sandbox access.

```tsx
const MyTool = createTool({
  name: "my_tool",
  description: "Custom sandbox tool",
  input: z.object({ query: z.string() }),
  use: () => ({ sandbox: useSandbox() }),
  handler: async ({ query }, deps) => {
    const result = await deps!.sandbox.exec(`grep -r "${query}" .`);
    return [{ type: "text", text: result.stdout }];
  },
});
```

## Tools

Four pre-built tools, all using `use()` + `useSandbox()` for tree-scoped access:

| Tool        | Name         | Description                    |
| ----------- | ------------ | ------------------------------ |
| `Shell`     | `shell`      | Execute a shell command        |
| `ReadFile`  | `read_file`  | Read file contents             |
| `WriteFile` | `write_file` | Write content to a file        |
| `EditFile`  | `edit_file`  | Apply surgical edits to a file |

```tsx
import { Shell, ReadFile, WriteFile, EditFile } from "@agentick/sandbox";

// Include all tools
<Sandbox provider={provider}>
  <Shell />
  <ReadFile />
  <WriteFile />
  <EditFile />
  <MyAgent />
</Sandbox>

// Or pick specific tools
<Sandbox provider={provider}>
  <Shell />
  <ReadFile />
  <MyAgent />
</Sandbox>

// Override descriptions via JSX props
<Sandbox provider={provider}>
  <Shell description="Run commands. Prefer one-liners. Avoid interactive programs." />
  <EditFile description="Apply surgical edits. Include enough surrounding context to uniquely match." />
  <ReadFile />
  <MyAgent />
</Sandbox>
```

### Tree Scoping

Multiple sandboxes in the same tree work naturally. Each tool accesses its nearest `<Sandbox>` provider:

```tsx
<Sandbox provider={localProvider()}>
  <Shell />          {/* Uses local sandbox */}
  <ReadFile />
</Sandbox>
<Sandbox provider={dockerProvider()}>
  <Shell />          {/* Uses Docker sandbox */}
  <WriteFile />
</Sandbox>
```

## Edit Utilities

Surgical code editing with 3-level matching that recovers from trailing whitespace, indentation mismatch, and CRLF/LF differences.

### `applyEdits(source, edits)`

Pure transform, no I/O. Matching strategy per edit (in order):

1. Exact byte match
2. Line-normalized (trailing whitespace stripped)
3. Indent-adjusted (leading whitespace baseline stripped)

```typescript
import { applyEdits } from "@agentick/sandbox";

const result = applyEdits(source, [
  { old: "return 1;", new: "return 2;" },
  { old: "oldName", new: "newName", all: true },
]);
// result.content, result.applied, result.changes
```

### `editFile(path, edits)`

File wrapper. Reads, applies edits, writes atomically (temp + rename).

```typescript
import { editFile } from "@agentick/sandbox";

await editFile("/path/to/file.ts", [{ old: "const x = 1;", new: "const x = 42;" }]);
```

## Types

```typescript
import type {
  // Core types
  SandboxHandle, // Runtime handle: exec, readFile, writeFile, editFile, destroy
  SandboxProvider, // Factory: name, create, restore?, destroy?
  SandboxCreateOptions, // Passed to provider.create()
  SandboxConfig, // Component-level config
  SandboxSnapshot, // Serializable state for persistence

  // Execution
  ExecOptions, // Per-command: cwd, env, timeout
  ExecResult, // Output: stdout, stderr, exitCode
  OutputChunk, // Streaming: stream, data

  // Configuration
  Mount, // Host<->sandbox path mapping
  Permissions, // Advisory: fs, net, childProcess, inheritEnv
  ResourceLimits, // Constraints: memory, cpu, timeout, disk, maxProcesses

  // Edit
  Edit, // { old, new, all? }
  EditResult, // { content, applied, changes }
  EditChange, // { line, removed, added }
} from "@agentick/sandbox";
```

## Implementing a Provider

Provider adapters implement `SandboxProvider`:

```typescript
import type { SandboxProvider, SandboxHandle, SandboxCreateOptions } from "@agentick/sandbox";
import { applyEdits } from "@agentick/sandbox";

export function myProvider(): SandboxProvider {
  return {
    name: "my-provider",
    async create(options: SandboxCreateOptions): Promise<SandboxHandle> {
      // Set up sandbox environment...
      return {
        id: crypto.randomUUID(),
        workspacePath: "/sandbox/workspace",
        async exec(command, opts) {
          /* ... */
        },
        async readFile(path) {
          /* ... */
        },
        async writeFile(path, content) {
          /* ... */
        },
        async editFile(path, edits) {
          const source = await this.readFile(path);
          const result = applyEdits(source, edits);
          if (result.applied > 0) await this.writeFile(path, result.content);
          return result;
        },
        async destroy() {
          /* ... */
        },
      };
    },
  };
}
```

## Testing

Import test utilities from `@agentick/sandbox/testing`:

```typescript
import { createMockSandbox, createMockProvider } from "@agentick/sandbox/testing";

const sandbox = createMockSandbox({
  exec: vi.fn().mockResolvedValue({ stdout: "hello", stderr: "", exitCode: 0 }),
});

const provider = createMockProvider({
  create: vi.fn().mockResolvedValue(sandbox),
});
```

Both return objects with `vi.fn()` stubs and sensible defaults. Override any method via the options parameter.

## License

MIT
