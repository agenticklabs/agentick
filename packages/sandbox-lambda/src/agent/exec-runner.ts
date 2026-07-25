/**
 * In-VM exec runner for the sandbox-agent (ADR 60).
 *
 * Spawns `bash -c <command>` inside the microVM and streams stdout/stderr to
 * the caller frame-by-frame, then reports the terminal `{exitCode, signaled,
 * durationMs}`. There is NO exec ceiling — the open WebSocket carries a long
 * build/test to completion; a `timeoutMs` (best-effort) or an external abort
 * (the socket closing → {@link ExecController.abort}) kills the process tree
 * and reports `exitCode: 124`, `signaled: true` (mirrors docker/local abort
 * semantics).
 *
 * Ported faithfully from `LocalSandbox.exec` — the agent IS a local sandbox
 * from the microVM's point of view; only the transport (WS frames vs an
 * in-process callback) differs.
 *
 * @see docs/proposals/v2/blueprint/60-remote-microvm-sandbox.md
 */

import { type ChildProcess, spawn } from "node:child_process";

export interface ExecRunOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  /** Streamed as each chunk arrives (the WS `output` frames). */
  readonly onOutput: (frame: { stream: "stdout" | "stderr"; chunk: string }) => void;
}

export interface ExecRunResult {
  readonly exitCode: number;
  readonly signaled: boolean;
  readonly durationMs: number;
}

/** Live handle over a running exec — the server aborts it when the WS closes. */
export interface ExecController {
  readonly result: Promise<ExecRunResult>;
  abort(): void;
}

/**
 * Start a command and return a controller. The `result` promise resolves once
 * the process closes (or is killed); `abort()` kills the whole process group.
 */
export function runExec(options: ExecRunOptions): ExecController {
  const started = Date.now();

  const child: ChildProcess = spawn("bash", ["-c", options.command], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true, // own process group → we can kill the whole tree
  });

  let killed = false;
  const killTree = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
  };

  // Best-effort wall-clock ceiling — no exec ceiling from the platform.
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      killed = true;
      killTree("SIGTERM");
    }, options.timeoutMs);
    timer.unref();
  }

  if (options.stdin !== undefined) child.stdin?.write(options.stdin);
  child.stdin?.end();

  // The agent only STREAMS frames; the near-side client assembles the
  // authoritative stdout/stderr from them (no exec ceiling, no in-VM buffer).
  child.stdout?.on("data", (c: Buffer) =>
    options.onOutput({ stream: "stdout", chunk: c.toString() }),
  );
  child.stderr?.on("data", (c: Buffer) =>
    options.onOutput({ stream: "stderr", chunk: c.toString() }),
  );

  const result = new Promise<ExecRunResult>((resolve) => {
    const settle = (exitCode: number, signaled: boolean): void => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode, signaled, durationMs: Date.now() - started });
    };
    child.on("close", (code, signal) => {
      settle(code ?? (killed ? 124 : 1), signal !== null || killed);
    });
    child.on("error", () => {
      settle(killed ? 124 : 1, killed);
    });
  });

  return {
    result,
    abort() {
      killed = true;
      killTree("SIGTERM");
    },
  };
}
