/**
 * Secure-Exec Sandbox Tools
 *
 * ExecJS tool for executing JavaScript in the isolate, plus
 * a convenience component that bundles ExecJS with file tools.
 */

import React from "react";
import { createTool } from "@agentick/core";
import { z } from "zod";
import { useSandbox, ReadFile, WriteFile, EditFile } from "@agentick/sandbox";

const h = React.createElement;

/**
 * Execute JavaScript code in the sandbox isolate.
 *
 * Unlike the Bash tool (shell commands), this runs JS directly in the V8 isolate.
 * `console.log()` outputs to stdout, `console.error()` to stderr.
 * Node.js built-ins (fs, path, http, etc.) are available via require().
 */
export const ExecJS = createTool({
  name: "exec_js",
  description: `Execute JavaScript code in the sandbox. Use console.log() for output. Node.js APIs (fs, path, http, etc.) are available via require(). Code runs in a persistent V8 isolate — variables and module cache persist across calls.`,
  input: z.object({
    code: z.string().describe("JavaScript code to execute."),
  }),
  displaySummary: (input) => input.code.split("\n")[0]!.slice(0, 80),
  use: () => ({ sandbox: useSandbox() }),
  handler: async ({ code }, deps) => {
    const result = await deps!.sandbox.exec(code);
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    if (result.exitCode !== 0) parts.push(`[exit code: ${result.exitCode}]`);
    return [{ type: "text" as const, text: parts.join("\n") || "(no output)" }];
  },
});

/**
 * Convenience component that provides all secure-exec sandbox tools.
 * Includes: exec_js, read_file, write_file, edit_file.
 */
export function SecureExecTools() {
  return h(
    React.Fragment,
    null,
    h(ExecJS, { key: "exec-js" }),
    h(ReadFile, { key: "read-file" }),
    h(WriteFile, { key: "write-file" }),
    h(EditFile, { key: "edit-file" }),
  );
}
