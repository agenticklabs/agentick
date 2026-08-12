/**
 * `sandboxHost()` — OWN vs ADOPT lifecycle, without a real jail.
 *
 * The load-bearing invariant is ownership: OWN creates a sandbox and must
 * DESTROY it when the runtime disposes; ADOPT borrows the session's sandbox and
 * must NEVER destroy it — that jail is `withSandbox`'s to end. A
 * contract-typed stub handle (a spy on `destroy`, a `spawn` that satisfies the
 * placement port) is enough to pin who tears down what; the REAL jail is proven
 * in `sandbox-placement.spec.ts`.
 *
 * @verifiedBy this file
 */

import { describe, expect, it, vi } from "vitest";
import type { SessionInstaller } from "@agentick/spec";
import type {
  SandboxBridge,
  SandboxHandle,
  SandboxProcess,
  SandboxProvider,
} from "@agentick/sandbox";

import { sandboxHost } from "../sandbox-host.js";

/** A handle that can host a process (so the port wires) and reports destroy. */
function stubHandle(): SandboxHandle {
  const spawn = vi.fn(async (): Promise<SandboxProcess> => {
    throw new Error("stub sandbox: spawn is defined for wiring, not for running");
  });
  const unused = (name: string) => (): never => {
    throw new Error(`stub sandbox: ${name} is not exercised by the lifecycle test`);
  };
  return {
    id: "stub-sandbox",
    workspacePath: "/sandbox",
    spawn,
    destroy: vi.fn(async () => undefined),
    exec: unused("exec"),
    readFile: unused("readFile"),
    writeFile: unused("writeFile"),
    editFile: unused("editFile"),
  };
}

function stubProvider(handle: SandboxHandle): SandboxProvider {
  return { name: "stub", create: vi.fn(async () => handle) };
}

/** An installer whose `sandbox` namespace resolves `handle` as the active jail. */
function installerWithSandbox(handle: SandboxHandle): SessionInstaller {
  const bridge = {
    get: (id: string) => (id === "primary" ? { placement: handle } : undefined),
    list: () => [{ id: "primary", workspacePath: handle.workspacePath, status: "ready" }],
  } as unknown as SandboxBridge;
  return {
    getNamespace: <T>(name: string): T | undefined =>
      name === "sandbox" ? (bridge as unknown as T) : undefined,
  } as unknown as SessionInstaller;
}

const bareInstaller = { getNamespace: () => undefined } as unknown as SessionInstaller;

describe("sandboxHost — capabilities are engine-only, resolved sandbox-free", () => {
  it("reports the host engine's caps with no sandbox, no installer, no spawn", async () => {
    const caps = await sandboxHost().capabilities();
    expect(caps.name).toMatch(/^host:/);

    // The jail cannot change the engine: OWN reports identical caps, and asking
    // built no sandbox — capabilities() never touched the provider.
    const provider = stubProvider(stubHandle());
    const owned = await sandboxHost({ provider }).capabilities();
    expect(owned).toEqual(caps);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("running a program still needs the jail — caps do not paper over a missing sandbox", async () => {
    await expect(sandboxHost().resolve(bareInstaller)).rejects.toThrow(/none is mounted/i);
  });
});

describe("sandboxHost — OWN owns its jail", () => {
  it("creates the sandbox from the provider and DESTROYS it on dispose", async () => {
    const handle = stubHandle();
    const provider = stubProvider(handle);

    const runtime = await sandboxHost({ provider }).resolve(bareInstaller);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(handle.destroy).not.toHaveBeenCalled();

    await runtime.dispose();
    expect(handle.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("sandboxHost — ADOPT borrows, never owns", () => {
  it("reaches the session's sandbox and NEVER destroys it on dispose", async () => {
    const handle = stubHandle();
    const installer = installerWithSandbox(handle);

    const runtime = await sandboxHost().resolve(installer);
    await runtime.dispose();

    // The borrowed jail is withSandbox's to end — a borrower tearing it down
    // is the exact accident the SandboxPlacement view makes unrepresentable.
    expect(handle.destroy).not.toHaveBeenCalled();
  });

  it("fails clearly when no sandbox is mounted", async () => {
    await expect(sandboxHost().resolve(bareInstaller)).rejects.toThrow(
      /no sandbox is mounted|none is mounted/i,
    );
  });

  it("fails clearly when the named sandbox is absent", async () => {
    const installer = installerWithSandbox(stubHandle());
    await expect(sandboxHost({ sandboxId: "nope" }).resolve(installer)).rejects.toThrow(
      /no sandbox "nope"/,
    );
  });
});
