/**
 * `HostProcessPort` — where the child process is PLACED.
 *
 * The runtime spawns a process, writes frames to it and kills it; nothing in
 * that story says the process must be a direct child of the host app. Naming
 * the port now is what lets a sandboxed placement (`SandboxHandle.exec`, a
 * jail, a remote worker) arrive later as a different implementation instead of
 * a rewrite — placement is the trust knob this package deliberately leaves
 * open. The default is `node:child_process`, which is no containment at all.
 */

import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface HostSpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/**
 * A running child. Four streams: the program's own stdout and stderr, the
 * control channel, and exit. The control channel is separate from the program's
 * output BY CONSTRUCTION, which is why a program printing JSON at stdout cannot
 * forge a frame.
 */
export interface HostProcess {
  readonly pid: number | undefined;
  onStdout(listen: (chunk: Buffer) => void): void;
  onStderr(listen: (chunk: Buffer) => void): void;
  onControl(listen: (chunk: Buffer) => void): void;
  onExit(listen: (code: number | null, signal: string | null) => void): void;
  /** One ndjson line. A no-op once the channel is gone — a dead child is not an error to write to. */
  writeControl(line: string): void;
  /** Close the control input: the child's cue to exit on its own. */
  endControl(): void;
  kill(signal: NodeJS.Signals): void;
}

export interface HostProcessPort {
  spawn(request: HostSpawnRequest): HostProcess;
}

/** The default placement: a direct child of this process, contained by nothing. */
export function childProcessPort(): HostProcessPort {
  return {
    spawn: ({ command, args, env, cwd }) => {
      const child = spawn(command, [...args], {
        env: { ...env },
        // The control channel is fd 3 so that fds 1 and 2 stay the program's.
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        ...(cwd === undefined ? {} : { cwd }),
      });
      const control = child.stdio[3] as Readable & Writable;
      const stdin = child.stdin as Writable;
      // A child killed between two frames makes EPIPE a normal event here.
      stdin.on("error", () => undefined);
      control.on("error", () => undefined);
      return {
        pid: child.pid,
        onStdout: (listen) => void child.stdout?.on("data", listen),
        onStderr: (listen) => void child.stderr?.on("data", listen),
        onControl: (listen) => void control.on("data", listen),
        onExit: (listen) => void child.on("exit", listen),
        writeControl: (line) => {
          if (stdin.writable) stdin.write(line);
        },
        endControl: () => {
          if (stdin.writable) stdin.end();
        },
        kill: (signal) => void child.kill(signal),
      };
    },
  };
}
