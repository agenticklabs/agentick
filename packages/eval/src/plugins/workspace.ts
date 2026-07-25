/**
 * `@agentick/eval/plugins/workspace` — executable-outcome scoring.
 *
 * The plugin that makes coding-agent evals meaningful: after the agent mutates
 * a workspace, grade by RUNNING the result — `tsc`, tests, the produced code —
 * not by string-matching. `t.sh("pnpm typecheck")` + `t.expect` is the
 * SWE-bench pattern: does the change actually WORK.
 *
 * Usage:
 * ```ts
 * import { workspace } from "@agentick/eval/plugins/workspace";
 * defineEval({
 *   plugins: [workspace({ dir: myScratchDir })],
 *   async test(t) {
 *     await t.send("add a farewell export to greeting.js");
 *     t.expect("farewell exported", (await t.file("greeting.js")).includes("farewell"));
 *     t.expect("greet still runs", (await t.sh("node -e \"require('./greeting').greet('x')\"")).ok);
 *   },
 * });
 * ```
 *
 * The `dir` is whatever workspace the app factory pointed the agent's tools at,
 * so `t.sh`/`t.file` observe exactly what the agent changed.
 */

import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { exec } from "node:child_process";

import type { EvalPlugin } from "../types.js";

/** Result of `t.sh(command)`. `ok` is true iff the process exited 0. */
export interface ShellResult {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

// Type the members this plugin attaches to `t`. Importing this subpath makes
// `t.sh` / `t.file` visible (install-to-appear); the factory below wires them.
declare module "@agentick/eval" {
  interface EvalContextExtensions {
    /** Run a shell command in the eval's workspace. `ok` iff exit code 0. */
    sh(command: string, opts?: { readonly timeoutMs?: number }): Promise<ShellResult>;
    /** Read a UTF-8 file from the eval's workspace (relative path). */
    file(path: string): Promise<string>;
  }
}

export interface WorkspaceOptions {
  /** The workspace root — the same dir the app factory pointed the agent at. */
  readonly dir: string;
  /** Default per-command timeout (ms). Default 60_000. */
  readonly timeoutMs?: number;
}

/**
 * A workspace plugin scoped to `dir`. Provide the same directory the app
 * factory seeded so `t.sh`/`t.file` see the agent's actual side effects.
 */
export function workspace(opts: WorkspaceOptions): EvalPlugin {
  const { dir } = opts;
  const defaultTimeout = opts.timeoutMs ?? 60_000;
  return () => ({
    sh(command: string, shOpts?: { readonly timeoutMs?: number }): Promise<ShellResult> {
      return new Promise<ShellResult>((resolve) => {
        exec(
          command,
          { cwd: dir, timeout: shOpts?.timeoutMs ?? defaultTimeout },
          (err, stdout, stderr) => {
            const code = err ? ((err as { code?: number }).code ?? 1) : 0;
            resolve({ ok: code === 0, code, stdout, stderr: stderr || (err ? err.message : "") });
          },
        );
      });
    },
    file(path: string): Promise<string> {
      return fs.readFile(nodePath.resolve(dir, path), "utf8");
    },
  });
}
