/**
 * Coding tools for the naive coding agent.
 *
 * The tools themselves are deliberately simple (node `fs` against a scratch
 * workspace) — they are the VEHICLE. What they demonstrate is the v2 substrate
 * a tool handler reaches through `ctx`:
 *
 *   - `write_file` gates the destructive write behind `ctx.elicit.confirm(...)`
 *     — an ElicitationHarness round-trip that surfaces to the client as
 *     `session.elicitations()`.
 *   - `run_shell` runs the command as a `ctx.tasks.submit(...)` TASK — the
 *     status FSM surfaces to the client as `session.tasks`.
 *   - every tool emits `ctx.log(...)` — surfaces to the client as `onLog`.
 *
 * Tool descriptions follow the "what / when to use / tips" tone that reads well
 * to a model.
 */

import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { exec } from "node:child_process";
import { z } from "zod";
import { createTool } from "@agentick/compiler-react-next";
import type { ContentBlock } from "@agentick/spec-next";

// ─────────────────────────────────────────────────────────────────────
// Workspace — the sandbox root every tool resolves paths against. Set once
// by the server before the agent mounts. A real agent would use the v2
// `<Sandbox>` / `ctx.sandbox`; a module-level root keeps the example focused.
// ─────────────────────────────────────────────────────────────────────

let workspaceRoot = process.cwd();
export function setWorkspaceRoot(dir: string): void {
  workspaceRoot = dir;
}

// Headless mode — when true, write_file skips the elicitation confirm (there is
// no human/client to answer). The eval runs headless; the interactive client
// leaves this false so writes are human-approved. A real deployment would gate
// this on a CI/headless flag.
let autoApproveWrites = false;
export function setAutoApproveWrites(on: boolean): void {
  autoApproveWrites = on;
}

/** Resolve `rel` inside the workspace, rejecting `..` escapes. */
function resolveInWorkspace(rel: string): string {
  const abs = nodePath.resolve(workspaceRoot, rel);
  if (abs !== workspaceRoot && !abs.startsWith(workspaceRoot + nodePath.sep)) {
    throw new Error(`path "${rel}" escapes the workspace`);
  }
  return abs;
}

const text = (t: string): ContentBlock[] => [{ type: "text", text: t }];

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next", "coverage"]);

// ─────────────────────────────────────────────────────────────────────
// read_file — safe, synchronous read. Line-numbered so the model can cite
// ranges (and so a follow-up edit knows what it's changing).
// ─────────────────────────────────────────────────────────────────────

export const ReadFile = createTool({
  name: "read_file",
  description:
    "Read a UTF-8 text file from the workspace and return its contents with line numbers. " +
    "Use this before editing a file, or to inspect code you found via grep. " +
    "Tip: paths are relative to the workspace root.",
  inputSchema: z.object({
    path: z.string().describe("File path relative to the workspace root, e.g. 'src/index.ts'."),
  }),
  handler: async ({ path }, { ctx }) => {
    ctx.log("info", { tool: "read_file", path });
    try {
      const raw = await fs.readFile(resolveInWorkspace(path), "utf8");
      const numbered = raw
        .split("\n")
        .map((line, i) => `${String(i + 1).padStart(4)}  ${line}`)
        .join("\n");
      return text(`# ${path}\n${numbered}`);
    } catch (err) {
      return text(`Error reading "${path}": ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

// ─────────────────────────────────────────────────────────────────────
// list_dir — safe directory listing (skips heavy/vendor dirs).
// ─────────────────────────────────────────────────────────────────────

export const ListDir = createTool({
  name: "list_dir",
  description:
    "List the entries of a workspace directory (directories suffixed with '/'). " +
    "Use this to orient yourself before reading or grepping. Skips node_modules/.git/dist.",
  inputSchema: z.object({
    path: z.string().default(".").describe("Directory path relative to the workspace root."),
  }),
  handler: async ({ path }, { ctx }) => {
    ctx.log("info", { tool: "list_dir", path });
    try {
      const entries = await fs.readdir(resolveInWorkspace(path), { withFileTypes: true });
      const lines = entries
        .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return text(lines.length ? lines.join("\n") : "(empty)");
    } catch (err) {
      return text(`Error listing "${path}": ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

// ─────────────────────────────────────────────────────────────────────
// grep — recursive regex search. Caps results; reports file:line: content.
// ─────────────────────────────────────────────────────────────────────

const MAX_MATCHES = 100;

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(nodePath.join(dir, e.name));
    } else if (e.isFile()) {
      yield nodePath.join(dir, e.name);
    }
  }
}

export const Grep = createTool({
  name: "grep",
  description:
    "Search the workspace for a regular expression, returning matching 'file:line: content'. " +
    "Use this to find where a symbol/string lives before reading. " +
    "Tip: if results are truncated at 100, narrow the pattern.",
  inputSchema: z.object({
    pattern: z.string().describe("A JavaScript regular expression, e.g. 'createTool\\\\('."),
    path: z.string().default(".").describe("Directory to search under, relative to the workspace."),
  }),
  handler: async ({ pattern, path }, { ctx }) => {
    ctx.log("info", { tool: "grep", pattern, path });
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      return text(
        `Invalid regex "${pattern}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const hits: string[] = [];
    try {
      for await (const file of walk(resolveInWorkspace(path))) {
        if (hits.length >= MAX_MATCHES) break;
        let content: string;
        try {
          content = await fs.readFile(file, "utf8");
        } catch {
          continue; // binary / unreadable — skip
        }
        const rel = nodePath.relative(workspaceRoot, file);
        content.split("\n").forEach((line, i) => {
          if (hits.length < MAX_MATCHES && re.test(line)) {
            hits.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    } catch (err) {
      return text(`grep error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!hits.length) return text(`No matches for /${pattern}/.`);
    const truncated =
      hits.length >= MAX_MATCHES ? "\n… (truncated at 100 — narrow the pattern)" : "";
    return text(hits.join("\n") + truncated);
  },
});

// ─────────────────────────────────────────────────────────────────────
// write_file — DESTRUCTIVE. Gated behind `ctx.elicit.confirm(...)`.
//
// The confirm() is an ElicitationHarness round-trip: it publishes a request
// on `session:channel:elicitation`, which the CLIENT consumes via
// `session.elicitations()` and answers with `.accept(true)` / `.decline()`.
// The handler blocks until the client replies — a human-in-the-loop gate for
// a destructive op, driven entirely from the far side of the wire.
// ─────────────────────────────────────────────────────────────────────

export const WriteFile = createTool({
  name: "write_file",
  description:
    "Create or overwrite a workspace file with the given content. " +
    "DESTRUCTIVE — the user is asked to approve every write before it happens. " +
    "Use this ONLY for creating new files or full rewrites.",
  inputSchema: z.object({
    path: z.string().describe("File path relative to the workspace root."),
    content: z.string().describe("The full file content to write."),
  }),
  handler: async ({ path, content }, { ctx }) => {
    ctx.log("info", { tool: "write_file", path, bytes: content.length });

    // Human-in-the-loop gate. `ctx.elicit` is undefined only on substrate-
    // stripped fixtures; a real session always has it — but guard anyway.
    // Headless mode (evals) skips the confirm — no client to answer it.
    if (!autoApproveWrites && ctx.elicit) {
      const approved = await ctx.elicit.confirm(`Write ${content.length} bytes to "${path}"?`, {
        default: false,
      });
      if (!approved) {
        ctx.log("warning", { tool: "write_file", path, outcome: "declined" });
        return text(`Write to "${path}" was declined by the user.`);
      }
    }

    try {
      const abs = resolveInWorkspace(path);
      await fs.mkdir(nodePath.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
      return text(`Wrote ${content.length} bytes to "${path}".`);
    } catch (err) {
      return text(`Error writing "${path}": ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

// ─────────────────────────────────────────────────────────────────────
// run_shell — runs the command as a `ctx.tasks.submit(...)` TASK.
//
// The task's status FSM (working → completed/failed) fans out on
// `session:channel:task-status`, which the CLIENT watches via `session.tasks`.
// This is Pattern A (no `taskSupport` annotation): the executor awaits the
// handle transparently and the model sees the final output — but the task is
// still visible to any client watching the session while it runs.
// ─────────────────────────────────────────────────────────────────────

export const RunShell = createTool({
  name: "run_shell",
  description:
    "Run a shell command in the workspace and return its combined stdout/stderr. " +
    "Use this for git, running tests, builds, `ls`, etc. Runs as a managed task with a 30s timeout.",
  inputSchema: z.object({
    command: z.string().describe("The shell command to run, e.g. 'ls -la' or 'node --version'."),
  }),
  handler: async ({ command }, { ctx }) => {
    ctx.log("info", { tool: "run_shell", command });
    // `ctx.tasks` is undefined only on substrate-stripped fixtures; a real
    // session always has it. Submitting returns a TaskHandle — the executor
    // awaits it transparently (Pattern A), and the status FSM is visible to
    // any client watching `session.tasks` while it runs.
    return ctx.tasks!.submit(
      async ({ signal, setStatusMessage }) => {
        setStatusMessage(`$ ${command}`);
        const { stdout, stderr } = await execAsync(command, workspaceRoot, signal);
        const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
        return text(out || "(no output)");
      },
      { statusMessage: "queued" },
    );
  },
});

/** Promisified `exec` scoped to the workspace, honoring the task's abort signal. */
function execAsync(
  command: string,
  cwd: string,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, timeout: 30_000, signal }, (err, stdout, stderr) => {
      // A non-zero exit is still a "result" the model should see, not a throw.
      if (err && (err as NodeJS.ErrnoException).code === "ABORT_ERR") reject(err);
      else resolve({ stdout, stderr: stderr || (err ? err.message : "") });
    });
  });
}
