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
} from "./types.js";

// ── Errors ──────────────────────────────────────────────────────────────────
export { SandboxAccessError } from "./errors.js";

// ── Edit Types & Utilities ───────────────────────────────────────────────────
export { applyEdits, editFile, EditError } from "./edit.js";
export type { Edit, EditResult, EditChange } from "./edit.js";

// ── Context & Hook ───────────────────────────────────────────────────────────
export { SandboxContext, useSandbox } from "./context.js";

// ── Component ────────────────────────────────────────────────────────────────
export { Sandbox } from "./component.js";
export type { SandboxProps } from "./component.js";

// ── Tools ────────────────────────────────────────────────────────────────────
import { Shell, ReadFile, WriteFile, EditFile } from "./tools.js";
export { Shell, ReadFile, WriteFile, EditFile };

// ── Testing ──────────────────────────────────────────────────────────────────
// Import from "@agentick/sandbox/testing" — not re-exported here to avoid
// pulling vitest into production bundles.

const h = React.createElement;

export function SandboxTools() {
  return [
    h(Shell, { key: "shell" }),
    h(ReadFile, { key: "read-file" }),
    h(WriteFile, { key: "write-file" }),
    h(EditFile, { key: "edit-file" }),
  ];
}
