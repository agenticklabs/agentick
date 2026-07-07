/**
 * Tagged errors for the sandbox harness.
 *
 * **Migrated to `AgentickError` class hierarchy (ADR 41).** Classes
 * live in `@agentick/spec-next/errors/remaining.ts`; this module
 * re-exports them at the existing import path so adopter code doesn't
 * change. New code SHOULD import directly from `@agentick/spec-next`.
 *
 * Convenience constructors (`sandboxExecError`, `sandboxIoError`,
 * `sandboxPermissionDenied`) survive as thin wrappers that delegate
 * to the class constructors.
 *
 * @see docs/proposals/v2/blueprint/24-sandbox-as-harness.md
 * @see docs/proposals/v2/blueprint/41-error-hierarchy.md
 */

export {
  SandboxConnectionError,
  SandboxError,
  type SandboxErrorChannel,
  SandboxEscapeError,
  SandboxExecError,
  SandboxIoError,
  SandboxMountError,
  SandboxPermissionDeniedError,
  SandboxResourceLimitError,
  SandboxUnsupportedError,
} from "@agentick/spec-next";

import {
  SandboxExecError,
  SandboxIoError,
  SandboxPermissionDeniedError,
} from "@agentick/spec-next";

// ============================================================================
// Convenience constructors — preserved for backward compatibility.
// ============================================================================

export const sandboxExecError = (
  command: string,
  exitCode: number,
  opts: { signal?: string; stderr?: string; cause?: unknown } = {},
): SandboxExecError =>
  new SandboxExecError({
    command,
    exitCode,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.stderr !== undefined ? { stderr: opts.stderr } : {}),
    ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
  });

export const sandboxIoError = (
  path: string,
  op: SandboxIoError["op"],
  reason: string,
  cause?: unknown,
): SandboxIoError =>
  new SandboxIoError({
    path,
    op,
    reason,
    ...(cause !== undefined ? { cause } : {}),
  });

export const sandboxPermissionDenied = (
  kind: SandboxPermissionDeniedError["kind"],
  target: string,
  cause?: SandboxPermissionDeniedError["cause"],
): SandboxPermissionDeniedError =>
  new SandboxPermissionDeniedError({
    kind,
    target,
    ...(cause !== undefined ? { cause } : {}),
  });
