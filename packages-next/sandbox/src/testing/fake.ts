/**
 * Test double for {@link SandboxProvider} — an in-memory fake (Meszaros:
 * a working implementation with a lightweight backing, not a stub).
 *
 * Use it to wire and test harness/bridge integration WITHOUT spawning real
 * processes or touching the filesystem. The file API is a real in-memory
 * map, and `editFile` runs the real `applyEdits` transform, so edit
 * behavior is faithful. `exec` is programmable via `execHandler` (default:
 * empty stdout, exit 0) — a fake shell, not a real one, so this double does
 * NOT claim `runSandboxProviderConformance` (that pins a REAL provider —
 * e.g. `sandbox-local-next` — against real temp dirs + a real shell).
 *
 * Ships from `@agentick/sandbox-next/testing` — the double lives WITH the
 * `SandboxProvider` contract it implements (ADR 59).
 *
 * @see packages-next/sandbox-next/README.md
 */

import type {
  SandboxEdit,
  SandboxEditResult,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxMount,
} from "@agentick/spec-next";
import { applyEdits } from "../edit.js";
import type { SandboxCreateOptions, SandboxHandle, SandboxProvider } from "../contract.js";

export interface FakeSandboxOptions {
  /** Seed the in-memory filesystem (sandbox-relative path → content). */
  readonly files?: Readonly<Record<string, string>>;
  /**
   * Programmable exec. Default returns `{ stdout: "", stderr: "", exitCode: 0 }`.
   * The returned stdout is also streamed through `onOutput` as a single chunk.
   */
  readonly execHandler?: (
    command: string,
    options?: SandboxExecOptions,
  ) => Partial<SandboxExecResult>;
}

class FakeSandbox implements SandboxHandle {
  readonly id = `fake-${Math.random().toString(36).slice(2, 10)}`;
  readonly workspacePath = "/sandbox";
  private readonly files = new Map<string, string>();
  private readonly mounts: SandboxMount[] = [];
  private readonly execHandler: NonNullable<FakeSandboxOptions["execHandler"]>;
  private destroyed = false;

  constructor(options: FakeSandboxOptions = {}) {
    for (const [path, content] of Object.entries(options.files ?? {})) {
      this.files.set(path, content);
    }
    this.execHandler = options.execHandler ?? (() => ({}));
  }

  async exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult> {
    this.assertAlive();
    const partial = this.execHandler(command, options);
    const stdout = partial.stdout ?? "";
    if (stdout && options?.onOutput) options.onOutput({ stream: "stdout", chunk: stdout });
    return {
      stdout,
      stderr: partial.stderr ?? "",
      exitCode: partial.exitCode ?? 0,
      signaled: partial.signaled ?? false,
      durationMs: partial.durationMs ?? 0,
    };
  }

  async readFile(path: string): Promise<string> {
    this.assertAlive();
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`fake sandbox: no such file: ${path}`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.assertAlive();
    this.files.set(path, content);
  }

  async editFile(path: string, edits: readonly SandboxEdit[]): Promise<SandboxEditResult> {
    this.assertAlive();
    const source = this.files.get(path);
    if (source === undefined) throw new Error(`fake sandbox: no such file: ${path}`);
    const result = applyEdits(source, edits);
    if (result.applied > 0) this.files.set(path, result.content);
    return result;
  }

  async addMount(mount: SandboxMount): Promise<void> {
    this.assertAlive();
    const idx = this.mounts.findIndex((m) => m.sandboxPath === mount.sandboxPath);
    if (idx !== -1) this.mounts[idx] = mount;
    else this.mounts.push(mount);
  }

  async removeMount(sandboxPath: string): Promise<void> {
    this.assertAlive();
    const idx = this.mounts.findIndex((m) => m.sandboxPath === sandboxPath);
    if (idx !== -1) this.mounts.splice(idx, 1);
  }

  async listMounts(): Promise<readonly SandboxMount[]> {
    return [...this.mounts];
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error(`fake sandbox ${this.id} has been destroyed`);
  }
}

/**
 * An in-memory {@link SandboxProvider}. Each `create` returns a fresh
 * {@link FakeSandbox} seeded with `options.files`.
 */
export function fakeSandboxProvider(options: FakeSandboxOptions = {}): SandboxProvider {
  return {
    name: "fake-local",
    async create(_options: SandboxCreateOptions): Promise<SandboxHandle> {
      return new FakeSandbox(options);
    },
  };
}
