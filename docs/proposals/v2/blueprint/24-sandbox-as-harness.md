# ADR 24 — Sandbox as Harness (per instance)

**Status:** Proposed — 2026-05-20
**Touches:** `@agentick/sandbox` (rework on feat/v2), `@agentick/spec-next/data/sandbox.ts` (already landed in cbb49b6b), provider packages (`@agentick/sandbox-local`, `sandbox-docker`, `sandbox-secure-exec`), `HookBridges` extensibility (ADR 22).
**Driver:** Sandbox operations (shell exec, file IO) are security-critical and benefit from the same audit / observability / middleware story MCP gets. Lock in the harness shape before implementing.

## Decision

**Each sandbox instance is a full `BaseHarness<"sandbox">`.** Not a handle. Not a passive object with methods. A real substrate citizen with commands, events, lifecycle, middleware, and an inbox.

The `SandboxBridge` is a **registry of sandbox harnesses**, not raw handles.

This revises the position I took in ADR 22 (sandbox-as-handle, not harness). Reconsidering with v2 substrate eyes: every argument that made MCP a harness applies equally to sandbox.

## Why this shape

| Criterion                  | Sandbox per instance                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Stateful across calls      | Workspace path, mounted volumes, env, possibly persistent shell session                                    |
| Lifecycle                  | creating → ready → degraded / failed → destroyed                                                           |
| Substrate-bound operations | **Every exec / file op is a journaled operation — critical for audit**                                     |
| Streaming events           | `exec` streams stdout/stderr as delta envelopes                                                            |
| Receives inbox messages    | `abort-exec`, `destroy`, runtime mount changes from external orchestrators                                 |
| Around-style middleware    | Auth (allowed commands), audit (log every exec), sandbox escape detection, rate limit, golden test capture |
| Multi-instance             | One sandbox per `<Sandbox>` mount; multiple sandboxes per app                                              |

**The audit story is the load-bearing one.** A tool that calls `sandbox.exec("rm -rf /")` produces two journaled operations:

- `tool:command:dispatch:requested ... :terminal` — the agent's tool dispatch
- `sandbox:command:exec:requested ... :delta (stdout) ... :terminal` — the underlying exec

Both visible on `app.events()`. Both filterable by surface. Adopters running security-sensitive agents want this. Treating sandbox as a passive handle leaves it on the floor.

## Surface

Three command groups: **filesystem operations**, **execution**, and **lifecycle / mount management**.

### Commands

```ts
interface SandboxHarnessProtocol {
  // ──────────────── Execution ────────────────

  /**
   * Run a shell command. Stdout/stderr stream as delta envelopes
   * (`sandbox:command:exec:delta` with `{ stream: "stdout"|"stderr", chunk }`).
   * The terminal envelope carries the final exit code + accumulated buffers
   * for adopters who don't subscribe to the delta stream.
   *
   * Cancellation: fiber interruption sends SIGTERM (then SIGKILL after
   * the grace period). Adopters compose `Effect.timeout` for hard caps.
   */
  exec(input: SandboxExecInput): Effect<SandboxExecResult, SandboxExecError, never>;

  // ──────────────── Filesystem ────────────────

  /** Read a file from the sandbox workspace. */
  readFile(input: SandboxReadFileInput): Effect<string, SandboxIoError, never>;

  /** Write a file to the sandbox workspace. Atomic. */
  writeFile(input: SandboxWriteFileInput): Effect<void, SandboxIoError, never>;

  /**
   * Surgical edits to a file. Atomic — either all edits apply or none
   * (preserves v1's `applyEdits` semantics). The edit set carries
   * `find/replace` pairs, optional `expectedHash` for optimistic
   * concurrency.
   */
  editFile(input: SandboxEditFileInput): Effect<SandboxEditResult, SandboxIoError, never>;

  /** Stat a path; returns size, mtime, kind. */
  stat(input: SandboxStatInput): Effect<SandboxStat, SandboxIoError, never>;

  /** List directory contents. */
  readdir(input: SandboxReaddirInput): Effect<readonly SandboxDirEntry[], SandboxIoError, never>;

  // ──────────────── Lifecycle / mounts ────────────────

  /** Add a filesystem mount at runtime. Takes effect immediately. */
  addMount(input: SandboxMount): Effect<void, SandboxMountError, never>;

  /** Remove a mount by host path. Idempotent. */
  removeMount(input: { readonly hostPath: string }): Effect<void, never, never>;

  /** Current mounts. */
  listMounts(): Effect<readonly SandboxMount[], never, never>;

  /** Tear down the sandbox. Releases provider resources. Idempotent. */
  destroy(): Effect<void, never, never>;
}
```

Every command is a journaled operation:

- `sandbox:command:exec:requested / :before / :delta (stdout/stderr) / :terminal`
- `sandbox:command:read-file:requested / :before / :terminal`
- `sandbox:command:write-file:requested / :before / :terminal`
- `sandbox:command:edit-file:requested / :before / :terminal`
- `sandbox:command:stat:requested / :before / :terminal`
- `sandbox:command:readdir:requested / :before / :terminal`
- `sandbox:command:add-mount:requested / :before / :terminal`
- `sandbox:command:remove-mount:requested / :before / :terminal`
- `sandbox:command:list-mounts:requested / :before / :terminal`
- `sandbox:command:destroy:requested / :before / :terminal`

### Events (bus)

In addition to per-command envelopes:

```
sandbox:status:creating         sandbox:status:ready
sandbox:status:degraded         sandbox:status:failed
sandbox:status:destroyed
sandbox:mount:added             sandbox:mount:removed
sandbox:resource:limit-exceeded
sandbox:security:escape-attempt
sandbox:permission:requested    sandbox:permission:granted
sandbox:permission:denied
```

The `permission:*` events let observability adopters track which ACL
decisions are happening, what's getting auto-allowed by the policy,
and what's being denied. Combined with `app.events({ surface: "sandbox" })`,
this is enough for a security review dashboard.

`degraded` is when the provider reports the sandbox is alive but
something's wrong (low disk, soft memory limit hit). Adopters can
react by destroying + recreating.

### Lifecycle handlers

```ts
// Lifecycle
sandbox.onCreate((handle: SandboxHandle) => …);
sandbox.onDestroy((reason: SandboxDestroyReason) => …);
sandbox.onDegraded((reason: SandboxDegradedReason) => …);

// Execution
sandbox.onExecError((err: SandboxExecError) => …);
sandbox.onSignal((info: { command: string; signal: NodeJS.Signals }) => …);

// Security / resource limits
sandbox.onSandboxEscape((attempt: SandboxEscapeAttempt) => …);
sandbox.onResourceLimit((kind: SandboxResourceLimitKind, value: number) => …);

// Mount changes
sandbox.onMountAdded((mount: SandboxMount) => …);
sandbox.onMountRemoved((hostPath: string) => …);
```

`onSandboxEscape` is the security hook adopters wire to their incident
pipeline. Default impl logs + emits the event; advanced adopters call
out to PagerDuty / Datadog / etc.

### Middleware

```ts
sandbox.use({
  aroundExec: (input, next) => …,           // auth, rate limit, audit, golden capture
  aroundReadFile: (input, next) => …,        // path allowlist, secrets redaction
  aroundWriteFile: (input, next) => …,       // path allowlist, virus scan
  aroundEditFile: (input, next) => …,
  aroundAddMount: (input, next) => …,        // mount path policy
});
```

`aroundExec` is the high-leverage one. Adopters ship:

- **Command allowlist** — reject any exec not matching a regex set.
- **Audit forwarder** — every exec gets shipped to a SIEM.
- **Replay capture** — record stdin/stdout/exit for golden tests.
- **Rate limit** — max N execs per minute.
- **Dry-run mode** — skip exec, return a sentinel result. Useful for cost-bound test runs.

### Inbox — external commands

```
abort-exec       { commandId: string }       // abort an in-flight exec
destroy          { reason?: string }         // external teardown
mount-add        { mount: SandboxMount }     // dynamic mount injection
mount-remove     { hostPath: string }
status-probe     {}                          // request health, get reply on bus
```

External orchestrators (CI runners, orchestration platforms) talk to
the sandbox via inbox messages. Same pattern as other harnesses.

### Access control (ACL) — configured + per-session learned

Sandbox operations have a two-tier permission model:

1. **Static config** in `<Sandbox allow={...}>` — paths / commands the
   agent is always allowed to touch without asking.
2. **Per-session learned** — when the agent tries to read / write /
   exec something outside the static allowlist, the harness pauses on
   `this.request("sandbox_permission", payload)` and the session
   surfaces the prompt to the user (or to a configured policy
   callback). The decision is remembered for the rest of the session.

```ts
interface SandboxACL {
  /** Always-allowed read paths. Globs and absolute paths. */
  readonly read?: readonly string[];
  /** Always-allowed write paths. Globs and absolute paths. */
  readonly write?: readonly string[];
  /** Always-allowed exec patterns. */
  readonly exec?: {
    readonly allow?: readonly string[]; // regex or command-prefix patterns
    readonly deny?: readonly string[]; // takes precedence over allow
  };
  /** Network policy (handled by provider, not the ACL flow). */
  readonly network?: boolean;
}
```

When the agent calls `sandbox.exec({ command: "git status" })` and
`git` matches `allow.exec.allow`, the operation proceeds without
prompting. When it calls `sandbox.exec({ command: "rm -rf /tmp" })`
and `rm` isn't allowed, the harness issues:

```ts
const decision =
  yield *
  this.request<SandboxPermissionRequest, SandboxPermissionResponse>("sandbox_permission", {
    kind: "exec",
    command: "rm -rf /tmp",
    sandboxId: this.scopeId,
    rationale: "command not in allow.exec.allow",
  });
```

The response carries one of:

```ts
type SandboxPermissionResponse =
  | { decision: "allow-once" } // proceed; don't remember
  | { decision: "allow-session" } // proceed; remember for this session
  | { decision: "allow-session-pattern"; pattern: string } // remember a pattern (e.g., "git *")
  | { decision: "deny" } // throw SandboxPermissionDeniedError
  | { decision: "deny-session" }; // throw + remember to refuse silently
```

Same call shape for `readFile` (`kind: "read", path: ...`),
`writeFile` (`kind: "write", path: ...`), `editFile` (`kind: "write"`),
`addMount` (`kind: "mount", hostPath: ..., sandboxPath: ...`).

`stat` and `readdir` typically piggyback on read permissions but
adopters can configure stricter granularity if needed.

**Per-session ACL state** lives on the harness itself (kept in
StateBridge if it survives hibernation; otherwise in-memory only).
Operations check the learned list before raising the prompt:

```ts
function isAllowed(harness, kind, target): boolean {
  // 1. Static config (from <Sandbox allow={...}>)
  if (matchesStaticAllow(harness.acl, kind, target)) return true;
  // 2. Session-learned allows
  if (harness.sessionAllows.matches(kind, target)) return true;
  // 3. Session-learned denies (silent refusal)
  if (harness.sessionDenies.matches(kind, target)) return false; // throw immediately
  // 4. Otherwise → request permission
  return null; // pending decision
}
```

The prompt itself is surfaced by the session via the request/response
inbox primitive. The session can route it to:

- A console TUI prompt (`@agentick/tui` ships a default UI)
- A web modal (gateway-mediated, when the gateway lands)
- A configured policy callback for headless / CI use:

  ```ts
  withSandbox({
    policy: async (request) => {
      // Auto-allow shell commands matching a corporate allowlist
      if (request.kind === "exec" && CORP_ALLOWED.test(request.command)) {
        return { decision: "allow-session-pattern", pattern: request.command };
      }
      // Otherwise deny silently
      return { decision: "deny" };
    },
  });
  ```

If no policy callback is registered AND the request times out, the
harness throws `SandboxPermissionDeniedError` with `cause: "timeout"`.

**Cross-session persistence is out of scope** for v1 of the harness.
A keychain-style permission store (`SandboxPermissionStore`) is a
future addition; for now decisions are session-scoped only.

### Auth / credentials

Some providers need credentials (remote sandbox APIs, e2b, Modal,
etc.). Pluggable interface mirroring `MCPAuthStorage`:

```ts
interface SandboxCredentialStorage {
  get(providerName: string): Promise<SandboxCredentials | undefined>;
  set(providerName: string, credentials: SandboxCredentials): Promise<void>;
  clear(providerName: string): Promise<void>;
}
```

Local / docker / secure-exec providers don't need credentials. Remote
providers fetch from the storage during `create()`. Default impl is
in-memory; durable impls bind to keychain / secrets manager.

## Providers stay separate

Provider packages (`@agentick/sandbox-local`, `sandbox-docker`,
`sandbox-secure-exec`, future `sandbox-e2b` / `sandbox-modal`)
implement the agnostic `SandboxProvider` interface in spec. The
harness wraps the provider — providers don't know about the harness
substrate.

Provider responsibility:

- `create(options): Promise<SandboxHandle>` — spin up the underlying resource
- `restore?(snapshot): Promise<SandboxHandle>` — optional restore from snapshot

Harness responsibility:

- Wrap the handle's methods into journaled, middleware-able commands
- Stream events on the bus
- Handle abort signal → SIGTERM / cleanup
- Route inbox messages to handle method calls

This is the same separation v1 has — providers are thin, the harness is the heavy machinery.

## SandboxBridge as registry of harnesses

```ts
interface SandboxBridge {
  register(harness: SandboxHarness): Unsubscribe;
  unregister(id: string): void;
  get(id: string): SandboxHarness | undefined;
  list(): readonly SandboxHarness[];
  subscribe(listener: () => void): Unsubscribe;
}
```

The bridge tracks live harnesses. Tools query `bridges.sandbox.get(id)` to obtain the harness, then call commands on it (with full substrate observability).

## JSX integration

```tsx
import { withSandbox, Sandbox } from "@agentick/sandbox/react";
import { localProvider } from "@agentick/sandbox-local";

createApp(
  <Agent>
    <Sandbox
      id="primary"
      provider={localProvider()}
      workspace="/tmp/agent-work"
      allow={{ network: false, fileSystem: "workspace" }}
      limits={{ memoryMb: 512, wallClockSec: 60 }}
    >
      <Bash />
      <ReadFile />
      <WriteFile />
      <EditFile />
      <Conversation />
    </Sandbox>
  </Agent>,
  {
    model: openai("gpt-5"),
    extensions: [withSandbox()],
  },
);
```

The `<Sandbox>` component:

1. Uses `useData` to await `provider.create(options)` (Effect-wrapped)
2. Constructs a `SandboxHarness` wrapping the live `SandboxHandle`
3. Registers the harness with the bridge (`bridges.sandbox`)
4. Provides the harness to descendants via React Context (`useSandbox()`)
5. On unmount: calls `harness.destroy()` and unregisters

The tool components (`<Bash>`, `<ReadFile>`, `<WriteFile>`, `<EditFile>`) use `useSandbox()` inside `use: () => ({ sandbox: useSandbox() })`. The tool handler calls `Effect.runPromise(sandbox.exec({ command }))` (or stays in Effect-land if the rest of the codebase is Effect-typed).

## How tools use the sandbox harness

```ts
// In @agentick/sandbox/react/tools/shell.tsx
export const Bash = createTool({
  name: "bash",
  description: "Execute a bash command in the sandbox",
  inputSchema: z.object({ command: z.string() }),
  use: () => ({ sandbox: useSandbox() }),
  async handler({ command }, { ctx, use }) {
    if (!use.sandbox) {
      return [{ type: "text", text: "Error: no sandbox available" }];
    }
    const result = await Effect.runPromise(use.sandbox.exec({ command, signal: ctx.signal }));
    return [{ type: "text", text: result.stdout || result.stderr || "(no output)" }];
  },
});
```

Two layers of journaling visible to adopters:

- `tool:command:dispatch:requested ... :terminal` (tool layer)
- `sandbox:command:exec:requested ... :delta ... :terminal` (sandbox layer)

`app.events({ surface: "sandbox", name: "sandbox:command:exec:delta" })`
streams every chunk of every shell command. Real-time stdout monitoring
for ops dashboards.

## What v2 gains over v1

| v1                                                       | v2                                                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sandbox.exec(cmd).then(...)`                            | `sandbox.exec(input)` returns `Effect<...>`; fiber interruption propagates SIGTERM                                                                                             |
| Stdout/stderr accumulated in memory                      | Streams as bus delta events; large output bounded by adopter strategy                                                                                                          |
| No middleware                                            | `aroundExec`, `aroundReadFile`, etc. — compose auth/audit/rate-limit/golden-capture                                                                                            |
| Cancellation via AbortSignal                             | Effect interruption + provider's SIGTERM/SIGKILL semantics                                                                                                                     |
| No audit trail                                           | Every exec / file op is a journaled envelope                                                                                                                                   |
| `useSandbox()` returns raw handle                        | `useSandbox()` returns the harness; commands have full substrate observability                                                                                                 |
| Lifecycle hooks via React `useOnUnmount` only            | Five-surface lifecycle (onCreate / onDestroy / onDegraded / onExecError / onSandboxEscape / onResourceLimit / onSignal / onMount\*)                                            |
| OS keychain integration ad-hoc per adopter               | `SandboxCredentialStorage` plugin interface                                                                                                                                    |
| Provider snapshot/restore optional, unused               | First-class `provider.restore()` with `SandboxSnapshot` opaque blob; harness persists `SandboxIntent`                                                                          |
| No replay                                                | Journal supports replay of exec sequences for debugging                                                                                                                        |
| Hand-rolled error types                                  | Tagged `_tag` errors throughout (`SandboxExecError`, `SandboxIoError`, `SandboxMountError`, `SandboxEscapeError`, `SandboxResourceLimitError`, `SandboxPermissionDeniedError`) |
| Permissions: hardcoded `allow` only, no runtime override | Two-tier ACL: static config + per-session learned via `request("sandbox_permission")`; policy callback for headless                                                            |
| Per-tool middleware composed manually                    | Centralized at the sandbox layer; one definition covers every tool that uses the sandbox                                                                                       |

## Migration path for v1 adopters

```diff
- import { Sandbox } from "@agentick/sandbox";
+ import { Sandbox, withSandbox } from "@agentick/sandbox/react";

- // v1: just JSX + tool wrappers
+ // v2: same JSX + add withSandbox() extension to createApp

  createApp(<Agent>...</Agent>, {
    model: openai("gpt-5"),
+   extensions: [withSandbox()],
  });
```

The JSX surface is largely preserved (`<Sandbox provider={localProvider()} workspace={...}>`). The biggest behavioral change for adopters:

- Cancellation is more aggressive (fibers vs AbortSignal)
- Exec output is streamed (subscribe to `sandbox:command:exec:delta` for live tailing)
- Every operation appears on `app.events()` — adopters who relied on quiet sandboxes will see a lot more bus traffic

Tool handlers that called `sandbox.exec(cmd)` directly need to wrap in `Effect.runPromise()` or migrate to Effect-typed handlers. Tool authors who use `createTool` see no API change.

## What this ADR does NOT decide

- **Persistent shell session** vs one-off exec. v1 doesn't have persistent sessions per se; v2 starts with one-off. If a `<Shell>` long-lived session becomes needed (the model maintains a single bash session across calls), add `sandbox.shell(): Effect<ShellSession, ...>` later.
- **Concrete provider snapshot format.** Each provider defines its own `SandboxSnapshot` blob; the harness treats it as opaque. Specific providers will need their own snapshot ADRs.
- **Resource limit enforcement**. The harness emits `sandbox:resource:limit-exceeded` events but doesn't enforce — the provider does. Documentation will say "providers MAY enforce; adopters configure limits at the provider level."
- **`apply edits` algorithm**. Keep v1's `applyEdits` pure function as-is. Just move it inside the harness's `editFile` command.
- **Whether `<Bash>` / `<ReadFile>` / `<WriteFile>` / `<EditFile>` ship in `@agentick/sandbox/react` or a separate `@agentick/sandbox-tools` package.** Lean: same package, tool components live next to the bridge. Adopters who don't want them can tree-shake.
- **MCP-style auto-reconnect for sandbox.** Sandboxes don't "reconnect" the same way; if a sandbox dies, the harness emits `:failed`, the JSX component (via `useData`) can re-call `provider.create()`. Out of scope for this ADR.

## Implementation cost (estimate)

- ADR (this doc): done
- `SandboxHarness` skeleton (BaseHarness<"sandbox">, command surface, lifecycle): ~1 day
- Provider integration (consume `SandboxProvider`, wrap handle): ~half day
- Streaming exec + delta envelopes: ~half day
- Inbox message handlers: ~half day
- `SandboxBridge` impl + `withSandbox()` extension factory: ~1 hour
- `<Sandbox>` React component + `useSandbox()` hook: ~half day
- Tool components (`<Bash>`, `<ReadFile>`, `<WriteFile>`, `<EditFile>`): ~half day
- Tests + conformance suite: ~1 day
- Provider adapter updates (just verify they work — no changes to provider signatures): ~half day
- Migration docs: ~2 hours

**Total: ~4-5 days of focused work.**

Smaller than MCP because:

- Fewer command surfaces
- No protocol-level state machine (MCP has JSON-RPC + capabilities)
- Auth is simpler (storage interface vs full OAuth flow)
- No server-initiated callbacks

## Sequencing

Per ADR 23: sandbox ships first to validate the extension package shape end-to-end. Lessons feed back into MCP impl.

## Open questions

- **OQ24.1** — `sandbox.shell()` for persistent shell sessions: in scope for v1 of the harness, or follow-up? _Lean: follow-up. Most agents don't need it; the ones that do compose `exec` calls._
- **OQ24.2** — Should `sandbox.exec` accept `stdin` as a stream, or only as a string? _Lean: string for v1; Stream stdin can come later when an adopter actually needs it._
- **OQ24.3** — Path normalization (relative paths → absolute paths inside workspace). Done by the harness or the provider? _Lean: harness. Centralized so middleware sees consistent paths._
- **OQ24.4** — Should `aroundExec` middleware see the full command string or pre-parsed argv? _Lean: command string. Adopters who want parsed args can run a parser inside their middleware. Keeps the contract simple._
- **OQ24.5** — Resource limits enforced by the harness, the provider, or both? _Lean: provider enforces; harness emits events. Single source of truth at the provider; harness surfaces observability._
- **OQ24.6** — ACL pattern matching format: globs only, regex only, or both? _Lean: globs for paths (familiar to ops), regex available as an opt-in for exec patterns. Pattern format is a string with a leading prefix (`glob:` / `regex:` / bare = glob)._
- **OQ24.7** — When `allow-session-pattern` is granted, what's the pattern's scope? Just that command/path or the matching family? _Lean: the user/policy provides the exact pattern string they want to remember. The harness just trusts what was returned. UI surfaces "remember as `git _`" as a checkbox.\*
- **OQ24.8** — Should `stat` and `readdir` also flow through the permission request, or piggyback on read? _Lean: piggyback. A `stat` that fails because the path isn't readable is still informative (you can't even see it exists). Adopters who want stricter granularity configure separate `allow.stat` / `allow.readdir` — opt-in complexity, default behavior matches read._
- **OQ24.9** — Cross-session persistence of ACL decisions (`SandboxPermissionStore`) — when do we add it? _Lean: when a real adopter needs it. Session-scoped covers single-conversation use; multi-session apps with sticky permissions can add it incrementally._

## Cross-references

- [ADR 22](./22-state-formatters-reconciler-shape.md) — bridge extensibility pattern.
- [ADR 23](./23-mcp-as-harness.md) — sibling pattern for MCP.
- [01 — Harness Principle](./01-harness-principle.md) — five-surface contract.
- [07 — Tool Executor](./07-tool-executor.md) — how tools inject sandbox via `use:`.
- [19 — Foundation](./19-foundation.md) — BaseHarness substrate.
