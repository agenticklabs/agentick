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
  description: `Apply surgical text edits to a file. Supports replace, delete, insert, and range operations.

MODES:
- Replace: { old: "target text", new: "replacement" } — find and replace
- Delete: { old: "text to remove", delete: true } — find and delete (trailing newline auto-consumed for complete lines)
- Insert: { old: "anchor", insert: "after", content: "new lines" } — insert before/after anchor
- Append: { insert: "end", content: "new content" } — append to end of file
- Prepend: { insert: "start", content: "new content" } — prepend to start of file
- Rename: { old: "name", new: "newName", all: true } — replace every occurrence
- Range: { from: "start marker", to: "end marker", content: "replacement" } — replace block between markers (inclusive)

MATCHING:
- old/from/to must uniquely match one location (unless all: true)
- Include 1-3 surrounding lines of context for unique identification
- Whitespace-tolerant: trailing whitespace and indentation differences handled automatically
- Multi-line matching supported — include complete lines for best results
- Copy exact text from the file — do not retype from memory

BEST PRACTICES:
- Prefer multiple small, focused edits over one large edit
- Use insert mode for adding imports, methods, config entries, or test cases
- Use range mode for replacing function bodies or large blocks — only match boundaries, not entire content
- Use all: true only for variable/function renames
- For text files only (code, config, markdown, JSON, YAML, TOML, HTML, CSV, etc.)
- NOT for binary files (images, audio, PDFs) — use write_file for full replacement or shell for transformations`,
  input: z.object({
    path: z.string().describe("Path to the file to edit."),
    edits: z
      .array(
        z.object({
          old: z
            .string()
            .optional()
            .describe(
              "Text to find. Required for replace, delete, and insert before/after. In insert mode, this is the anchor (not replaced).",
            ),
          new: z
            .string()
            .optional()
            .describe(
              "Replacement text. Required for replace. Use delete: true instead of new: '' for clarity.",
            ),
          all: z
            .boolean()
            .optional()
            .describe("Apply to all occurrences. Default: false (requires unique match)."),
          delete: z.boolean().optional().describe("Delete the matched text. Sugar for new: ''."),
          insert: z
            .enum(["before", "after", "start", "end"])
            .optional()
            .describe(
              "Insert mode. 'before'/'after' insert content relative to anchor (old). 'start'/'end' prepend/append to file.",
            ),
          content: z
            .string()
            .optional()
            .describe("Content to insert (insert mode) or replacement content (range mode)."),
          from: z
            .string()
            .optional()
            .describe("Start boundary for range replacement (inclusive). Used with 'to'."),
          to: z
            .string()
            .optional()
            .describe(
              "End boundary for range replacement (inclusive). Everything from 'from' through 'to' is replaced with 'content'.",
            ),
        }),
      )
      .describe(
        "Array of edits to apply. All edits resolved against original content, applied atomically.",
      ),
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
