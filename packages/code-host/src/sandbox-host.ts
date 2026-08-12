/**
 * `sandboxHost()` — the host engine, placed in a sandbox.
 *
 * `hostRuntime()` runs model-authored code as a child of the host app, with the
 * app's own reach. `sandboxHost()` runs the SAME engine, spawning its
 * subprocess INSIDE a jail via the spawn port, so what a program can touch is
 * what the sandbox allows. The fd-3 control channel survives the jail (#285),
 * so bindings and results cross unchanged.
 *
 * Two forms, one code path, told apart by whether a provider is supplied:
 *
 *   - OWN — `sandboxHost({ provider })`: creates its own sandbox and DESTROYS
 *     it when the runtime disposes.
 *   - ADOPT — `sandboxHost()`: borrows the session's sandbox — the same one the
 *     file/shell tools reach through `ctx.sandbox` — and NEVER destroys it. The
 *     sandbox is owned by `withSandbox`/the session (borrow, never own).
 *
 * @see ./sandbox-host-port.ts — the placement seam
 * @see ./host-runtime.ts — the engine being placed
 */

import type { Runtime, RuntimeProvider } from "@agentick/code";
import { activeSandbox } from "@agentick/sandbox";
import type {
  SandboxBridge,
  SandboxCreateOptions,
  SandboxPlacement,
  SandboxProvider,
} from "@agentick/sandbox";
import type { SessionInstaller } from "@agentick/spec";

import { detectEngine, hostCapabilities } from "./engine.js";
import { hostRuntime, type HostRuntimeConfig } from "./host-runtime.js";
import { sandboxHostPort } from "./sandbox-host-port.js";

export interface SandboxHostConfig extends Omit<HostRuntimeConfig, "host"> {
  /**
   * OWN form. Given, `sandboxHost` creates its own sandbox from this provider
   * and owns its lifecycle; absent, it ADOPTS the session's sandbox.
   */
  readonly provider?: SandboxProvider;
  /** OWN-form create options passed to {@link provider}. */
  readonly create?: SandboxCreateOptions;
  /**
   * ADOPT form: which of the session's sandboxes to borrow. Omitted, the
   * session's active sandbox is used — its `"primary"`, or the sole one.
   */
  readonly sandboxId?: string;
}

export function sandboxHost(config: SandboxHostConfig = {}): RuntimeProvider {
  const { provider, create, sandboxId, ...hostConfig } = config;
  return {
    // The host engine's caps — the SAME jailed or not, so this reports them
    // without touching the sandbox: no installer, no provider.create, no spawn.
    capabilities: () => hostCapabilities(detectEngine(), hostConfig.language),
    resolve: async (installer): Promise<Runtime> => {
      if (provider !== undefined) {
        return own(provider, create ?? {}, hostConfig, installer);
      }
      const placement = adopt(installer, sandboxId);
      // Borrow: the returned runtime disposes its own subprocesses and never
      // the jail, which withSandbox created and will destroy.
      return hostRuntime({ ...hostConfig, host: sandboxHostPort(placement) }).resolve(installer);
    },
  };
}

async function own(
  provider: SandboxProvider,
  create: SandboxCreateOptions,
  hostConfig: Omit<HostRuntimeConfig, "host">,
  installer: SessionInstaller,
): Promise<Runtime> {
  const handle = await provider.create(create);
  let inner: Runtime;
  try {
    inner = await hostRuntime({ ...hostConfig, host: sandboxHostPort(handle) }).resolve(installer);
  } catch (cause) {
    await handle.destroy().catch(() => undefined);
    throw cause;
  }
  return {
    capabilities: inner.capabilities,
    createContext: (options) => inner.createContext(options),
    dispose: async () => {
      await inner.dispose();
      await handle.destroy();
    },
  };
}

function adopt(installer: SessionInstaller, sandboxId: string | undefined): SandboxPlacement {
  const sandbox = activeSandbox(installer.getNamespace<SandboxBridge>("sandbox"), sandboxId);
  if (sandbox === undefined) {
    throw new Error(
      sandboxId === undefined
        ? "sandboxHost() adopts the session's sandbox, but none is mounted — " +
            "add a `sandbox:` slot, or pass sandboxHost({ provider }) to own one."
        : `sandboxHost() found no sandbox "${sandboxId}" mounted in the session.`,
    );
  }
  return sandbox.placement;
}
