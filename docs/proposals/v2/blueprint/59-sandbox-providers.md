# ADR 59 — Sandbox providers: widen the contract, port the real thing, four tools + bash

**Status:** PROPOSED 2026-07-06 (Fable, for Ryan — all forks ruled this session).
**Depends on:** ADR 24 (sandbox-as-harness), the elicitation permission gate.
**Closes/covers:** #157 (docker + local providers), #218 (conformance), #219 (exec
streaming), #221 (handle narrowing), #222 (editFile modes), #225 (setup).
**Defers (with issues):** #223 (hibernate/restore — no-op for now), #220 (diff-preview UX),
secure-exec provider, #226 (Lambda).

## The problem

v2 shipped the sandbox *substrate* (`packages/sandbox` — bridge, harness, ACL,
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
2. **Pure matcher → a shared `@agentick/sandbox-net` helper**: `matchRequest` /
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

`@agentick/sandbox-local`, `@agentick/sandbox-docker` (implement spec
`SandboxProvider`), `@agentick/sandbox-net` (the shared matcher). The harness
`@agentick/sandbox` owns bridge/harness/tools and **must not depend on any provider**
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

## Amendment 2026-07-06 — mounts are dynamic (allow-list gated), not create-time-only

The body above said "mounts become create-time config, drop addMount/removeMount/listMounts."
**Corrected (Ryan): mounts are a DYNAMIC harness capability, gated by a construction-time
allow-list.** Rationale: mounting a host dir is a **host-side privileged operation the
sandboxed process cannot perform from inside** — so `bash` does NOT subsume it (unlike
`stat`/`readdir`, which it does; those stay deleted). Mounts genuinely need a harness
command.

- **Handle:** `addMount?` / `removeMount?` / `listMounts?` are **optional, capability-tiered**
  methods (feature-detect; a provider that can't do runtime mounts — e.g. docker on a
  running container — throws `SandboxUnsupportedError`, never fakes). `local` implements
  them; `docker` may not.
- **Harness commands:** add/remove/list-mount are harness commands (peers of exec/readFile)
  — dynamic at runtime, reachable programmatically / via dispatch.
- **NOT model tools.** The model surface stays `readFile`/`writeFile`/`editFile`/`bash`.
  Mounting host paths is a privilege boundary the model must not cross.
- **Allow-list ceiling.** `SandboxCreateOptions` carries a construction-time mount
  **allow-list** (host paths that MAY be mounted); create-time `mounts` is the initial
  subset; runtime `addMount` is constrained to the allow-list. Same ceiling-plus-dynamic
  shape as session `requiredScopes` + downscoping.

This SUPERSEDES the "create-time config" framing and the "Runtime addMount/removeMount
tools" rejection above (rejected as *model tools*; correct as *harness commands*).

## Amendment 2026-07-07 — packaging correction: providers dep the BASE (`sandbox-next`), mirror `model-next`

**AUTHORITATIVE.** This supersedes the earlier "Packages" section and its `sandbox-edit`/
`sandbox-net`/`spec-only-provider` structure. That structure deviated from our own grain and
is being cleaned up by hand.

### How we deviated (so it doesn't recur)
A locally-reasonable chain drifted, unchecked against precedent: `SandboxHandle` correctly
belongs in spec (it's the reconciler↔harness **bridge** type — `reconciler-react` references
it without depending on the harness, same firewall reason as `HookBridges`). From there:
"handle in spec" → "the whole provider contract in spec" → "providers dep **spec-only**, not
the harness" → "providers still need `applyEdits`/matcher, which the spec-only rule forbids
sourcing from the harness → invent `sandbox-edit`/`sandbox-net` shared packages." Each step
looked fine; the chain landed against the grain. **Root cause: the packaging was derived
from first principles instead of mirrored from the nearest existing subsystem (the model
layer).** The rule: when packaging a subsystem, copy the closest precedent's shape first,
then justify any divergence — don't re-derive.

### The grain (model layer, the mirror)
`@agentick/model-openai` **deps** `@agentick/model`. The `LanguageModelAdapter`
contract + shared code live in `model-next` (the base), NOT spec. Sandbox mirrors this
exactly.

### Target topology + dep graph
```
spec-next            SandboxHandle, SandboxBridge, Sandbox{Exec,Edit,Mount,Create,Snapshot} wire types,
   ↑                 NetworkRule, ProxiedRequest, sandbox error tags.  ← reconciler-react reaches THESE; never the harness.
sandbox-next  BASE   harness + bridge impl + ACL  ·  the SandboxProvider CONTRACT  ·
   ↑                 applyEdits + EditError  ·  matchRequest/matchDomain  ·
   │                 React <Sandbox>/tools → `sandbox-next/react` subpath  ·  conformance + fakeProvider → `/testing`
sandbox-local-next   provider — deps `sandbox-next`, implements SandboxProvider   (⟂ model-openai-next → model-next)
sandbox-docker-next  provider — deps `sandbox-next`   (Wave 2b)
```

### Moves (exhaustive)
1. `SandboxProvider` interface: **spec → `sandbox-next`** (server-side factory, not a wire type; reconciler never constructs it). Everything else in `spec/data/sandbox.ts` STAYS (handle/bridge/exec/edit/mount/create/snapshot/network/errors).
2. `applyEdits` + `EditError`: `sandbox-edit` → `sandbox-next/src/edit.ts`. **Delete `sandbox-edit`.**
3. `matchRequest`/`matchDomain`: `sandbox-net` → `sandbox-next/src/net.ts`. **Delete `sandbox-net`.** (`NetworkRule`/`ProxiedRequest` types stay in spec.)
4. `runSandboxProviderConformance` + `fakeSandboxProvider`: → **`sandbox-next/testing`** (conformance + double live with the contract). Remove the sandbox suite from `spec-conformance-next`.
5. `sandbox-local-next`: dep `spec-only` → **`@agentick/sandbox`**; repoint imports (`sandbox-next` re-exports the spec wire types so providers have one import source).
6. `sandbox-next` main entry **React-free**: move the stray React ref + `react/tools.tsx` + `<Sandbox>` behind the **`sandbox-next/react`** subpath.

### Invariants (green checks)
- `sandbox-local-next/package.json` deps `@agentick/sandbox` — not `-edit`/`-net`, not spec-only.
- `sandbox-edit` + `sandbox-net` gone everywhere (dirs, lockfile, `website/typedoc.json`, `config.mts`).
- `sandbox-next` main entry imports zero React (React only via `/react`).
- `reconciler-react` still deps only spec for the sandbox bridge — unchanged.
- No cycle: `sandbox-next` deps no provider. Fresh typecheck + vitest + lint green.

### Principle (one line)
Provider contract + shared code in the **base**; concrete impls dep the base; **spec holds only firewall wire/bridge types**; conformance + doubles ship with the contract. OS isolation (seatbelt/bwrap/unshare/cgroup, #240) is a separate FUNCTIONAL gap in `sandbox-local`, independent of this repackaging.

## Amendment 2026-07-07 (2) — CORRECTION: `SandboxHandle` is NOT a wire type; it moves to the base too

The (1) amendment kept `SandboxHandle` in spec on the claim that the reconciler bridge
references it. **That claim is false** (verified): `SandboxBridge` registers
`Map<string, SandboxHarness>` — *harnesses*, not handles — and `reconciler-react`
references `SandboxHandle` **zero** times. The handle is a live, non-serializable object
(fds/container id/workspace) consumed only server-side by the harness that wraps it 1:1.

**What `SandboxHandle` is:** the provider's live created-instance. `SandboxProvider`
(factory) → `create()` → `SandboxHandle` (instance) → `SandboxHarness` (wraps one handle +
substrate + ACL + addressability). The harness commands are a 1:1 delegating mirror of the
handle methods (raw capability vs governed sandbox). The handle is real and needed, but it
is the **provider↔harness internal contract**, not a wire/bridge type.

**Corrected spec ↔ base split — the test is "is it serialized across the inbox/wire?":**
- **`spec-next` keeps ONLY the serialized shapes:** the harness command payloads/results
  (the inbox-addressable data — `SandboxExec*`/`SandboxEdit*`/mount inputs/results),
  `NetworkRule`, `ProxiedRequest`, the sandbox error tags. (Note: `onOutput`/`signal` on
  exec are runtime-only; the *serialized* command input is their subset.)
- **`sandbox-next` (base) holds the CONSTRUCTION contracts + live-object interfaces:**
  `SandboxProvider`, **`SandboxHandle`**, `SandboxCreateOptions`, `SandboxSnapshot`, plus
  the harness/bridge impl, `applyEdits`, the net matcher. `SandboxBridge` is already here.
- Providers dep `sandbox-next`, implement `SandboxProvider`, return a `SandboxHandle`.

This SUPERSEDES amendment (1)'s "`SandboxHandle` stays in spec." Everything else in (1)
stands (providers dep the base; delete sandbox-edit/net; React in `/react`; conformance +
fake in `sandbox-next/testing`).
