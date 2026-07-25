/**
 * `LambdaSandbox` — a {@link SandboxHandle} backed by one AWS Lambda MicroVM
 * (ADR 60).
 *
 * The handle is a CLIENT STUB, not the workspace: it holds an
 * {@link EndpointClient} pointed at the microVM endpoint plus the resolved
 * workspace path, and each op is a request to the in-VM sandbox-agent. This is
 * exactly what ADR 59's async-handle contract allows for a remote provider —
 * `readFile`/`writeFile`/`editFile` are HTTP round-trips, `exec` is a
 * WebSocket stream. `editFile` runs `applyEdits` IN-VM (one hop), never a
 * client-side read→edit→write.
 *
 * Capability tiers (honest, per ADR 59 — never fake):
 *   - **Runtime mounts** (`addMount`/`removeMount`/`listMounts`) throw
 *     `SandboxUnsupportedError`: a host-path mount has NO referent in a remote
 *     microVM (there is no shared host). Unlike docker, DOMAIN-level network
 *     rules ARE supported — via the in-VM egress proxy, resolved at the
 *     provider (see `provider.ts`), not here.
 *   - **Exec abort/timeout** closes the WebSocket; the agent reaps the process
 *     tree and the result reports `exitCode: 124`, `signaled: true`.
 *
 * `destroy()` delegates to the provider's control-plane terminate (passed as
 * `onDestroy`) — the microVM, not a local resource, is what gets torn down.
 *
 * @see docs/proposals/v2/blueprint/60-remote-microvm-sandbox.md
 */

import type {
  SandboxEdit,
  SandboxEditResult,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxMount,
} from "@agentick/sandbox";
import { SandboxIoError, SandboxUnsupportedError } from "@agentick/sandbox";
import type { EndpointClient } from "./endpoint-client.js";

export interface LambdaSandboxInit {
  /** The microVM id — the sandbox instance id within the session. */
  readonly id: string;
  /** Absolute workspace root inside the microVM (from the agent's `/info`). */
  readonly workspacePath: string;
  /** The endpoint client reaching the in-VM agent. */
  readonly client: EndpointClient;
  /**
   * Teardown hook — terminates the microVM via the control plane (or, in
   * loopback tests, closes the local agent). Runs once on `destroy()`.
   */
  readonly onDestroy: () => Promise<void>;
}

export class LambdaSandbox implements SandboxHandle {
  readonly id: string;
  readonly workspacePath: string;

  private readonly client: EndpointClient;
  private readonly onDestroy: () => Promise<void>;
  private destroyed = false;

  constructor(init: LambdaSandboxInit) {
    this.id = init.id;
    this.workspacePath = init.workspacePath;
    this.client = init.client;
    this.onDestroy = init.onDestroy;
  }

  async exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult> {
    this.assertAlive();
    return this.client.exec(command, options);
  }

  async readFile(path: string): Promise<string> {
    this.assertAlive();
    return this.client.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.assertAlive();
    await this.client.writeFile(path, content);
  }

  async editFile(path: string, edits: readonly SandboxEdit[]): Promise<SandboxEditResult> {
    this.assertAlive();
    // `applyEdits` runs IN-VM at the agent — one atomic round-trip.
    return this.client.editFile(path, edits);
  }

  // ─── Runtime mounts — capability tier (ADR 60) ───
  // A host-path mount has no referent in a remote microVM (no shared host).
  // Rather than fake success (a silent lie), these throw. EFS/S3-prefix
  // mounts are a documented provider-extension follow-on, not a host bind.

  async addMount(_mount: SandboxMount): Promise<void> {
    throw new SandboxUnsupportedError({
      capability:
        "addMount (a host-path mount has no referent in a remote microVM; " +
        "EFS/S3-prefix attachment is a provider-extension follow-on — TODO(#226-followup))",
    });
  }

  async removeMount(_sandboxPath: string): Promise<void> {
    throw new SandboxUnsupportedError({
      capability: "removeMount (remote microVM host mounts unsupported)",
    });
  }

  async listMounts(): Promise<readonly SandboxMount[]> {
    throw new SandboxUnsupportedError({
      capability: "listMounts (remote microVM host mounts unsupported)",
    });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    // TODO(#223): hibernate fast-follow — a retain-vs-terminate choice here
    // (suspend-microvm to keep a restore-capable snapshot vs terminate).
    await this.onDestroy();
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new SandboxIoError({
        path: this.workspacePath,
        op: "read",
        reason: `sandbox ${this.id} has been destroyed`,
      });
    }
  }
}
