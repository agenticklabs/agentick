/**
 * Pre-built tool components for sandbox operations.
 *
 * Each tool wraps a single harness command. The handler resolves the
 * active `SandboxHarness` from `ctx.sandbox` — the app-scoped
 * `SandboxBridge` dispatch-resolved by the tool executor (ADR 66) —
 * rather than capturing it at render through the JSX `use:` bag. It is
 * a thin adapter that invokes the harness and formats the result as
 * `ContentBlock[]` for the model.
 *
 * `ctx.sandbox` is the SAME bridge as `useBridges().sandbox`; the
 * built-in tools target the default `<Sandbox id="primary">` (falling
 * back to the sole sandbox when exactly one is registered). Adopters
 * who need cross-section routing among multiple sandboxes compose their
 * own tools and query the bridge by id (`ctx.sandbox?.get(id)`), or use
 * `useSandbox()` + a render-time `use:` capture for genuinely
 * tree-positional selection.
 *
 * @see docs/proposals/v2/blueprint/66-tool-dependency-resolution.md
 */

import { z } from "zod";
import { createTool } from "@agentick/compiler-react";
import type { ContentBlock } from "@agentick/spec";

import "../augment.js";
import type { SandboxBridge } from "../bridge.js";
import type { SandboxHarness } from "../harness.js";

/**
 * Resolve the harness the built-in tools operate on from the app-scoped
 * bridge. Targets the default `<Sandbox id="primary">`; when no
 * "primary" is registered but exactly one sandbox exists, that sole
 * sandbox is used. Returns `undefined` when no sandbox is mounted or the
 * selection is ambiguous (multiple non-primary sandboxes) — the handler
 * surfaces a clear error in that case.
 */
function activeSandbox(bridge: SandboxBridge | undefined): SandboxHarness | undefined {
  if (!bridge) return undefined;
  const primary = bridge.get("primary");
  if (primary) return primary;
  const regs = bridge.list();
  if (regs.length === 1) {
    const only = regs[0];
    if (only) return bridge.get(only.id);
  }
  return undefined;
}

/**
 * `<Bash />` — execute a shell command in the in-scope sandbox.
 * Returns stdout (or stderr on non-zero exit) as a text block.
 */
export const Bash = createTool({
  name: "bash",
  description: "Execute a shell command in the sandbox",
  inputSchema: z.object({
    command: z.string().describe("The shell command to execute"),
    cwd: z.string().optional().describe("Working directory inside the sandbox"),
    timeoutMs: z.number().int().positive().optional(),
  }),
  async handler({ command, cwd, timeoutMs }, { ctx }): Promise<readonly ContentBlock[]> {
    const sandbox = activeSandbox(ctx.sandbox);
    if (!sandbox) {
      return [{ type: "text", text: "Error: no sandbox available in scope" }];
    }
    const result = await sandbox.exec({
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
  inputSchema: z.object({
    path: z.string().describe("Absolute path inside the sandbox"),
  }),
  async handler({ path }, { ctx }): Promise<readonly ContentBlock[]> {
    const sandbox = activeSandbox(ctx.sandbox);
    if (!sandbox) {
      return [{ type: "text", text: "Error: no sandbox available in scope" }];
    }
    const content = await sandbox.readFile({ path });
    return [{ type: "text", text: content }];
  },
});

/**
 * `<WriteFile />` — write a file to the sandbox workspace. Atomic.
 */
export const WriteFile = createTool({
  name: "write_file",
  description: "Write a file to the sandbox workspace",
  inputSchema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  async handler({ path, content }, { ctx }): Promise<readonly ContentBlock[]> {
    const sandbox = activeSandbox(ctx.sandbox);
    if (!sandbox) {
      return [{ type: "text", text: "Error: no sandbox available in scope" }];
    }
    await sandbox.writeFile({ path, content });
    return [{ type: "text", text: `Wrote ${content.length} bytes to ${path}` }];
  },
});

/**
 * `<EditFile />` — apply surgical edits to a file. Carries the full v1
 * mode set (replace / delete / insert before|after|start|end / range),
 * mode detected by field presence. All edits resolve against the
 * original content and apply atomically.
 *
 * TODO(#220): structured `confirmationPreview: { type: "diff" }` UX is
 * deferred — the tool-executor confirmation seam surfaces the pending
 * input but has no diff-preview slot yet. ACL-elicitation covers the
 * approval path in the meantime.
 */
export const EditFile = createTool({
  name: "edit_file",
  description: `Apply surgical text edits to a file. Supports replace, delete, insert, and range operations.

MODES (detected by which fields you set):
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
- Whitespace- and indentation-tolerant; copy exact text from the file`,
  inputSchema: z.object({
    path: z.string().describe("Path to the file to edit."),
    edits: z
      .array(
        z.object({
          old: z
            .string()
            .optional()
            .describe(
              "Text to find. Required for replace, delete, and insert before/after (the anchor, not replaced).",
            ),
          new: z
            .string()
            .optional()
            .describe("Replacement text. Required for replace. Use delete: true for removal."),
          all: z
            .boolean()
            .optional()
            .describe("Apply to all occurrences. Default: false (requires unique match)."),
          delete: z.boolean().optional().describe("Delete the matched text. Sugar for new: ''."),
          insert: z
            .enum(["before", "after", "start", "end"])
            .optional()
            .describe(
              "Insert mode. 'before'/'after' relative to anchor (old); 'start'/'end' prepend/append to file.",
            ),
          content: z
            .string()
            .optional()
            .describe("Content to insert (insert mode) or replacement block (range mode)."),
          from: z
            .string()
            .optional()
            .describe("Start boundary for range replacement (inclusive). Used with 'to'."),
          to: z.string().optional().describe("End boundary for range replacement (inclusive)."),
        }),
      )
      .min(1),
  }),
  async handler({ path, edits }, { ctx }): Promise<readonly ContentBlock[]> {
    const sandbox = activeSandbox(ctx.sandbox);
    if (!sandbox) {
      return [{ type: "text", text: "Error: no sandbox available in scope" }];
    }
    const result = await sandbox.editFile({ path, edits });
    const summary = result.changes
      .map((c) => `line ${c.line}: -${c.removed}/+${c.added}`)
      .join(", ");
    return [
      {
        type: "text",
        text: `Applied ${result.applied} edit(s) to ${path}.${summary ? ` Changes: ${summary}` : ""}`,
      },
    ];
  },
});
