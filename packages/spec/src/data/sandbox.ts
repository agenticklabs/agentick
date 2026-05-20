/**
 * Sandbox protocol types — wire shapes for the sandbox abstraction.
 *
 * v1 lives in `@agentick/sandbox/types.ts`. v2 mirrors the shapes here
 * so any reconciler (React, Angular, Vue) can integrate sandboxes via
 * the `SandboxBridge` without depending on v1's component runtime.
 *
 * Provider adapters (`@agentick/sandbox-local`, `sandbox-docker`,
 * `sandbox-secure-exec`, …) implement {@link SandboxProvider}. Each
 * reconciler ships a framework-specific component (`<Sandbox>` in
 * React, `@Injectable()` SandboxService in Angular, etc.) that uses
 * the provider to create a {@link SandboxHandle} and registers it
 * with the session's {@link SandboxBridge}.
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md
 */

// ============================================================================
// Runtime handle
// ============================================================================

/**
 * Live sandbox instance. Created by a {@link SandboxProvider},
 * registered with the {@link SandboxBridge} by a framework-specific
 * component, queried by tools at dispatch time.
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
  /** Tear down the sandbox and release provider-side resources. */
  destroy(): Promise<void>;
}

export interface SandboxExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly stdin?: string;
}

export interface SandboxExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly signaled: boolean;
  readonly durationMs: number;
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
   */
  restore?(snapshot: SandboxSnapshot): Promise<SandboxHandle>;
}

export interface SandboxCreateOptions {
  /** Workspace path on the host. `true` = auto-allocate a temp dir. */
  readonly workspace?: string | true;
  /** Filesystem mounts (host ↔ sandbox path pairs). */
  readonly mounts?: readonly SandboxMount[];
  /** Advisory capability set (which syscalls / network the sandbox allows). */
  readonly allow?: SandboxPermissions;
  /** Environment variables. Resolved to strings before reaching the provider. */
  readonly env?: Readonly<Record<string, string>>;
  /** Resource constraints (memory, cpu, disk, time). */
  readonly limits?: SandboxResourceLimits;
}

export interface SandboxMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly mode?: "ro" | "rw";
}

export interface SandboxPermissions {
  readonly network?: boolean;
  readonly fileSystem?: "none" | "workspace" | "host";
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface SandboxResourceLimits {
  readonly memoryMb?: number;
  readonly cpuPercent?: number;
  readonly diskMb?: number;
  readonly wallClockSec?: number;
}

// ============================================================================
// ACL — static config + per-session learned (ADR 24)
// ============================================================================

/**
 * Static access-control config supplied at sandbox construction time
 * (`<Sandbox allow={...}>`). The harness checks every operation
 * against this allow list first; if the target isn't allowed, it
 * issues a `sandbox_permission` request (the same primitive the tool
 * executor uses for confirmation flows). The user / policy decides;
 * the harness remembers the decision for the rest of the session.
 *
 * Pattern format:
 *   - bare string or `glob:<pattern>` — glob match (default)
 *   - `regex:<pattern>` — regex match (opt-in for exec)
 *   - absolute path — exact match (for read/write)
 */
export interface SandboxACL {
  /** Always-allowed read paths / globs. */
  readonly read?: readonly string[];
  /** Always-allowed write paths / globs. */
  readonly write?: readonly string[];
  /** Always-allowed exec command patterns. */
  readonly exec?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
  };
  /** Network policy (enforced by the provider, not the ACL flow). */
  readonly network?: boolean;
}

/**
 * Request payload sent via `harness.request("sandbox_permission", payload)`.
 * The session routes this to a configured policy callback or to the
 * user (via TUI / web prompt / etc.).
 */
export type SandboxPermissionRequest =
  | {
      readonly kind: "read";
      readonly path: string;
      readonly sandboxId: string;
      readonly rationale?: string;
    }
  | {
      readonly kind: "write";
      readonly path: string;
      readonly sandboxId: string;
      readonly rationale?: string;
    }
  | {
      readonly kind: "exec";
      readonly command: string;
      readonly sandboxId: string;
      readonly rationale?: string;
    }
  | {
      readonly kind: "mount";
      readonly hostPath: string;
      readonly sandboxPath: string;
      readonly sandboxId: string;
      readonly rationale?: string;
    };

/**
 * Response shape for `sandbox_permission`. The decision is honored by
 * the harness — for the `*-session*` variants, the decision is
 * remembered (in the harness's per-session ACL state) and applied
 * silently to future matching operations.
 */
export type SandboxPermissionResponse =
  | { readonly decision: "allow-once" }
  | { readonly decision: "allow-session" }
  | { readonly decision: "allow-session-pattern"; readonly pattern: string }
  | { readonly decision: "deny" }
  | { readonly decision: "deny-session" };

// ============================================================================
// Per-command inputs / results
// ============================================================================

export interface SandboxExecInput {
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly stdin?: string;
}

/**
 * Streaming delta envelope payload for `sandbox:command:exec:delta`.
 * Adopters tail stdout/stderr live by subscribing.
 */
export interface SandboxExecDelta {
  readonly stream: "stdout" | "stderr";
  readonly chunk: string;
}

export interface SandboxReadFileInput {
  readonly path: string;
}

export interface SandboxWriteFileInput {
  readonly path: string;
  readonly content: string;
}

export interface SandboxEditFileInput {
  readonly path: string;
  readonly edits: readonly SandboxEdit[];
  /** Optional optimistic-concurrency check. */
  readonly expectedHash?: string;
}

/**
 * Surgical edit shape — port of v1's `Edit`. The harness's `editFile`
 * applies these atomically (read → transform → write tempfile → rename
 * → fsync), preserving v1's behavior.
 */
export interface SandboxEdit {
  readonly old?: string;
  readonly new?: string;
  readonly all?: boolean;
  readonly mode?:
    | "replace"
    | "delete"
    | "insert-before"
    | "insert-after"
    | "insert-start"
    | "insert-end"
    | "range";
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface SandboxEditResult {
  readonly applied: number;
  readonly skipped: number;
  readonly content: string;
  readonly hash: string;
}

export interface SandboxStatInput {
  readonly path: string;
}

export interface SandboxStat {
  readonly path: string;
  readonly size: number;
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly mtime: number;
}

export interface SandboxReaddirInput {
  readonly path: string;
}

export interface SandboxDirEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
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
 */
export interface SandboxSnapshot {
  readonly providerName: string;
  readonly data: Readonly<Record<string, unknown>>;
}
