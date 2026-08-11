/**
 * Sandbox construction contracts + live-object interfaces (ADR 59).
 *
 * These are the provider↔harness INTERNAL contracts — NOT wire types.
 * The split test is "is it serialized across the inbox/wire?":
 *
 *   - `@agentick/spec` keeps ONLY the serialized command shapes
 *     (`SandboxExec*`/`SandboxEdit*`/mount inputs/results), `NetworkRule`,
 *     `ProxiedRequest`, and the sandbox error tags.
 *   - THIS module (the base) holds the construction contracts + live-object
 *     interfaces: {@link SandboxProvider}, {@link SandboxHandle},
 *     {@link SandboxCreateOptions}, {@link SandboxSnapshot},
 *     {@link SandboxIntent}. They reference the spec wire types freely
 *     (the base deps spec).
 *
 * Flow: `SandboxProvider` (factory) → `create()` → `SandboxHandle`
 * (live instance) → `SandboxHarness` (wraps one handle + substrate + ACL).
 * The handle is a live, non-serializable object (fds / container id /
 * workspace) consumed only server-side by the harness that wraps it 1:1;
 * `compiler-react` never touches it (it registers HARNESSES, not handles).
 *
 * Providers (`@agentick/sandbox-local`, `@agentick/sandbox-docker`, …) dep
 * THIS base, implement {@link SandboxProvider}, and return a
 * {@link SandboxHandle} — mirroring `@agentick/model-openai → @agentick/model`.
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 */

import type {
  SandboxEdit,
  SandboxEditResult,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxMount,
  SandboxPermissions,
  SandboxResourceLimits,
} from "@agentick/spec";

// ============================================================================
// Runtime handle
// ============================================================================

/**
 * Live sandbox instance. Created by a {@link SandboxProvider}, wrapped
 * 1:1 by a {@link import("./harness.js").SandboxHarness} which registers
 * with the session's `SandboxBridge`, queried by tools at dispatch time.
 *
 * Handles are NOT serializable — they hold provider-specific resources
 * (file descriptors, container ids, process handles). Hibernate-resume
 * recreates handles by replaying the provider create-call from the
 * snapshot's declared {@link SandboxIntent}.
 */
export interface SandboxHandle {
  /** Unique sandbox instance id within the session. */
  readonly id: string;
  /** Absolute path to the workspace root inside the sandbox. */
  readonly workspacePath: string;
  /** Execute a shell command. */
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>;
  /** Read a file from the sandbox filesystem. */
  readFile(path: string): Promise<string>;
  /** Write a file to the sandbox filesystem. */
  writeFile(path: string, content: string): Promise<void>;
  /**
   * Apply surgical edits to a file — the real, layered-matching edit
   * op (see `@agentick/sandbox`'s `applyEdits`). Providers own
   * atomicity (temp + rename); the harness delegates its `editFile`
   * command here after the ACL permission check.
   *
   * There is deliberately no `stat` / `readdir` on the handle: `bash`
   * (`exec`) subsumes listing + metadata (`ls`, `stat`, `find`, …).
   * A fabricated `stat` is worse than none (ADR 59). The model shells
   * out for those.
   */
  editFile(path: string, edits: readonly SandboxEdit[]): Promise<SandboxEditResult>;
  /**
   * Start a LIVE process inside the sandbox and keep talking to it.
   *
   * {@link exec} is fire-and-collect: the command's result arrives once,
   * after it is over. A supervised child — one that calls back into the
   * host WHILE it runs — cannot be driven that way, so it earns its own
   * method rather than a flag on `exec`.
   *
   * CAPABILITY-TIERED + OPTIONAL, exactly like {@link addMount}: a
   * provider with no long-lived process surface leaves this `undefined`
   * or throws `SandboxUnsupportedError`. NEVER fake it — a `spawn` that
   * silently degrades to `exec` would drop the control channel the
   * caller's protocol is built on.
   */
  spawn?(request: SandboxSpawnRequest): Promise<SandboxProcess>;
  /**
   * Mount a host directory into the sandbox at runtime — a host-side
   * PRIVILEGED op the sandboxed process cannot perform from inside, so
   * (unlike stat/readdir) `bash` does NOT subsume it: it earns a real
   * handle method + harness command.
   *
   * CAPABILITY-TIERED + OPTIONAL: a provider that cannot remount a
   * running instance (e.g. docker) leaves these `undefined` OR throws
   * `SandboxUnsupportedError`. NEVER fake success — an honest
   * "unsupported" beats a silent no-op (ADR 59). The harness
   * feature-detects and surfaces `SandboxUnsupportedError`.
   *
   * The harness gates `addMount` against the construction-time
   * {@link SandboxCreateOptions.mountAllow} ceiling before calling this.
   */
  addMount?(mount: SandboxMount): Promise<void>;
  /** Remove a runtime mount by its sandbox mount point. Capability-tiered (see {@link addMount}). */
  removeMount?(sandboxPath: string): Promise<void>;
  /** List the sandbox's current mounts. Capability-tiered (see {@link addMount}). */
  listMounts?(): Promise<readonly SandboxMount[]>;
  /** Tear down the sandbox and release provider-side resources. */
  destroy(): Promise<void>;
}

// ============================================================================
// Live process (capability tier)
// ============================================================================

/**
 * What to start. `command` + `args` rather than a shell line: a jailed
 * program's path routinely contains a space, and a quoting bug there is a
 * confinement bug.
 */
export interface SandboxSpawnRequest {
  readonly command: string;
  readonly args?: readonly string[];
  /** Merged over the sandbox's own environment, as `exec` merges its options. */
  readonly env?: Readonly<Record<string, string>>;
  /** Workspace-confined, like `exec`'s. Defaults to the workspace root. */
  readonly cwd?: string;
  /**
   * Host paths outside the workspace this process must READ — its own
   * entry script, a runtime's lib directory. The provider grants them
   * read-only at the SAME path inside the sandbox, so one command line
   * works on every platform.
   *
   * Read, and only read — the provider never grants a write alongside.
   * A supervisor whose own script the supervised program can rewrite is
   * not a supervisor, so its script belongs here rather than staged into
   * the workspace the program can write.
   */
  readonly readablePaths?: readonly string[];
}

/**
 * A running process inside the sandbox. FOUR streams, because a supervised
 * child needs a channel its own output cannot forge: the program's stdout
 * and stderr, a control channel carrying the supervising protocol, and exit.
 *
 * Listeners may be attached after the process has started; an implementation
 * must not drop bytes emitted before then.
 */
export interface SandboxProcess {
  readonly pid: number | undefined;
  onStdout(listen: (chunk: Buffer) => void): void;
  onStderr(listen: (chunk: Buffer) => void): void;
  onControl(listen: (chunk: Buffer) => void): void;
  onExit(listen: (code: number | null, signal: string | null) => void): void;
  /** Write to the control channel. A no-op once the channel is gone. */
  writeControl(chunk: string): void;
  /** Close the control input — the child's cue to exit on its own. */
  endControl(): void;
  /** Signal the process (and any tree it started). */
  kill(signal: NodeJS.Signals): void;
}

// ============================================================================
// Provider
// ============================================================================

export interface SandboxProvider {
  /** Provider name (e.g. "local", "docker", "e2b"). */
  readonly name: string;
  create(options: SandboxCreateOptions): Promise<SandboxHandle>;
  /**
   * Optional: restore a sandbox from a prior snapshot. Implementations
   * MAY no-op (or throw `SnapshotIncompatibleError`) when persistence
   * isn't supported — the bridge falls back to `create()`.
   *
   * TODO(#223): hibernate/restore deferred — no provider has a real
   * checkpoint yet (ADR 59). The bridge only ever calls `create`;
   * `restore` / {@link SandboxSnapshot} remain an unwired contract seam
   * until a remote/CRIU-style provider implements true checkpointing.
   */
  restore?(snapshot: SandboxSnapshot): Promise<SandboxHandle>;
}

export interface SandboxCreateOptions {
  /** Workspace path on the host. `true` = auto-allocate a temp dir. */
  readonly workspace?: string | true;
  /**
   * Initial filesystem mounts (host ↔ sandbox path pairs), applied at
   * create time. Runtime mounts are added dynamically via the harness's
   * `add-mount` command — constrained to {@link mountAllow}.
   */
  readonly mounts?: readonly SandboxMount[];
  /**
   * Construction-time mount **allow-list** — the host-path patterns
   * (glob / `regex:` / exact, per the ACL matcher) that MAY be mounted
   * at runtime via `add-mount`. The ceiling: the harness rejects
   * `add-mount` for any host path outside it (same ceiling-plus-dynamic
   * shape as session `requiredScopes` + downscoping). `undefined` →
   * runtime mounting is denied (default-deny; declare the ceiling to
   * opt in). Create-time {@link mounts} are honored regardless — they
   * are the operator's explicit initial authorization.
   */
  readonly mountAllow?: readonly string[];
  /** Advisory capability set (filesystem + network the sandbox allows). */
  readonly allow?: SandboxPermissions;
  /** Environment variables. Resolved to strings before reaching the provider. */
  readonly env?: Readonly<Record<string, string>>;
  /** Resource constraints (memory, cpu, disk, time). */
  readonly limits?: SandboxResourceLimits;
  /**
   * Post-create bootstrap hook (#225). Invoked once, after the provider
   * has produced the handle and before the sandbox is marked ready —
   * clone a repo, install deps, seed fixtures. The bridge (not the
   * provider) runs it, so it works uniformly across every provider.
   */
  readonly setup?: (handle: SandboxHandle) => Promise<void>;
}

// ============================================================================
// Snapshot / intent
// ============================================================================

/**
 * Declarative shape captured by the snapshot. The framework component
 * declared a `<Sandbox provider={p} ...>` mount; the bridge records the
 * intent so hibernate-resume can recreate the handle.
 */
export interface SandboxIntent {
  readonly id: string;
  readonly providerName: string;
  readonly options: SandboxCreateOptions;
  /** Optional provider-private snapshot blob for `provider.restore`. */
  readonly providerSnapshot?: SandboxSnapshot;
}

/**
 * Provider-specific snapshot blob. Opaque to the bridge; only the
 * provider that produced it can interpret it.
 *
 * TODO(#223): hibernate/restore deferred (ADR 59). This type and
 * {@link SandboxProvider.restore} are an unwired contract seam — no
 * provider implements a true checkpoint yet, and the bridge only calls
 * `create`. Kept in the contract so a future remote/CRIU-style provider
 * can slot in without a spec change.
 */
export interface SandboxSnapshot {
  readonly providerName: string;
  readonly data: Readonly<Record<string, unknown>>;
}
