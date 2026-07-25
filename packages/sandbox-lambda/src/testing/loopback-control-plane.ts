/**
 * `fakeLambdaMicrovmsControlPlane` — a loopback {@link LambdaMicrovmsControlPlane}
 * that stands in for the AWS control plane WITHOUT any AWS call (ADR 60).
 *
 * Meszaros classification: a **fake** (a working implementation with a
 * lightweight backing), NOT a stub — `runMicrovm` starts a REAL
 * {@link startSandboxAgent} bound to a fresh temp workspace on `127.0.0.1`,
 * returns its loopback endpoint, and `terminateMicrovm` closes it and removes
 * the workspace. The token is `null` (loopback → the endpoint client omits
 * auth headers). This makes EVERYTHING except the AWS control plane
 * real-testable: real HTTP/WS, real fs, real bash.
 *
 * (The delegation sketched a `stubLambdaMicrovmsControlPlane`; the double does
 * real lifecycle work — spins up agents — so per the Meszaros discipline it is
 * a `fake*`, not a `stub*`. A pure-canned stub couldn't serve the conformance
 * suite, which needs a fresh workspace + agent per `create`.)
 *
 * @see docs/proposals/v2/blueprint/60-remote-microvm-sandbox.md
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SandboxAgent, startSandboxAgent } from "../agent/server.js";
import type { LambdaMicrovmsControlPlane } from "../control-plane.js";
import { decodeRunHookPayload } from "../protocol.js";

export interface FakeControlPlaneOptions {
  /** Base dir for the per-microVM temp workspaces. Default: os.tmpdir(). */
  readonly tmpBase?: string;
}

/** A fake control plane plus a handle to stop every microVM it started. */
export interface FakeControlPlane extends LambdaMicrovmsControlPlane {
  /** Tear down every still-running microVM (test afterEach safety net). */
  stopAll(): Promise<void>;
}

export function fakeLambdaMicrovmsControlPlane(
  options: FakeControlPlaneOptions = {},
): FakeControlPlane {
  interface Entry {
    readonly agent: SandboxAgent;
    readonly workspaceDir: string;
  }
  const running = new Map<string, Entry>();

  return {
    async runMicrovm(runOptions) {
      const microvmId = `mvm-${randomBytes(6).toString("hex")}`;
      // Realpath: on macOS `os.tmpdir()` is under `/var` (a symlink to
      // `/private/var`), so `pwd` inside bash would report the resolved path
      // and mismatch `workspacePath`. Resolve up front so `/info` agrees.
      const workspaceDir = await realpath(
        await mkdtemp(join(options.tmpBase ?? tmpdir(), "lambda-sbx-")),
      );
      const hook = decodeRunHookPayload(runOptions.runHookPayload);
      const agent = await startSandboxAgent({
        workspace: workspaceDir,
        port: 0,
        host: "127.0.0.1",
        ...(hook.networkRules ? { networkRules: hook.networkRules } : {}),
        ...(hook.baseEnv ? { baseEnv: hook.baseEnv } : {}),
      });
      running.set(microvmId, { agent, workspaceDir });
      return { microvmId, endpoint: `http://127.0.0.1:${agent.port}` };
    },

    async waitRunning() {
      // The agent is already listening synchronously after runMicrovm; the
      // provider's `/info` probe is the real readiness confirmation.
    },

    async createAuthToken() {
      // Loopback → no JWE; the endpoint client omits the auth headers.
      return { token: null };
    },

    async terminateMicrovm(microvmId) {
      const entry = running.get(microvmId);
      if (!entry) return;
      running.delete(microvmId);
      await entry.agent.close();
      await rm(entry.workspaceDir, { recursive: true, force: true });
    },

    async stopAll() {
      const ids = [...running.keys()];
      await Promise.all(ids.map((id) => this.terminateMicrovm(id)));
    },
  };
}
