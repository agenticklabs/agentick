# @agentick/sandbox-next

The **sandbox-as-harness** surface (ADR 24, ADR 59). Wraps a live
`SandboxHandle` produced by a `SandboxProvider` in a
`BaseHarness<"sandbox">` — every operation runs through the substrate
phase contract (journaled, observable, inbox-addressable) and passes an
ACL permission gate backed by the session's elicitation harness.

This package owns the **bridge, harness, tools, and the real edit
transform**. It depends on `@agentick/spec-next` only — it does **not**
depend on any provider package. Concrete providers
(`sandbox-local-next`, `sandbox-docker-next`) implement the spec
`SandboxProvider` and are installed separately (ADR 59 Wave 2).

## The model-facing tool surface — four tools + bash

The agent gets exactly four tools; `bash` is the universal escape hatch:

| Tool         | Purpose                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `bash`       | Execute a shell command. Subsumes listing/metadata (`ls`, `stat`, `find`, git, installs). |
| `read_file`  | Read a file (structured output, no shell parsing).                      |
| `write_file` | Write arbitrary content without shell-escaping.                         |
| `edit_file`  | Surgical edits — the one tool that beats `sed` (see **editFile** below). |

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

## Quick start

```tsx
import { withSandbox } from "@agentick/sandbox-next";
import { Sandbox, Bash, ReadFile, WriteFile, EditFile } from "@agentick/sandbox-next/react";

// 1. Install the extension (constructs the bridge on the app substrate).
const app = createApp(Agent, { extensions: [withSandbox()] });

// 2. Mount a sandbox; tools inside see it via useSandbox().
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

| Export                                  | What                                                          |
| --------------------------------------- | ------------------------------------------------------------ |
| `SandboxHarness`                        | `BaseHarness<"sandbox">` — 8 commands (exec/read-file/write-file/edit-file/add-mount/remove-mount/list-mounts/destroy). |
| `withSandbox(options?)`                 | `AppExtension` — constructs the bridge on the app substrate.  |
| `createSandboxBridge` / `inMemorySandboxBridge` | Bridge factory + in-memory test bridge.              |
| `applyEdits(source, edits)` / `EditError` | The pure edit transform + its diagnostic error.            |
| `SessionACL`, `matchesACLPattern`       | Per-session learned allow/deny state + glob matcher.         |
| `/react` subpath                        | `<Sandbox>`, `useSandbox()`, and the `Bash`/`ReadFile`/`WriteFile`/`EditFile` tools. |

## Verified by

- **Real `applyEdits` (all strategies, all modes, overlap, diagnostics)** —
  `src/__tests__/edit.spec.ts`.
- **editFile through the harness (indent-adjusted + range modes)** —
  `src/__tests__/harness.spec.ts` › _write + edit_.
- **exec streaming → `exec` delta phase (#219)** —
  `src/__tests__/harness.spec.ts` › _exec streaming_.
- **ACL gate via elicitation (allow/deny/session-pattern/timeout)** —
  `src/__tests__/harness.spec.ts` › _permission gate_.
- **`<Sandbox>` + `useSandbox()` with the real reconciler** —
  `src/react/__tests__/component.spec.tsx`.

## Roadmap & known gaps

- **Concrete providers (ADR 59 Wave 2)** — `sandbox-local-next` (exec/fs/
  editFile + network proxy/setup), `sandbox-docker-next` (+ `NetworkMode`),
  `sandbox-net-next` (the pure first-match-wins egress matcher), plus a
  `runSandboxProviderConformance` suite every provider passes (#218).
  The network wire types (`NetworkRule`, `ProxiedRequest`) already live in
  spec; the matcher + proxy are Wave 2.
- **`applyEdits` relocation** — providers implement `handle.editFile` and
  need this transform, but depend on spec only and cannot import this
  harness package. Wave 2 relocates `applyEdits` to a shared OS-free
  package (mirroring the `sandbox-net-next` matcher split). Tracked as a
  `TODO(ADR 59, Wave 2)` in `src/edit.ts`.
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
```
