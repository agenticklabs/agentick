/**
 * Sandbox protocol types — the SERIALIZED wire shapes for the sandbox
 * abstraction (the inbox-addressable command payloads/results, the
 * network firewall vocabulary, the ACL/telemetry shapes).
 *
 * The provider construction + live-object contracts are NOT wire types —
 * they live in the base package `@agentick/sandbox-next` (`contract.ts`)
 * alongside the harness/bridge impl, mirroring `LanguageModelAdapter` in
 * `model-next`. The split test is "is it serialized across the
 * inbox/wire?" (ADR 59).
 *
 * These shapes let any reconciler (React, Angular, Vue) integrate
 * sandboxes via the `SandboxBridge` without depending on v1's component
 * runtime. Provider adapters (`@agentick/sandbox-local-next`,
 * `sandbox-docker-next`, …) dep the base and implement its provider
 * contract.
 *
 * @see docs/proposals/v2/blueprint/59-sandbox-providers.md
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md
 */

// ============================================================================
// Exec — command options + result
// ============================================================================

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
// Mounts
// ============================================================================

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
   * matcher ships from `@agentick/sandbox-next` (base), the local HTTP
   * proxy from `sandbox-local-next`, docker enforces via `NetworkMode`).
   * These are the shared wire types only.
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
 * `*.domain` wildcards) lives in `@agentick/sandbox-next` (base) so every
 * egress-enforcing provider (local proxy, docker, remote) — which deps
 * the base — shares it. These types are the vocabulary that matcher,
 * providers, and observability all speak.
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
