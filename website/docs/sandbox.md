# Sandbox

`@agentick/sandbox` provides a sandboxed execution layer for agents — types, a `<Sandbox>` component, pre-built tools, and edit utilities. It's the foundation that provider adapters (`@agentick/sandbox-local`, `@agentick/sandbox-docker`) build on.

The model gets Shell, ReadFile, WriteFile, and EditFile tools that are scoped to their nearest `<Sandbox>` in the component tree. Multiple sandboxes in the same tree work naturally.

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
      <System>You are a coding assistant with sandbox access.</System>
      <Shell />
      <ReadFile />
      <WriteFile />
      <EditFile />
      <Timeline />
    </Sandbox>
  );
}
```

The `<Sandbox>` component initializes the provider, runs optional setup, and provides the sandbox handle to all children via React Context.

## The `<Sandbox>` Component

```tsx
<Sandbox
  provider={localProvider()}
  workspace="/tmp/project"
  mounts={[{ host: "./src", sandbox: "/app/src", mode: "rw" }]}
  allow={{ fs: true, net: false }}
  env={{ NODE_ENV: "development", API_KEY: () => process.env.API_KEY! }}
  limits={{ memory: 512_000_000 }}
  setup={async (sb) => await sb.exec("npm install")}
  persist={true}
>
  {children}
</Sandbox>
```

| Prop        | Type                                       | Default  | Description                |
| ----------- | ------------------------------------------ | -------- | -------------------------- |
| `provider`  | `SandboxProvider`                          | required | Provider adapter           |
| `workspace` | `string \| true`                           | `true`   | Path or auto temp dir      |
| `mounts`    | `Mount[]`                                  | —        | Host-sandbox path mappings |
| `allow`     | `Permissions`                              | —        | Advisory permissions       |
| `env`       | `Record<string, string \| (() => string)>` | —        | Environment variables      |
| `limits`    | `ResourceLimits`                           | —        | Resource constraints       |
| `setup`     | `(sandbox) => Promise<void>`               | —        | Post-creation callback     |
| `persist`   | `boolean`                                  | `false`  | Persist state in snapshots |

Internally, `<Sandbox>` uses `useData` for async initialization and `useOnUnmount` for cleanup. Env functions are resolved at creation time.

## Pre-built Tools

Four tools ship with the package. Each uses `use()` + `useSandbox()` for tree-scoped context injection.

| Tool            | Tool Name    | Description             |
| --------------- | ------------ | ----------------------- |
| `<Shell />`     | `shell`      | Execute a shell command |
| `<ReadFile />`  | `read_file`  | Read file contents      |
| `<WriteFile />` | `write_file` | Write content to a file |
| `<EditFile />`  | `edit_file`  | Apply surgical edits    |

Include all four or pick specific ones:

```tsx
// Full toolkit
<Sandbox provider={provider}>
  <Shell />
  <ReadFile />
  <WriteFile />
  <EditFile />
  <MyAgent />
</Sandbox>

// Read-only
<Sandbox provider={provider}>
  <Shell />
  <ReadFile />
  <MyAgent />
</Sandbox>
```

## Tree Scoping

Tools access their nearest `<Sandbox>` provider via React Context. Two sandboxes in the same tree scope their tools independently:

```tsx
<Sandbox provider={localProvider()}>
  <Shell />          {/* local sandbox */}
  <ReadFile />
  <MyLocalAgent />
</Sandbox>

<Sandbox provider={dockerProvider()}>
  <Shell />          {/* docker sandbox */}
  <WriteFile />
  <MyDockerAgent />
</Sandbox>
```

This works because each tool uses `use: () => ({ sandbox: useSandbox() })`, which captures the value from its position in the tree.

## Custom Tools

Build your own sandbox-backed tools with `useSandbox()`:

```tsx
import { createTool } from "agentick";
import { useSandbox } from "@agentick/sandbox";
import { z } from "zod";

const GrepTool = createTool({
  name: "grep",
  description: "Search files for a pattern",
  input: z.object({
    pattern: z.string(),
    path: z.string().default("."),
  }),
  use: () => ({ sandbox: useSandbox() }),
  handler: async ({ pattern, path }, deps) => {
    const result = await deps!.sandbox.exec(`grep -rn "${pattern}" ${path}`);
    return [{ type: "text", text: result.stdout || "No matches found." }];
  },
});
```

## Edit Utilities

The `applyEdits` function is a pure string transform with 3-level matching that recovers from whitespace and indentation mismatches — designed for LLM-generated edits.

```typescript
import { applyEdits } from "@agentick/sandbox";

const result = applyEdits(source, [
  { old: "return 1;", new: "return 2;" },
  { old: "oldName", new: "newName", all: true },
]);

// result.content  — the modified source
// result.applied  — number of edits applied
// result.changes  — array of { line, removed, added }
```

**Matching strategy** (per edit, in order):

1. **Exact byte match** — the `old` string appears verbatim
2. **Line-normalized** — trailing whitespace stripped from both sides
3. **Indent-adjusted** — leading whitespace baseline stripped

The `editFile` wrapper adds atomic file I/O (temp + rename):

```typescript
import { editFile } from "@agentick/sandbox";

await editFile("/path/to/file.ts", [{ old: "const x = 1;", new: "const x = 42;" }]);
```

Provider adapters use `applyEdits` to implement their `Sandbox.editFile()` method.

## Implementing a Provider

Provider adapters implement `SandboxProvider`:

```typescript
import type { SandboxProvider, SandboxHandle } from "@agentick/sandbox";
import { applyEdits } from "@agentick/sandbox";

export function myProvider(): SandboxProvider {
  return {
    name: "my-provider",
    async create(options) {
      // Set up sandbox environment from options...
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

The `SandboxCreateOptions` passed to `create()` include `workspace`, `mounts`, `permissions`, `env`, and `limits`. Optional `restore()` and `destroy()` methods on the provider support snapshot-based persistence.

## useSandbox()

Access the nearest `Sandbox` from the component tree. Throws if no `<Sandbox>` is above the caller.

```tsx
import { useSandbox } from "@agentick/sandbox";

// In a custom component or tool's use() hook
const sandbox = useSandbox();
const result = await sandbox.exec("ls -la");
```

## Testing

Import test utilities from the `/testing` subpath:

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
