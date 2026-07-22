# @agentick/sandbox-next

The **BASE sandbox package** (ADR 24, ADR 59). Wraps a live
`SandboxHandle` produced by a `SandboxProvider` in a
`BaseHarness<"sandbox">` — every operation runs through the substrate
phase contract (journaled, observable, inbox-addressable) and passes an
ACL permission gate backed by the session's elicitation harness.

This package owns:

- the **bridge + harness + ACL**;
- the **`SandboxProvider` construction contract** + the **`SandboxHandle`**
  live-object interface (`src/contract.ts`) — the provider↔harness
  internal contracts (NOT wire types; those stay in `spec-next`);
- the **crown-jewel `applyEdits`** transform (`src/edit.ts`) and the
  **pure egress matcher** `matchRequest`/`matchDomain` (`src/net.ts`);
- a **`/react` subpath** (React-only bindings) and a **`/testing`
  subpath** (the `runSandboxProviderConformance` suite + the in-memory
  `fakeSandboxProvider`).

The main entry is **React-free**. It re-exports the spec sandbox wire
types alongside its own contracts, so a provider has **one import
source**.

It depends on `@agentick/spec-next` only — **not** on any provider.
Concrete providers (`sandbox-local-next`, `sandbox-docker-next`) **dep
this base** and implement `SandboxProvider`, mirroring
`model-openai-next → model-next` (ADR 59). They are installed
separately.

## The model-facing tool surface — four tools + bash

The agent gets exactly four tools; `bash` is the universal escape hatch:

| Tool         | Purpose                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| `bash`       | Execute a shell command. Subsumes listing/metadata (`ls`, `stat`, `find`, git, installs). |
| `read_file`  | Read a file (structured output, no shell parsing).                                        |
| `write_file` | Write arbitrary content without shell-escaping.                                           |
| `edit_file`  | Surgical edits — the one tool that beats `sed` (see **editFile** below).                  |

There is **no `stat` / `readdir` tool or handle method**. `bash` covers
the model's need, and a fabricated `stat` (v1's harness returned a
`Date.now()` mtime; `readdir` labelled every entry `"file"`) is worse
than none — a lying primitive (ADR 59).

## Mounts — dynamic harness commands, not model tools

Mounting a host directory is a **host-side privileged op** the sandboxed
process cannot perform through `bash` (unlike stat/readdir, which it
can). So mounts get real harness commands — `add-mount` / `remove-mount`
/ `list-mounts` — reachable programmatically or via `dispatch`, but
**never exposed as model-facing tools** (a privilege boundary the model
must not cross).

- **Capability-tiered handle methods** (`addMount?` / `removeMount?` /
  `listMounts?`): a provider that can't remount a running instance
  leaves them `undefined` / throws `SandboxUnsupportedError` — never
  fakes. The harness feature-detects and surfaces the error.
- **Allow-list ceiling** (`SandboxCreateOptions.mountAllow`): the
  host-path patterns that MAY be mounted at runtime. `add-mount` rejects
  any path outside it with `SandboxPermissionDeniedError { kind: "mount" }`;
  `undefined` denies runtime mounting entirely (default-deny). Create-time
  `mounts` are the operator's explicit initial authorization and are
  honored regardless. Same ceiling-plus-dynamic shape as session
  `requiredScopes` + downscoping.
- **`subscribeMounts(listener)`**: a mount-topology change stream (fires
  after a successful `add-mount` / `remove-mount`), mirroring
  `ResourcesHarness.subscribeListChanged`. The `/mcp` adapter binds to it
  for live roots sync.

## The `/mcp` subpath — sandbox ↔ MCP roots + readable files (ADR 65)

An **opt-in** adapter (`@agentick/sandbox-next/mcp`, deps
`@agentick/mcp-next` + `@agentick/resources-next`) that projects a sandbox
onto two MCP surfaces. It is a **projection composed over existing
primitives**, not a new harness (ADR 65): mount state stays owned by the
sandbox, reads stay owned by resources, and the MCP client core stays
decoupled from the sandbox (the dep points sandbox → mcp, one direction,
no cycle — mirroring the `/react` convention).

**Roots is pluggable — the sandbox is the flagship source, never a
prerequisite.** Roots also work standalone from a static list or a plain
provider fn with no sandbox in the graph (proved in
`@agentick/mcp-next`).

```ts
import {
  sandboxRootsSource,
  bindSandboxRootsToClient,
  sandboxFileResolver,
  registerFileResolver,
} from "@agentick/sandbox-next/mcp";

// Outbound: offer the sandbox's workspace + live mounts as file:// roots
// to a remote server, and keep them in sync on every mount change.
const client = /* an McpClientHarness configured with: */ { roots: sandboxRootsSource(sandbox) };
const stop = bindSandboxRootsToClient(sandbox, clientHarness); // → notifyRootsListChanged on change

// Read: expose mounted files as readable resources (file://{+path}).
registerFileResolver(resources, sandboxFileResolver(sandbox));
```

- `sandboxRootsSource(sandbox)` — an `McpRootsSource` provider fn:
  `workspacePath` + `listMounts()` → `file://` roots, re-evaluated per
  `roots/list` (reflects live mounts). Degrades to workspace-only when a
  provider lacks `listMounts`.
- `bindSandboxRootsToClient(sandbox, client)` — subscribes to mount
  changes and fires the client's `notifyRootsListChanged()` (fire-and-
  forget). Returns an `Unsubscribe`.
- `sandboxFileResolver(sandbox)` / `fsFileResolver(rootDir)` — `file://`
  `TemplateResolver`s. The sandbox path reads through the ACL-gated
  `read-file` command (text, per the handle contract); the fs path is the
  no-sandbox backend (lossless text + base64-blob binary, root-contained).
- The **inbound** direction (a connecting client's roots on
  `ctx.mcp.clientRoots`) needs no sandbox and lives in
  `@agentick/mcp-next`'s server harness.

## Quick start

```tsx
import { withSandbox } from "@agentick/sandbox-next";
import { Sandbox, Bash, ReadFile, WriteFile, EditFile } from "@agentick/sandbox-next/react";

// 1. Install the extension (constructs the bridge on the app substrate).
const app = createApp(Agent, { extensions: [withSandbox()] });

// 2. Mount a sandbox. The built-in tool handlers resolve it at dispatch
//    from `ctx.sandbox` (ADR 66); `<Sandbox>` also provides it to
//    descendants for render-time `useSandbox()`.
function Agent() {
  return (
    <Sandbox provider={myProvider} allow={{ read: ["/workspace/**"], exec: { allow: ["git *"] } }}>
      <Bash />
      <ReadFile />
      <WriteFile />
      <EditFile />
    </Sandbox>
  );
}
```

## Handler access — `ctx.sandbox` vs `useSandbox()` (ADR 66)

There are two ways to reach the sandbox, and they resolve at different
times:

- **`ctx.sandbox` — dispatch-time (tool handlers).** The tool executor
  surfaces the app-scoped `SandboxBridge` on `ctx.sandbox` (a typed slot
  contributed by this package's module augmentation of
  `ToolHandlerCtxExtensions`). It is **dispatch-resolved from the live
  bridge** — never captured at render — so reads always reflect current
  harness state. The built-in tools use it:

  ```ts
  async handler({ command }, { ctx }) {
    const sandbox = ctx.sandbox?.get("primary"); // the default <Sandbox> id
    if (!sandbox) return [{ type: "text", text: "Error: no sandbox available in scope" }];
    const { stdout } = await sandbox.exec({ command });
    return [{ type: "text", text: stdout }];
  }
  ```

  `ctx.sandbox` is `undefined` when `withSandbox()` isn't installed, so
  handlers guard. It carries the SAME bridge as `useBridges().sandbox`.
  The built-in `Bash`/`ReadFile`/`WriteFile`/`EditFile` tools target the
  default `<Sandbox id="primary">` and fall back to the sole registered
  sandbox when exactly one exists. Cross-section routing among multiple
  sandboxes: query the bridge by id (`ctx.sandbox?.get(myId)`).

- **`useSandbox()` — render-time (components).** The React hook reads the
  tree-nearest `<Sandbox>` harness from Context. Use it inside components
  and in custom tools that genuinely need **tree-positional** selection
  (a specific harness by tree position) captured via a `use:` slot. This
  is the escape hatch reserved for tree-positional context; everything
  app-scoped belongs on `ctx.sandbox`.

The tool executor and app harness thread `ctx.sandbox` **generically** —
they never import this package. The type comes from the augmentation
here; the value is an opaque record filled by the AppHarness from the
registered `sandbox` namespace. That keeps the dependency graph clean:
`@agentick/tool-executor-next` and `@agentick/app-next` have no sandbox
dependency.

## editFile — the crown jewel

`edit_file` carries the **real ported `applyEdits`** (from v1
`@agentick/sandbox/edit.ts`), exported here as `applyEdits`:

- **Layered 3-strategy matching** — exact → line-normalized (trailing
  whitespace) → indent-adjusted (LLM supplies unindented code; the
  matcher recovers it and re-indents the replacement).
- **Full mode set** (detected by field presence, not a discriminator):
  `replace`, `delete`, insert `before`/`after`/`start`/`end`, and
  `range` (replace the block between two markers, inclusive).
- **CRLF normalization**, **smart-line-deletion** (consumes the trailing
  newline of a deleted whole line), **overlap detection** across a
  multi-edit batch, and **rich diagnostics** (`EditError` carries the
  closest partial match + line + context so the model can self-correct).

The `SandboxHarness.editFile` command runs the ACL check, then delegates
to `handle.editFile` — the handle owns edit truth and **atomicity**
(temp + rename); the transform itself is pure and OS-free.

## Streaming exec output (#219)

`SandboxExecOptions.onOutput` is the provider streaming seam. The harness
injects a callback on every `exec` and bridges each chunk onto the
`sandbox:command:exec` `delta` phase (`SandboxExecDelta`), so
`app.events({ surface: "sandbox", phase: "delta" })` subscribers (devtools,
telemetry, custom UIs) tail stdout/stderr live. Providers that can't
stream simply never call it — the final `SandboxExecResult` remains
authoritative.

## Post-create setup (#225)

`SandboxCreateOptions.setup(handle)` runs once after the provider
produces the handle and before the sandbox is marked ready — clone a
repo, install deps, seed fixtures. The **bridge/factory** (not the
provider) invokes it, so it works uniformly across every provider.

## API

| Export                                                       | What                                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SandboxProvider` / `SandboxHandle`                          | The construction contract + live-object interface providers implement/return (`src/contract.ts`).                                                       |
| `SandboxCreateOptions` / `SandboxSnapshot` / `SandboxIntent` | Provider create-options + the (deferred #223) snapshot seam.                                                                                            |
| `SandboxHarness`                                             | `BaseHarness<"sandbox">` — 8 commands (exec/read-file/write-file/edit-file/add-mount/remove-mount/list-mounts/destroy).                                 |
| `withSandbox(options?)`                                      | `AppExtension` — constructs the bridge on the app substrate.                                                                                            |
| `inMemorySandboxBridge`                                      | In-memory bridge for tests.                                                                                                                             |
| `applyEdits(source, edits)` / `EditError`                    | The pure edit transform + its diagnostic error.                                                                                                         |
| `matchRequest` / `matchDomain`                               | The pure first-match-wins egress matcher (default-deny, `*.domain` wildcards).                                                                          |
| `SessionACL`, `matchesACLPattern`                            | Per-session learned allow/deny state + the glob / `regex:` pattern matcher.                                                                             |
| Spec wire types (re-exported)                                | `SandboxExec*`/`SandboxEdit*`/mount inputs, `SandboxPermissions`, `NetworkRule`, `ProxiedRequest` — one import source for providers.                    |
| `/react` subpath                                             | `<Sandbox>`, `useSandbox()` (render-time), and the `Bash`/`ReadFile`/`WriteFile`/`EditFile` tools (handlers resolve `ctx.sandbox`, ADR 66).             |
| `/testing` subpath                                           | `runSandboxProviderConformance` (#218) + `fakeSandboxProvider`.                                                                                         |
| `/mcp` subpath (ADR 65)                                      | `sandboxRootsSource` / `bindSandboxRootsToClient` (outbound roots), `sandboxFileResolver` / `fsFileResolver` / `registerFileResolver` (readable files). |

## Verified by

- **Real `applyEdits` (all strategies, all modes, overlap, diagnostics)** —
  `src/__tests__/edit.spec.ts`.
- **editFile through the harness (indent-adjusted + range modes)** —
  `src/__tests__/harness.spec.ts` › _write + edit_.
- **exec streaming → `exec` delta phase (#219)** —
  `src/__tests__/harness.spec.ts` › _exec streaming_.
- **Static ACL (allow/deny, exec deny wins) + session-learned snapshot round-trip** —
  `src/__tests__/harness.spec.ts` › _static ACL_ / _session-learned ACL via snapshot import_.
- **ACL gate via elicitation (allow/deny/session-pattern/timeout)** —
  `src/__tests__/harness.spec.ts` › _permission gate_.
- **Dynamic mounts — allow-list ceiling gate + capability-tiered `SandboxUnsupportedError`** —
  `src/__tests__/harness.spec.ts` › _dynamic mounts_.
- **Four-tool model surface (exactly `bash`/`read_file`/`write_file`/`edit_file`, no mount tools)** —
  `src/react/__tests__/tools.spec.ts`.
- **Pure egress matcher (`matchDomain` wildcards, first-match-wins, default-deny, per-field predicates)** —
  `src/__tests__/net.spec.ts`.
- **`<Sandbox>` + `useSandbox()` with the real compiler** —
  `src/react/__tests__/component.spec.tsx`.
- **Built-in tools resolve the harness from `ctx.sandbox` (ADR 66) —
  primary/sole resolution, absent-guard, multi-sandbox ambiguity** —
  `src/react/__tests__/tools-ctx-sandbox.spec.ts`.
- **`/mcp` outbound roots — workspace root + live mounts (add → present,
  remove → gone) + `bindSandboxRootsToClient` fires on every change
  (fire-and-forget, unsubscribe stops it)** —
  `src/mcp/__tests__/roots.spec.ts`.
- **`/mcp` file-resolver — text round-trip through the sandbox, binary
  degrade, fs text + base64-blob binary, root-containment, routing through
  a real `ResourcesHarness`** — `src/mcp/__tests__/file-resolver.spec.ts`.

## Roadmap & known gaps

- **`sandbox-docker-next` provider** — deps this base (like
  `sandbox-local-next`), enforces egress via `NetworkMode`, and runs
  `runSandboxProviderConformance` from `/testing`. Not yet shipped.
- **OS isolation in `sandbox-local` (#240)** — the reference provider
  confines the FILE API by path resolution and routes egress through the
  proxy, but `exec` runs as an ordinary child process (no
  seatbelt/bwrap/namespace jail). Porting v1's isolation executor
  strategies is a separate FUNCTIONAL gap in the provider, independent of
  this packaging.
- **Hibernate / restore (#223)** — `SandboxProvider.restore` +
  `SandboxSnapshot` are an unwired contract seam; the bridge only calls
  `create`. No provider has a true checkpoint yet.
- **Diff-preview UX (#220)** — `edit_file` exposes no structured
  `confirmationPreview: { type: "diff" }`; the tool-executor confirmation
  seam lacks a diff slot. ACL-elicitation covers approval meanwhile.
- **`read_file` line range** — the ADR notes an optional line range;
  deferred to avoid a fake until the handle grows a range-aware read.
- **secure-exec provider** — deferred; validate the contract on local +
  docker first, then port secure-exec as the capability-tier test case.
- **`/mcp` `sandboxFileResolver` is text-only** — the sandbox handle
  exposes only `readFile(): string` (ADR 59: `bash` subsumes binary), so
  a binary file read through the sandbox degrades to best-effort UTF-8
  text (never a fabricated blob). A lossless binary read needs a
  `readFileBytes` on the handle contract
  (`TODO(#237-4b / ADR-65)` in `src/mcp/file-resolver.ts`); the
  `fsFileResolver` path is the lossless-binary backend today.
