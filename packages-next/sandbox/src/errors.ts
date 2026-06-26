import { omitUndefined } from "@agentick/utils-next";

/**
 * Tagged errors for the sandbox harness.
 *
 * Every error carries a `_tag` discriminant so consumers pattern-match
 * exhaustively. Effect's typed error channel surfaces these in the
 * command return types (`Effect<R, SandboxError, never>`).
 *
 * @see docs/proposals/v2/blueprint/24-sandbox-as-harness.md
 */

export interface SandboxExecError {
  readonly _tag: "SandboxExecError";
  readonly command: string;
  readonly exitCode: number;
  readonly signal?: string;
  readonly stderr?: string;
  readonly cause?: unknown;
}

export interface SandboxIoError {
  readonly _tag: "SandboxIoError";
  readonly path: string;
  readonly op: "read" | "write" | "edit" | "stat" | "readdir";
  readonly reason: string;
  readonly cause?: unknown;
}

export interface SandboxMountError {
  readonly _tag: "SandboxMountError";
  readonly hostPath?: string;
  readonly sandboxPath?: string;
  readonly reason: string;
  readonly cause?: unknown;
}

export interface SandboxEscapeError {
  readonly _tag: "SandboxEscapeError";
  readonly kind: "path-traversal" | "mount-escape" | "command-injection" | (string & {});
  readonly target: string;
  readonly detail?: string;
}

export interface SandboxResourceLimitError {
  readonly _tag: "SandboxResourceLimitError";
  readonly kind: "memory" | "cpu" | "disk" | "wallclock" | (string & {});
  readonly observedValue: number;
  readonly limit: number;
}

export interface SandboxPermissionDeniedError {
  readonly _tag: "SandboxPermissionDeniedError";
  readonly kind: "read" | "write" | "exec" | "mount";
  readonly target: string;
  readonly cause?: "policy" | "user-denied" | "timeout" | (string & {});
}

export interface SandboxConnectionError {
  readonly _tag: "SandboxConnectionError";
  readonly reason: string;
  readonly cause?: unknown;
}

export type SandboxError =
  | SandboxExecError
  | SandboxIoError
  | SandboxMountError
  | SandboxEscapeError
  | SandboxResourceLimitError
  | SandboxPermissionDeniedError
  | SandboxConnectionError;

// ============================================================================
// Constructors
// ============================================================================

export const sandboxExecError = (
  command: string,
  exitCode: number,
  opts: { signal?: string; stderr?: string; cause?: unknown } = {},
): SandboxExecError => ({
  _tag: "SandboxExecError",
  command,
  exitCode,
  ...omitUndefined({ signal: opts.signal, stderr: opts.stderr, cause: opts.cause }),
});

export const sandboxIoError = (
  path: string,
  op: SandboxIoError["op"],
  reason: string,
  cause?: unknown,
): SandboxIoError => ({
  _tag: "SandboxIoError",
  path,
  op,
  reason,
  ...(cause !== undefined ? { cause } : {}),
});

export const sandboxPermissionDenied = (
  kind: SandboxPermissionDeniedError["kind"],
  target: string,
  cause?: SandboxPermissionDeniedError["cause"],
): SandboxPermissionDeniedError => ({
  _tag: "SandboxPermissionDeniedError",
  kind,
  target,
  ...(cause !== undefined ? { cause } : {}),
});
