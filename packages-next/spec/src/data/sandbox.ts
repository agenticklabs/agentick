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
  /**
   * Apply surgical edits to a file — the real, layered-matching edit
   * op (see `@agentick/sandbox-next`'s `applyEdits`). Providers own
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
   * Mount a host directory into the sandbox at runtime — a host-side
   * PRIVILEGED op the sandboxed process cannot perform from inside, so
   * (unlike stat/readdir) `bash` does NOT subsume it: it earns a real
   * handle method + harness command.
   *
   * CAPABILITY-TIERED + OPTIONAL: a provider that cannot remount a
   * running instance (e.g. docker) leaves these `undefined` OR throws
   * {@link SandboxUnsupportedError}. NEVER fake success — an honest
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

export interface SandboxExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly stdin?: string;
  /**
   * Live output callback (#219). The provider invokes it for each
   * stdout/stderr chunk as the command runs; the harness wires this to
   * forward chunks onto the `sandbox:command:exec` `delta` phase
   * ({@link SandboxExecDelta}) so subscribers can tail output. Providers
   * that can't stream simply never call it — `stdout`/`stderr` on the
   * final {@link SandboxExecResult} remain authoritative.
   */
  readonly onOutput?: (chunk: SandboxExecDelta) => void;
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

/**
 * A host ↔ sandbox directory mount. Ported from v1
 * `@agentick/sandbox/types.ts` (`Mount`).
 */
export interface SandboxMount {
  /** Absolute host filesystem path. */
  readonly hostPath: string;
  /** Absolute path inside the sandbox. */
  readonly sandboxPath: string;
  /** Mount read-only. Default: read-write. */
  readonly readOnly?: boolean;
}

export interface SandboxPermissions {
  /**
   * Network egress policy.
   *   - `false` — deny all (default)
   *   - `true` — allow all
   *   - `NetworkRule[]` — evaluated in order, first match wins, default deny
   *
   * The rule matcher + egress proxy are provider-side (ADR 59: the pure
   * matcher ships from `@agentick/sandbox-net-next`, the local HTTP proxy
   * from `sandbox-local-next`, docker enforces via `NetworkMode`). These
   * are the shared wire types only.
   */
  readonly network?: boolean | readonly NetworkRule[];
  readonly fileSystem?: "none" | "workspace" | "host";
  readonly extra?: Readonly<Record<string, unknown>>;
}

// ============================================================================
// Network firewall — shared wire vocabulary (ADR 59)
// ============================================================================

/**
 * A single egress rule. Rules are evaluated in order; first match wins;
 * unmatched requests are denied (default-deny). Ported from v1
 * `@agentick/sandbox/types.ts`.
 *
 * The pure matcher (`matchRequest` / `matchDomain`, first-match-wins,
 * `*.domain` wildcards) lives in `@agentick/sandbox-net-next` so every
 * egress-enforcing provider (local proxy, docker, remote) shares it
 * without a wrong-direction dependency. These types are the vocabulary
 * that matcher, providers, and observability all speak.
 */
export interface NetworkRule {
  /** "allow" or "deny". Rules evaluated in order; first match wins. */
  readonly action: "allow" | "deny";
  /** Domain pattern. Supports wildcards: "*.example.com", "api.github.com". */
  readonly domain?: string;
  /** URL regex pattern. Matched against the full URL. */
  readonly urlPattern?: string;
  /** HTTP methods to match. Default: all. */
  readonly methods?: readonly string[];
  /** Port to match. */
  readonly port?: number;
}

/**
 * Audit record for a request that transited the egress proxy. Emitted
 * by egress-enforcing providers for observability. Ported from v1.
 */
export interface ProxiedRequest {
  /** Full URL of the request. */
  readonly url: string;
  /** HTTP method. */
  readonly method: string;
  /** Target host. */
  readonly host: string;
  /** Target port. */
  readonly port: number;
  /** Unix timestamp (ms) when the request was made. */
  readonly timestamp: number;
  /** Whether the request was blocked. */
  readonly blocked: boolean;
  /** The rule that matched, if any. */
  readonly matchedRule?: NetworkRule;
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
 * delegates to its `ElicitationHarnessProtocol` — the substrate
 * primitive that backs tool confirmation, MCP elicitation, and any
 * other "ask user X" step. The user / policy decides; the harness
 * remembers the decision for the rest of the session.
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
 * Telemetry shape — describes the structured permission request the
 * harness routes through `ElicitationHarness.elicit(...)` when an
 * operation falls outside the static + session-learned ACL. The
 * harness stamps this exact value onto the elicitation envelope's
 * `payload.metadata` field; clients (devtools, MCP hosts, custom
 * UIs) read it to render a typed prompt. Renderers dispatch on
 * `payload.hints.kind === "sandbox_permission"`.
 *
 * NOT a wire-level message anymore — there is no separate
 * `sandbox_permission` channel. Every permission round-trip flows
 * through `session:channel:elicitation` like every other elicitation.
 *
 * @see ../../sandbox/src/permission-schema.ts for the response
 *      Standard-Schema (`SANDBOX_PERMISSION_REPLY_SCHEMA`).
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
 * Telemetry / domain shape for the structured response the harness
 * applies after a sandbox-permission elicitation resolves with
 * `outcome: "accepted"`. The Standard-Schema that actually validates
 * the wire reply lives in `@agentick/sandbox-next` as
 * `SANDBOX_PERMISSION_REPLY_SCHEMA` — that schema is the source of
 * truth; this type mirrors it for adopters that need a TS shape.
 *
 * Decisions matching the `*-session*` variants are remembered on the
 * harness's per-session ACL state and applied silently to future
 * matching operations.
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
}

/**
 * Surgical edit — the shape of v1's `Edit` (ported faithfully). Mode is
 * detected by field presence (precedence: range > insert > delete >
 * replace), NOT by an explicit discriminator:
 *
 *   - Range: `from` + `to` + `content` — replace block between markers
 *   - Insert before/after: `old` + `insert` + `content` — relative to anchor
 *   - Insert start/end: `insert` + `content` — prepend/append to file
 *   - Delete: `old` + `delete: true` — remove matched text
 *   - Replace: `old` + `new` — find and replace
 *
 * The matcher lives in `@agentick/sandbox-next`'s `applyEdits`:
 * layered exact → line-normalized → indent-adjusted matching, CRLF
 * normalization, smart-line-deletion, atomic overlap detection.
 */
export interface SandboxEdit {
  /** Text to find. Required for replace, delete, insert before/after. */
  readonly old?: string;
  /** Replacement text. Required for replace mode. */
  readonly new?: string;
  /** Replace/delete/insert ALL occurrences. Default false. */
  readonly all?: boolean;
  /** Delete the matched text (sugar for `new: ""`). */
  readonly delete?: boolean;
  /**
   * Insert position. `before`/`after` use `old` as anchor;
   * `start`/`end` target file boundaries.
   */
  readonly insert?: "before" | "after" | "start" | "end";
  /** Content to insert (insert mode) or replacement block (range mode). */
  readonly content?: string;
  /** Start boundary for range replacement (inclusive). */
  readonly from?: string;
  /** End boundary for range replacement (inclusive). */
  readonly to?: string;
}

/** One applied change, in document order. */
export interface SandboxEditChange {
  /** 1-based line where the change starts. */
  readonly line: number;
  /** Lines removed. */
  readonly removed: number;
  /** Lines added. */
  readonly added: number;
}

export interface SandboxEditResult {
  /** Resulting content after all edits. */
  readonly content: string;
  /** Total number of replacements applied. */
  readonly applied: number;
  /** Per-replacement details in document order. */
  readonly changes: readonly SandboxEditChange[];
}

/** Input for the `add-mount` harness command. */
export interface SandboxAddMountInput {
  readonly mount: SandboxMount;
}

/** Input for the `remove-mount` harness command. */
export interface SandboxRemoveMountInput {
  /** The sandbox mount point to unmount. */
  readonly sandboxPath: string;
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
