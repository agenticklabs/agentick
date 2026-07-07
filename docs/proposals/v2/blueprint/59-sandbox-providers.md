# ADR 59 — Sandbox providers: widen the contract, port the real thing, four tools + bash

**Status:** PROPOSED 2026-07-06 (Fable, for Ryan — all forks ruled this session).
**Depends on:** ADR 24 (sandbox-as-harness), the elicitation permission gate.
**Closes/covers:** #157 (docker + local providers), #218 (conformance), #219 (exec
streaming), #221 (handle narrowing), #222 (editFile modes), #225 (setup).
**Defers (with issues):** #223 (hibernate/restore — no-op for now), #220 (diff-preview UX),
secure-exec provider, #226 (Lambda).

## The problem

v2 shipped the sandbox *substrate* (`packages-next/sandbox` — bridge, harness, ACL,
elicitation permission gate, React `<Sandbox>`/tools) but **zero concrete providers**, and
it **narrowed the handle to 4 methods and left three lossy fakes**:
- `editFile` (`harness.ts:549` `applyEditsLocal`) — naive `string.replace`; only
  replace/delete/insert-before/after; no fuzzy matching, no range, non-atomic,
  `expectedHash` ignored. A silent correctness regression from v1's `applyEdits`.
- `stat` (`harness.ts:344`) — reads the file and **fabricates** `{size, kind:"file",
  mtime:Date.now()}`.
- `readdir` (`harness.ts:370`) — `exec("ls -1A")`, labels **every** entry `kind:"file"`.

Fakes are worse than gaps — they lie silently. Porting v1's providers onto this handle
would inherit the fakes. **Widen (and simplify) the contract first.**

## The model-facing tool surface — four tools + bash (Ryan)

The agent gets exactly: **`readFile`, `writeFile`, `editFile`, `bash`** (shell/exec).
Rationale — each earns its place, and `bash` is the universal escape hatch:

- **`bash`** subsumes listing / metadata / search (`ls`, `stat`, `find`, `grep`, git, test
  runners, package installs). ⇒ **The `stat`/`readdir` fakes are DELETED, not rebuilt.** No
  dedicated tool or handle method for them; the model shells out.
- **`readFile`** — structured output + optional line range; beats `cat` (no shell parsing,
  clean "too large" handling).
- **`writeFile`** — arbitrary content without shell-escaping hell.
- **`editFile`** — the one tool that beats `sed`: it carries the **real ported
  `applyEdits`** (v1 `edit.ts`) — layered 3-strategy matching (exact → line-normalized →
  indent-adjusted), the full mode set (replace / delete / insert before|after|start|end /
  **range**), CRLF norm, overlap detection, atomic temp+rename. This is the crown jewel;
  do NOT ship `applyEditsLocal`.

**Mounts become create-time config**, not runtime tools — host mounts are declared at
sandbox creation, dropping `addMount`/`removeMount`/`listMounts` from the model surface.

## The provider contract

```ts
// spec-next — the port target
interface SandboxProvider {
  readonly name: string;
  create(opts: SandboxCreateOptions): Promise<SandboxHandle>;
  restore?(snapshot: SandboxSnapshot): Promise<SandboxHandle>;   // DEFERRED — see below
  destroy?(handle: SandboxHandle): Promise<void>;
}
interface SandboxHandle {                       // un-narrowed, but LEAN (no fakes)
  readonly id: string;
  readonly workspacePath: string;
  exec(cmd: string, opts?: SandboxExecOptions): Promise<ExecResult>;
  readFile(path: string, opts?: { range? }): Promise<...>;
  writeFile(path: string, content: string): Promise<void>;
  editFile(path: string, edits: Edit[]): Promise<...>;   // real applyEdits
  destroy(): Promise<void>;
}
interface SandboxExecOptions {
  cwd?; env?; timeoutMs?; signal?; stdin?;
  onOutput?: (c: { stream: "stdout" | "stderr"; chunk: string }) => void;  // #219 — restored
}
interface SandboxCreateOptions {
  allow?: Permissions;                 // fs/net (see network below)
  mounts?: readonly MountSpec[];       // create-time, not runtime
  setup?: (handle: SandboxHandle) => Promise<void>;   // #225 — post-create bootstrap
}
```

`editFile` remains a **harness command** (ADR 24) but its body calls the **real
`applyEdits`**, not `applyEditsLocal`. `exec` streaming: the harness bridges `onOutput` →
the already-specced `SandboxExecDelta` (`exec:delta`).

## Network firewall — three-layer split (survey, adopted)

1. **Types → `spec-next`**: `NetworkRule`, `ProxiedRequest`, `network: boolean | readonly
   NetworkRule[]` — wire vocabulary any egress-enforcing provider + observability shares.
2. **Pure matcher → a shared `@agentick/sandbox-net-next` helper**: `matchRequest` /
   `matchDomain` (first-match-wins, default-deny, `*.domain` wildcards) — OS-free, reusable
   by docker/remote. (Putting it in `local` would force docker→local — wrong direction.)
3. **The Node proxy server → `sandbox-local-next`**: 127.0.0.1 HTTP proxy + CONNECT tunnel
   (no MITM), `HTTP(S)_PROXY` injection, `ProxiedRequest` audit log. OS-process-bound,
   local-only. **Docker** enforces via `NetworkMode`; a future remote provider its own way.

## Deferred (each gets an issue)

- **Hibernate/restore (#223) — DEFER entirely (Ryan).** No provider has a true checkpoint
  (v1 "restore" just re-attaches the workspace; docker doesn't implement it). Leave
  `restore?`/`SandboxSnapshot` in the contract as an unwired seam with a loud
  `TODO(#223)`; the bridge only calls `create`. True checkpointing waits for a
  remote/CRIU-style provider (the cloud persona #163 pulls it back then).
- **Diff-preview UX (#220) — DEFER (rider).** The tool-executor confirmation seam surfaces
  the pending input but has **no structured `confirmationPreview:{type:"diff"}` slot**;
  ACL-elicitation covers *approval*. Re-adding the diff needs a seam addition — its own
  issue, not this ADR.
- **secure-exec — DEFER.** Validate the contract on local + docker (real exec/fs/net)
  first; port secure-exec after as the capability-tier (no-mounts/no-streaming) test case.

## Packages

`@agentick/sandbox-local-next`, `@agentick/sandbox-docker-next` (implement spec
`SandboxProvider`), `@agentick/sandbox-net-next` (the shared matcher). The harness
`@agentick/sandbox-next` owns bridge/harness/tools and **must not depend on any provider**
(providers → spec only). Full new-package checklist each; `/testing` doubles;
`runSandboxProviderConformance` suite (#218) that every provider passes.

## Scope

**In:** widen the spec handle + `SandboxExecOptions.onOutput` + `SandboxCreateOptions`
(mounts/setup) + network types; port the **real `applyEdits`**; **delete the stat/readdir
fakes** (bash subsumes) + `applyEditsLocal`; `sandbox-local-next` (exec/fs/editFile/network
proxy/setup) + `sandbox-docker-next` (+ `NetworkMode`) + `sandbox-net-next` matcher; the
conformance suite. **Out:** hibernate wiring, diff-preview UX, secure-exec, Lambda.

## Rejected
- **Keep the 4-method handle + the three fakes.** Fakes lie; a `stat` that fabricates
  mtime is worse than none. Delete them; bash covers the model's need.
- **Build "real" `stat`/`readdir` handle methods + tools.** Unnecessary — `bash` is the
  universal escape hatch. Fewer tools, no new surface.
- **`applyEditsLocal` as an MVP editFile.** A silent correctness regression on the highest-
  value tool. Port the real matcher.
- **Runtime `addMount`/`removeMount` tools.** Mounts are create-time config.
