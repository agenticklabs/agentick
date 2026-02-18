import { execFile as execFileCb } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function extractExitCode(error: Error | null): number {
  if (!error) return 0;
  // ENOENT = command not found
  if ((error as any).code === "ENOENT") return -1;
  // ExecException: .status holds the exit code on macOS/Linux
  const status = (error as any).status;
  if (typeof status === "number") return status;
  // Fallback: .code might be the exit code as a number
  const code = (error as any).code;
  if (typeof code === "number") return code;
  // Error exists but no exit code found — assume non-zero
  return 1;
}

export function exec(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFileCb(cmd, args, { encoding: "utf-8" }, (error, stdout, stderr) => {
      resolve({
        stdout: (stdout ?? "").trim(),
        stderr: (stderr ?? "").trim(),
        exitCode: extractExitCode(error),
      });
    });
  });
}

export function execWithStdin(cmd: string, args: string[], input: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFileCb(cmd, args, { encoding: "utf-8" }, (error, stdout, stderr) => {
      resolve({
        stdout: (stdout ?? "").trim(),
        stderr: (stderr ?? "").trim(),
        exitCode: extractExitCode(error),
      });
    });
    child.stdin?.write(input);
    child.stdin?.end();
  });
}
