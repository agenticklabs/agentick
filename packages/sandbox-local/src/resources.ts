/**
 * `DiskMonitor` — best-effort `diskMb` enforcement (ADR 59, #240).
 *
 * Polls the workspace size with `du -sk` (portable across macOS + Linux; `-sb`
 * is Linux-only) and invokes an `onExceeded` callback when the workspace grows
 * past the `diskMb` ceiling — the handle wires that to kill the sandbox's
 * processes. This is the honest cross-platform mapping of `diskMb`: neither
 * seatbelt nor the common cgroup v2 delegation exposes a filesystem quota, so
 * a poller is the available mechanism (best-effort, not a hard quota).
 *
 * The v1 `ResourceEnforcer` also owned timeout signals + process-group kill;
 * in v2 those responsibilities live on the handle (`exec`'s `AbortSignal`
 * plumbing and `destroy`'s tree-kill), so this is scoped to disk alone — the
 * only additive resource concern.
 *
 * Ported (and narrowed) from v1 `@agentick/sandbox-local/resources.ts`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** How often to sample workspace size (ms). */
const DISK_POLL_INTERVAL_MS = 5_000;

export class DiskMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  /**
   * @param workspacePath workspace root to measure
   * @param diskMb        ceiling in MB; the workspace may not exceed it
   * @param onExceeded    invoked (once per breach sample) when exceeded
   */
  constructor(
    private readonly workspacePath: string,
    private readonly diskMb: number,
    private readonly onExceeded: () => void,
  ) {}

  /** Begin polling. The timer is `unref`'d so it never holds the event loop. */
  start(): void {
    this.timer = setInterval(() => {
      void this.check();
    }, DISK_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  /** Stop polling. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async check(): Promise<void> {
    if (this.stopped) return;
    try {
      const { stdout } = await execFileAsync("du", ["-sk", this.workspacePath]);
      const kib = Number.parseInt(stdout.split("\t")[0] ?? "0", 10);
      if (Number.isFinite(kib) && kib * 1024 > this.diskMb * 1024 * 1024) {
        this.onExceeded();
      }
    } catch {
      // `du` may fail if the workspace was destroyed mid-poll — ignore.
    }
  }
}
