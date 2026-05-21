/**
 * Pre-built tool components for sandbox operations.
 *
 * Each tool wraps a single harness command and uses `useSandbox()` to
 * capture the in-scope harness at render time. The handler is a thin
 * adapter that invokes the harness via `Effect.runPromise` and
 * formats the result as `ContentBlock[]` for the model.
 *
 * Adopters who want different surface (typed args, response shaping,
 * etc.) compose their own tools using `useSandbox()` + the harness
 * directly.
 */

import { z } from "zod";
import { createTool } from "@agentick/reconciler-react";
import type { ContentBlock } from "@agentick/spec";

import { useSandbox } from "./hook.js";

/**
 * `<Bash />` — execute a shell command in the in-scope sandbox.
 * Returns stdout (or stderr on non-zero exit) as a text block.
 */
export const Bash = createTool({
  name: "bash",
  description: "Execute a shell command in the sandbox",
  input: z.object({
    command: z.string().describe("The shell command to execute"),
    cwd: z.string().optional().describe("Working directory inside the sandbox"),
    timeoutMs: z.number().int().positive().optional(),
  }),
  use: () => ({ sandbox: useSandbox() }),
  async handler({ command, cwd, timeoutMs }, { use }): Promise<readonly ContentBlock[]> {
    if (!use.sandbox) {
      return [{ type: "text", text: "Error: no sandbox available in scope" }];
    }
    const result = await use.sandbox.exec({
      command,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    if (result.exitCode === 0) {
      return [{ type: "text", text: result.stdout || "(no output)" }];
    }
    return [
      {
        type: "text",
        text: `(exit ${result.exitCode})\n${result.stderr || result.stdout || ""}`,
      },
    ];
  },
});

/**
 * `<ReadFile />` — read a file from the sandbox workspace.
 */
export const ReadFile = createTool({
  name: "read_file",
  description: "Read a file from the sandbox workspace",
  input: z.object({
    path: z.string().describe("Absolute path inside the sandbox"),
  }),
  use: () => ({ sandbox: useSandbox() }),
  async handler({ path }, { use }): Promise<readonly ContentBlock[]> {
    if (!use.sandbox) {
      return [{ type: "text", text: "Error: no sandbox available in scope" }];
    }
    const content = await use.sandbox.readFile({ path });
    return [{ type: "text", text: content }];
  },
});

/**
 * `<WriteFile />` — write a file to the sandbox workspace. Atomic.
 */
export const WriteFile = createTool({
  name: "write_file",
  description: "Write a file to the sandbox workspace",
  input: z.object({
    path: z.string(),
    content: z.string(),
  }),
  use: () => ({ sandbox: useSandbox() }),
  async handler({ path, content }, { use }): Promise<readonly ContentBlock[]> {
    if (!use.sandbox) {
      return [{ type: "text", text: "Error: no sandbox available in scope" }];
    }
    await use.sandbox.writeFile({ path, content });
    return [{ type: "text", text: `Wrote ${content.length} bytes to ${path}` }];
  },
});

/**
 * `<EditFile />` — apply surgical edits to a file. Edits are a list
 * of `{ old, new }` pairs; the harness applies them atomically.
 */
export const EditFile = createTool({
  name: "edit_file",
  description:
    "Apply surgical find/replace edits to a file. Edits run in order; either all apply or the operation reports skipped.",
  input: z.object({
    path: z.string(),
    edits: z
      .array(
        z.object({
          old: z.string(),
          new: z.string().optional(),
          all: z.boolean().optional(),
          mode: z.enum(["replace", "delete", "insert-before", "insert-after"]).optional(),
        }),
      )
      .min(1),
  }),
  use: () => ({ sandbox: useSandbox() }),
  async handler({ path, edits }, { use }): Promise<readonly ContentBlock[]> {
    if (!use.sandbox) {
      return [{ type: "text", text: "Error: no sandbox available in scope" }];
    }
    const result = await use.sandbox.editFile({ path, edits });
    return [
      {
        type: "text",
        text: `Edits to ${path}: ${result.applied} applied, ${result.skipped} skipped`,
      },
    ];
  },
});
