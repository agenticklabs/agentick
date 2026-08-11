# @agentick/sandbox

**The provider is the security boundary. Everything in this package is policy and audit.** A sandbox reaches the model as four tools; every call those tools make becomes a journaled harness command that clears an access-control gate before it touches a filesystem or spawns a process.

That split is the whole design. Isolation is an OS problem, so it lives behind the `SandboxProvider` interface and each provider states its own isolation tier honestly. What lives here is the part that isn't OS-specific: the command surface, the approval flow, the edit transform, and the observability that lets you replay every operation an agent performed.

## Install

```bash
npm install @agentick/sandbox @agentick/sandbox-local
```

You need two packages: this one and a provider. Subpaths: `/react` (component + hook + tools), `/mcp` (roots and file resources), `/testing` (provider conformance suite + in-memory fake).

## Quick start

```tsx
import type { AppExtension } from "@agentick/spec";
import { withSandbox } from "@agentick/sandbox";
import { Bash, EditFile, ReadFile, Sandbox, WriteFile } from "@agentick/sandbox/react";
import { localProvider } from "@agentick/sandbox-local";

// Goes into `createApp(Agent, { extensions })`.
export const extensions: AppExtension[] = [withSandbox()];

const provider = localProvider();

export function Agent() {
  return (
    <Sandbox
      provider={provider}
      workspace
      allow={{ read: ["/workspace/**"], exec: { allow: ["git *", "npm test"] } }}
    >
      <Bash.Tool />
      <ReadFile.Tool />
      <WriteFile.Tool />
      <EditFile.Tool />
    </Sandbox>
  );
}
```

> [!IMPORTANT]
> The tools are values, not components — mount them as `<Bash.Tool />`. `Bash` itself is the created tool (name, schema, handler); `Bash.Tool` is the React element that registers the handler with the session.

`withSandbox()` must be installed even if no `<Sandbox>` ever mounts: it builds the registry on the app's substrate at install time, which is what lets sandbox operations journal into the same store as everything else and show up in `app.events({ surface: "sandbox" })`.

## Security boundary

Read this before choosing a provider.

`SandboxHarness`, the access-control gate, and the four-tool surface decide **what the model is offered** and **which operations prompt for approval**. A call that clears them executes with whatever permissions the provider grants. Real confinement comes from OS-native mechanisms inside the provider — Landlock and seccomp on Linux, Seatbelt on macOS, restricted tokens and job objects on Windows — never from glob patterns and never from inspecting command strings.

> [!WARNING]
> A "read-only" configuration that exposes only `read_file` is a tool allowlist, not a sandbox. It shapes what the model tends to do; a payload that reaches `exec` is bound only by the provider's jail. Match the provider's declared isolation tier to the trust you place in the code you are about to run.

## Four tools, and `bash` is the escape hatch

| Tool         | What it does                                                             |
| ------------ | ------------------------------------------------------------------------ |
| `bash`       | Run a shell command. Takes `command`, optional `cwd` and `timeoutMs`.    |
| `read_file`  | Read a file by absolute in-sandbox path. Structured, no shell quoting.   |
| `write_file` | Write content without shell escaping.                                    |
| `edit_file`  | Surgical edits against existing content — the one tool that beats `sed`. |

There is no `stat` and no `readdir`, on the tools or on `SandboxHandle`. `bash` already covers listing and metadata (`ls`, `stat`, `find`, git, installs), and a synthesized answer is worse than none: an earlier iteration returned `Date.now()` as every file's mtime and labelled every directory entry `"file"`. A primitive that lies is a bug the model cannot see.

Compose your own tools when the built-ins don't fit — they are ordinary `createTool` calls over the same harness commands, and the section below shows how they reach the sandbox.

## Approval — static allowlist, then ask, then remember

Every `exec`, `read`, and `write` passes `checkPermission` before the provider sees it. Three outcomes:

1. **Allowed by the static ACL** you declared on `allow` — proceeds silently.
2. **Denied by the static ACL** — fails with `SandboxPermissionDeniedError`. Only `exec` has a static deny list, and it is checked before any allow, so deny wins. `read` and `write` take allow patterns only.
3. **Neither** — the harness raises an elicitation and waits for a human.

The prompt is not a bespoke channel. It goes through the session's elicitation harness with `hints.kind: "sandbox_permission"`, so any client that already renders elicitations renders this one, and the envelope's `metadata` carries the structured request (kind, path or command, sandbox id, rationale) for a typed UI.

Four replies, two of which are durable for the rest of the session:

| Reply                   | Effect                                            |
| ----------------------- | ------------------------------------------------- |
| `allow-once`            | This call only.                                   |
| `allow-session`         | Remember this exact target as allowed.            |
| `allow-session-pattern` | Remember a pattern (`"git *"`, `"regex:^/tmp/"`). |
| `deny` / `deny-session` | Refuse once, or remember the target as denied.    |

```tsx
<Sandbox
  provider={provider}
  allow={{ read: ["/workspace/**"], exec: { deny: ["rm -rf *", "curl *"] } }}
  onPermissionTimeout="deny" // default; "allow-once" for unattended runs
  permissionTimeoutMs={30_000}
/>
```

Timeout, decline, cancel, and schema violations all resolve to `onPermissionTimeout` — an unanswered prompt never becomes an accidental yes unless you say so.

What the session learned is snapshot state, so approvals survive a restart:

```ts
const snap = sandbox.exportACLSnapshot();
// ... later, in a fresh process ...
sandbox.importACLSnapshot(snap);
```

`allow.network` is carried through to the provider rather than gated here — egress is enforced where packets actually leave.

## Reaching the sandbox from a handler

`ctx.sandbox` is the app-scoped registry, resolved **at dispatch** from the live bridge. This is how the built-in tools work and how yours should:

```ts
import { createTool } from "@agentick/compiler-react";
import { z } from "zod";
import "@agentick/sandbox"; // brings the `ctx.sandbox` slot into scope

export const Typecheck = createTool({
  name: "typecheck",
  description: "Run tsc over the workspace",
  inputSchema: z.object({ project: z.string().default("tsconfig.json") }),
  async handler({ project }, { ctx }) {
    const sandbox = ctx.sandbox?.get("primary");
    if (!sandbox) return [{ type: "text", text: "no sandbox mounted" }];
    const { stdout, exitCode } = await sandbox.exec({ command: `npx tsc -p ${project} --noEmit` });
    return [{ type: "text", text: exitCode === 0 ? "clean" : stdout }];
  },
});
```

`ctx.sandbox` is `undefined` when `withSandbox()` isn't installed, so guard it. It carries the same registry as `useBridges().sandbox`; reading it at dispatch rather than capturing it at render means it always reflects current state. The built-ins target `"primary"` — the default `<Sandbox>` id — and fall back to the sole registered sandbox when exactly one exists; with several non-primary sandboxes they report an error rather than guess, and you route explicitly by id.

`useSandbox()` is the other door: a React hook returning the tree-nearest harness instance, or `null`. Reserve it for genuinely **tree-positional** selection — "the sandbox this subtree is under" — captured through a tool's `use:` slot. Anything app-scoped belongs on `ctx.sandbox`.

```tsx
import { useSandbox } from "@agentick/sandbox/react";

const InScope = createTool({
  name: "in_scope_exec",
  description: "Exec in the sandbox this subtree is mounted under",
  inputSchema: z.object({ command: z.string() }),
  use: () => ({ sandbox: useSandbox() }),
  async handler({ command }, { use }) {
    if (!use.sandbox) return [{ type: "text", text: "no sandbox in this subtree" }];
    const { stdout } = await use.sandbox.exec({ command });
    return [{ type: "text", text: stdout }];
  },
});
```

Neither the tool executor nor the app harness imports this package. The `ctx.sandbox` type arrives by module augmentation from here; the value is filled generically from the registered `sandbox` namespace.

## `edit_file` — layered matching

`applyEdits` is a pure function, exported so you can test edit batches without a sandbox at all. Mode is detected by which fields you set, not by a discriminator:

```ts
import { applyEdits, EditError } from "@agentick/sandbox";

const result = applyEdits(source, [
  { old: "const x = 1;", new: "const x = 2;" }, // replace
  { old: "debugger;", delete: true }, // delete, trailing newline consumed
  { old: "// imports", insert: "after", content: 'import fs from "node:fs";' },
  { insert: "end", content: "\nexport {};\n" }, // append
  { from: "function old(", to: "}", content: "function neo() {}" }, // range, inclusive
  { old: "oldName", new: "newName", all: true }, // every occurrence
]);
result.applied; // number of edits applied
result.changes; // [{ line, added, removed }, ...]
```

Matching runs three strategies in order: exact, then line-normalized (trailing whitespace), then indent-adjusted — a model that supplies unindented code still matches, and the replacement is re-indented to the site. CRLF is normalized. Overlapping edits within a batch are rejected before anything is written. On failure `EditError` carries the closest partial match with its line number and surrounding context, which is what lets the model correct itself instead of retrying blindly.

Every edit resolves against the **original** content, so a batch is order-independent. Atomicity is the provider's job: the harness runs the permission check and delegates to `handle.editFile`, which writes via temp-and-rename. The transform itself never touches a filesystem.

## Mounts are commands, not tools

Mounting a host directory is a host-side privileged operation the sandboxed process cannot perform from inside. Unlike listing and metadata, `bash` does **not** subsume it — so it gets real harness commands and is deliberately never exposed to the model.

```ts
await sandbox.addMount({ mount: { hostPath: "/Users/me/repo", sandboxPath: "/workspace/repo" } });
await sandbox.listMounts();
await sandbox.removeMount({ sandboxPath: "/workspace/repo" });
const stop = sandbox.subscribeMounts(() => console.log("topology changed"));
```

Two guards apply. `mountAllow` on the create options is the ceiling: host-path patterns that _may_ be mounted at runtime. Anything outside it fails with `SandboxPermissionDeniedError { kind: "mount" }`, and leaving it `undefined` denies runtime mounting entirely. Create-time `mounts` are the operator's explicit initial authorization and are honored regardless. And the three handle methods are capability-tiered — a provider that cannot remount a running instance leaves them `undefined` or throws `SandboxUnsupportedError`, which the harness feature-detects and surfaces. No provider fakes a successful mount.

## Streaming exec output

Long-running commands stream. The harness injects an `onOutput` callback into every `exec` and bridges each chunk onto the `delta` phase of the `sandbox:exec` operation, so tailing stdout is an ordinary event subscription:

```ts
for await (const event of app.events({ surface: "sandbox", phase: "delta" })) {
  const delta = event.payload as SandboxExecDelta;
  (delta.stream === "stderr" ? process.stderr : process.stdout).write(delta.chunk);
}
```

Providers that can't stream simply never call it; the final `SandboxExecResult` stays authoritative either way.

## Constructing a sandbox without JSX

`<Sandbox>` is a convenience over the registry. Calling it directly is the route to the create options the component doesn't forward — `mountAllow` and `setup`:

```ts
import type { SandboxBridge, SandboxHarness, SandboxProvider } from "@agentick/sandbox";
import type { ElicitationHarnessProtocol } from "@agentick/spec";

export function spinUp(
  bridge: SandboxBridge,
  elicitation: ElicitationHarnessProtocol,
  provider: SandboxProvider,
): Promise<SandboxHarness> {
  return bridge.createHarness({
    sandboxId: "primary",
    provider,
    elicitation, // every approval round-trip goes through this
    options: {
      workspace: true,
      mountAllow: ["/Users/me/projects/**"], // the runtime-mount ceiling
      async setup(handle) {
        await handle.exec("git clone --depth 1 https://github.com/me/repo /workspace/repo");
        await handle.exec("npm ci", { cwd: "/workspace/repo" });
      },
    },
  });
}
```

`setup(handle)` runs once, after the provider produces the handle and before the harness is handed back — clone a repo, install dependencies, seed fixtures. The bridge invokes it rather than the provider, so it behaves identically across every provider.

`withSandbox({ initialize })` hands you the same bridge at install time, which is how you pre-spin a sandbox at app init instead of waiting for JSX to mount one. You supply the elicitation harness yourself there; the installer doesn't carry one.

## MCP roots and file resources — `/mcp`

An opt-in adapter that projects a sandbox onto two MCP surfaces. It is a projection over primitives that already exist, not a new layer: mount state stays owned by the sandbox, reads stay owned by [@agentick/resources](../resources), and the MCP client core stays free of any sandbox dependency.

```ts
import {
  bindSandboxRootsToClient,
  registerFileResolver,
  sandboxFileResolver,
  sandboxRootsSource,
} from "@agentick/sandbox/mcp";

// Outbound: offer workspace + live mounts as file:// roots, kept in sync.
const roots = sandboxRootsSource(sandbox); // pass to the MCP client's `roots`
const stop = bindSandboxRootsToClient(sandbox, mcpClient); // fires notifyRootsListChanged

// Read: expose mounted files as resources under file://{+path}.
registerFileResolver(resources, sandboxFileResolver(sandbox));
```

`sandboxRootsSource` re-evaluates on every `roots/list`, so it reflects live mounts, and degrades to workspace-only against a provider without `listMounts`. `bindSandboxRootsToClient` subscribes to mount changes and returns an `Unsubscribe`.

Roots do not require a sandbox — a static list or a plain provider function works, and that path lives in [@agentick/mcp](../mcp). The inbound direction, a connecting client's roots on `ctx.mcp.clientRoots`, needs no sandbox either.

`fsFileResolver(rootDir)` is the no-sandbox backend: lossless text plus base64 blobs for binary, root-contained. `sandboxFileResolver` is text-only, because the handle contract exposes only `readFile(): string`.

## A live process — `spawn`

`exec` is fire-and-collect: you get the command's output once it is over. That is the wrong shape for a supervised child — one that calls back into the host _while_ it runs — so a handle may offer `spawn` instead, which returns a live process with four streams: the program's `stdout` and `stderr`, a **control channel** carrying the supervising protocol, and `exit`.

```ts
const proc = await sandbox.spawn!({
  command: "/usr/bin/node",
  args: [supervisorPath],
  readablePaths: [supervisorPath], // outside the workspace, so grant the read
});

proc.onControl((chunk) => reader(chunk));
proc.writeControl(`${JSON.stringify(frame)}\n`);
```

The control channel is separate from `stdout` **by construction**, which is what stops a program printing JSON at its own stdout from forging a frame. `readablePaths` exists because a confined process cannot read its own entry script by default; the provider grants those paths read-only at the same path on both sides, and never grants a write alongside.

Like `addMount`, this is **capability-tiered**: a provider with no long-lived process surface leaves `spawn` undefined or throws `SandboxUnsupportedError`. It never degrades to `exec`, because silently dropping the control channel would break the caller's protocol rather than fail it.

[@agentick/code-host](../code-host) is the consumer: `sandboxHostPort(handle)` places the runtime that executes model-authored code inside the jail.

## Writing a provider

Implement `SandboxProvider`, return a `SandboxHandle`, and prove it with the shipped conformance suite. The suite drives a **real** instance — exec, file round-trips, edits, mounts, teardown — so passing it means the contract holds, not that a mock agreed with you.

```ts
import { runSandboxProviderConformance } from "@agentick/sandbox/testing";
import { myProvider } from "../src/index.js";

runSandboxProviderConformance(() => myProvider(), { label: "my-provider" });
```

For wiring tests that shouldn't spawn processes, `fakeSandboxProvider` is a working in-memory implementation with a seedable filesystem and programmable `exec`:

```ts
import { fakeSandboxProvider } from "@agentick/sandbox/testing";

const provider = fakeSandboxProvider({
  files: { "/workspace/a.ts": "export const a = 1;\n" },
  execHandler: (command) => (command.startsWith("git") ? { stdout: "ok" } : { exitCode: 127 }),
});
```

Anything a provider needs is importable from the package root — the construction contracts and the re-exported wire types both — so a provider has one import source.

## API

### `@agentick/sandbox`

| Export                                      | Purpose                                                                                                                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withSandbox(options?)`                     | App extension; builds the registry on the app substrate. Takes `initialize`.                                                                                                                       |
| `SandboxHarness`                            | Wraps one handle: eight commands, the approval gate, ACL snapshots.                                                                                                                                |
| `SandboxProvider` / `SandboxHandle`         | What a provider implements and what `create()` returns.                                                                                                                                            |
| `SandboxSpawnRequest` / `SandboxProcess`    | The capability-tiered live-process surface: argv in, four streams out.                                                                                                                             |
| `SandboxCreateOptions`                      | `workspace`, `mounts`, `mountAllow`, `allow`, `env`, `limits`, `setup`.                                                                                                                            |
| `SandboxBridge` / `inMemorySandboxBridge()` | The registry interface, and an unwired one for tests.                                                                                                                                              |
| `applyEdits(source, edits)` / `EditError`   | The pure edit transform and its diagnostic error.                                                                                                                                                  |
| `matchRequest` / `matchDomain`              | Pure egress matcher: first match wins, default-deny, `*.domain` wildcards.                                                                                                                         |
| `SessionACL` / `matchesACLPattern`          | Learned allow/deny state and the glob / `regex:` matcher behind it.                                                                                                                                |
| `SandboxError` and subclasses               | `SandboxPermissionDeniedError`, `SandboxUnsupportedError`, `SandboxExecError`, `SandboxIoError`, `SandboxMountError`, `SandboxEscapeError`, `SandboxResourceLimitError`, `SandboxConnectionError`. |
| `SandboxSnapshot` / `SandboxIntent`         | The hibernate seam — declared, not yet wired (see gaps).                                                                                                                                           |
| Wire types (re-exported)                    | `SandboxExec*`, `SandboxEdit*`, mount inputs, `SandboxPermissions`, `NetworkRule`, `ProxiedRequest`.                                                                                               |

### A harness instance

| Member                                                    | Returns                                                |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `exec(input)`                                             | `SandboxExecResult` — gated, journaled, streams deltas |
| `readFile` / `writeFile`                                  | `string` / `void` — gated                              |
| `editFile(input)`                                         | `SandboxEditResult`                                    |
| `addMount` / `removeMount` / `listMounts`                 | Ceiling-gated, capability-tiered                       |
| `subscribeMounts(fn)`                                     | `Unsubscribe` — fires on topology change               |
| `exportACLSnapshot()` / `importACLSnapshot(s)`            | Durable approvals                                      |
| `destroy()`                                               | Tears down provider resources                          |
| `sandboxId` / `workspacePath` / `providerName` / `status` | Identity and lifecycle                                 |

Addressable command names: `sandbox:exec`, `sandbox:read-file`, `sandbox:write-file`, `sandbox:edit-file`, `sandbox:add-mount`, `sandbox:remove-mount`, `sandbox:list-mounts`, `sandbox:destroy`.

### `@agentick/sandbox/react`

| Export                                         | Purpose                                                |
| ---------------------------------------------- | ------------------------------------------------------ |
| `<Sandbox>`                                    | Materializes a sandbox and provides it to descendants. |
| `useSandbox()`                                 | Tree-nearest harness instance, or `null`.              |
| `Bash` / `ReadFile` / `WriteFile` / `EditFile` | The built-in tools; mount as `<X.Tool />`.             |

`<Sandbox>` props: `provider` (required) · `id` (default `"primary"`) · `workspace`, `mounts`, `allow`, `env`, `limits` · `onPermissionTimeout`, `permissionTimeoutMs`.

### `@agentick/sandbox/mcp`

| Export                                                              | Purpose                                     |
| ------------------------------------------------------------------- | ------------------------------------------- |
| `sandboxRootsSource(sandbox)`                                       | Workspace + live mounts as `file://` roots. |
| `bindSandboxRootsToClient(sandbox, client)`                         | Keeps a connected server's roots in sync.   |
| `sandboxFileResolver` / `fsFileResolver`                            | `file://` template resolvers.               |
| `registerFileResolver(resources, resolver)`                         | Mounts a resolver on a resources harness.   |
| `FILE_URI_TEMPLATE`, `pathToFileUri`, `guessMimeType`, `isTextMime` | URI helpers.                                |

### `@agentick/sandbox/testing`

| Export                          | Purpose                                          |
| ------------------------------- | ------------------------------------------------ |
| `runSandboxProviderConformance` | Certify a provider against a real instance.      |
| `fakeSandboxProvider(options?)` | In-memory provider: seeded files, scripted exec. |

## Patterns

**Providers.** [@agentick/sandbox-local](../sandbox-local) runs on the host filesystem, [@agentick/sandbox-docker](../sandbox-docker) in a container, [@agentick/sandbox-lambda](../sandbox-lambda) in a Lambda invocation. All three implement `SandboxProvider` from here.

**Approval UI.** [@agentick/elicitation](../elicitation) owns the prompt transport. Filter on `hints.kind === "sandbox_permission"` to render a purpose-built dialog instead of a generic form.

**Tools.** [@agentick/compiler-react](../compiler-react) owns `createTool` and the `use:` slot; [@agentick/tool](../tool) owns the tool registry the handlers land in.

**Observability.** Every command journals through [@agentick/runtime](../runtime), so `app.events({ scope: { sandboxId } })` narrows the audit trail to one sandbox.

## Roadmap & known gaps

- **`mountAllow` and `setup` are unreachable from JSX.** `<Sandbox>` forwards `workspace`, `mounts`, `allow`, `env`, and `limits` and nothing else — so a JSX-mounted sandbox always denies runtime mounting and never bootstraps. Both need `bridge.createHarness` until the props land.
- **Hibernate and restore are unwired.** `SandboxProvider.restore` and `SandboxSnapshot` are declared contract seams; the bridge only ever calls `create()`, and no provider implements a real checkpoint.
- **No diff preview on `edit_file`.** The tool-executor confirmation seam has no structured diff slot, so approval falls to the ACL elicitation prompt. Fine for correctness, poor for review.
- **`read_file` takes no line range.** Deferred rather than faked: the handle contract has no range-aware read, and slicing in the harness would silently read the whole file.
- **`sandboxFileResolver` is text-only.** `SandboxHandle.readFile` returns a `string`, so a binary read through the sandbox degrades to best-effort UTF-8 rather than fabricating a blob. `fsFileResolver` is the lossless path today; a lossless sandbox read needs `readFileBytes` on the handle.
- **`SandboxIntent` has no consumer.** It records what a `<Sandbox>` declared so a future resume can replay it; nothing reads it yet.
- **Convenience error constructors are unexported.** `sandboxExecError`, `sandboxIoError`, and `sandboxPermissionDenied` exist internally but aren't part of the public surface; construct the error classes directly.
- **No static deny for `read` and `write`.** `SandboxACL` gives `exec` both an allow and a deny list but the path kinds only an allow list, so "everything under `/workspace` except `.env`" needs a session-learned `deny-session` reply rather than a declaration.

## Verified by

- `src/__tests__/edit.spec.ts` — `applyEdits` across all three matching strategies and every mode, overlap rejection, CRLF, smart line deletion, and `EditError` diagnostics.
- `src/__tests__/harness.spec.ts` — `editFile` through the harness (indent-adjusted and range modes); `exec` streaming onto the `delta` phase; static ACL including exec deny-over-allow; session-learned ACL snapshot round-trip; the elicitation gate across allow / deny / session-pattern / timeout; dynamic mounts against the `mountAllow` ceiling and capability-tiered `SandboxUnsupportedError`.
- `src/__tests__/net.spec.ts` — `matchDomain` wildcards, first-match-wins ordering, default-deny, per-field predicates.
- `src/react/__tests__/tools.spec.ts` — exactly four model-facing tools, and no mount tool among them.
- `src/react/__tests__/tools-ctx-sandbox.spec.ts` — handlers resolving from `ctx.sandbox`: primary, sole-sandbox fallback, absent-bridge guard, multi-sandbox ambiguity.
- `src/react/__tests__/component.spec.tsx` — `<Sandbox>` and `useSandbox()` against the real compiler.
- `src/mcp/__tests__/roots.spec.ts` — workspace root plus live mounts (add then remove), and `bindSandboxRootsToClient` firing on every change with unsubscribe stopping it.
- `src/mcp/__tests__/file-resolver.spec.ts` — text round-trip through the sandbox, binary degrade, `fsFileResolver` text and base64 blob, root containment, routing through a real resources harness.
- `src/testing/conformance.ts` — the provider contract itself, including the capability-tiered `spawn`: a live `/bin/sh` driven over its control channel mid-run, or an honest `undefined` / `SandboxUnsupportedError` from a provider that has no such surface.
- Provider-side behavior is certified by `runSandboxProviderConformance` in each provider package.
