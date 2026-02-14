/**
 * @agentick/sandbox - Sandbox primitive layer
 *
 * Types, context, component, and pre-built tools for sandboxed execution.
 */

import React from "react";

// ── Types ────────────────────────────────────────────────────────────────────
export type {
  Sandbox as SandboxHandle,
  SandboxProvider,
  SandboxCreateOptions,
  SandboxConfig,
  SandboxSnapshot,
  ExecOptions,
  ExecResult,
  OutputChunk,
  Mount,
  Permissions,
  ResourceLimits,
  NetworkRule,
  ProxiedRequest,
} from "./types";

// ── Edit Types & Utilities ───────────────────────────────────────────────────
export { applyEdits, editFile, EditError } from "./edit";
export type { Edit, EditResult, EditChange } from "./edit";

// ── Context & Hook ───────────────────────────────────────────────────────────
export { SandboxContext, useSandbox } from "./context";

// ── Component ────────────────────────────────────────────────────────────────
export { Sandbox } from "./component";
export type { SandboxProps } from "./component";

// ── Tools ────────────────────────────────────────────────────────────────────
import { Shell, ReadFile, WriteFile, EditFile } from "./tools";
export { Shell, ReadFile, WriteFile, EditFile };

// ── Testing ──────────────────────────────────────────────────────────────────
// Import from "@agentick/sandbox/testing" — not re-exported here to avoid
// pulling vitest into production bundles.

const h = React.createElement;

export function SandboxTools() {
  return [h(Shell), h(ReadFile), h(WriteFile), h(EditFile)];
}
