/**
 * Pre-built Sandbox Tools
 *
 * Tools that access the sandbox from the component tree via useSandbox().
 * Tree-scoped — multiple sandboxes just work, each tool accesses its nearest provider.
 */

import { createTool } from "@agentick/core";
import { z } from "zod";
import { useSandbox } from "./context";

/**
 * Execute a shell command in the sandbox.
 */
export const Shell = createTool({
  name: "shell",
  description: "Execute a shell command in the sandbox environment.",
  input: z.object({
    command: z.string().describe("The shell command to execute."),
  }),
  use: () => ({ sandbox: useSandbox() }),
  handler: async ({ command }, deps) => {
    const result = await deps!.sandbox.exec(command);
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    if (result.exitCode !== 0) parts.push(`[exit code: ${result.exitCode}]`);
    return [{ type: "text" as const, text: parts.join("\n") || "(no output)" }];
  },
});

/**
 * Read a file from the sandbox filesystem.
 */
export const ReadFile = createTool({
  name: "read_file",
  description: "Read the contents of a file in the sandbox.",
  input: z.object({
    path: z.string().describe("Path to the file to read."),
  }),
  use: () => ({ sandbox: useSandbox() }),
  handler: async ({ path }, deps) => {
    const content = await deps!.sandbox.readFile(path);
    return [{ type: "text" as const, text: content }];
  },
});

/**
 * Write a file to the sandbox filesystem.
 */
export const WriteFile = createTool({
  name: "write_file",
  description: "Write content to a file in the sandbox. Creates the file if it doesn't exist.",
  input: z.object({
    path: z.string().describe("Path to the file to write."),
    content: z.string().describe("Content to write to the file."),
  }),
  use: () => ({ sandbox: useSandbox() }),
  handler: async ({ path, content }, deps) => {
    await deps!.sandbox.writeFile(path, content);
    return [{ type: "text" as const, text: `Wrote ${content.length} bytes to ${path}` }];
  },
});

/**
 * Apply surgical edits to a file in the sandbox.
 */
export const EditFile = createTool({
  name: "edit_file",
  description:
    "Apply surgical edits to a file. Each edit specifies an old string to find and a new string to replace it with.",
  input: z.object({
    path: z.string().describe("Path to the file to edit."),
    edits: z
      .array(
        z.object({
          old: z.string().describe("Exact string to find in the file."),
          new: z.string().describe("Replacement string. Empty string deletes the match."),
          all: z
            .boolean()
            .optional()
            .describe("Replace all occurrences. Default: false (requires unique match)."),
        }),
      )
      .describe("Array of edits to apply."),
  }),
  use: () => ({ sandbox: useSandbox() }),
  handler: async ({ path, edits }, deps) => {
    const result = await deps!.sandbox.editFile(path, edits);
    return [
      {
        type: "text" as const,
        text: `Applied ${result.applied} edit(s) to ${path}. Changes: ${result.changes.map((c) => `line ${c.line}: -${c.removed}/+${c.added}`).join(", ")}`,
      },
    ];
  },
});
