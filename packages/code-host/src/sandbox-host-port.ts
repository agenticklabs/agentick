/**
 * `sandboxHostPort` — placement inside a sandbox.
 *
 * The default placement is a child of the host app, which is the app's own
 * uid: `fetch` reaches the internet and `node:fs` reaches the home directory.
 * This one puts the same supervisor inside whatever jail the provider
 * implements, so what the model's code can reach is what the sandbox allows.
 *
 * The adapter is thin on purpose. `SandboxHandle.spawn` was shaped to the
 * four streams a supervised child needs, so placement here is a request
 * mapping and nothing else — the protocol, the framing and the bindings are
 * untouched by where the process runs.
 *
 * @see ./host-process-port.ts — the seam this fills
 */

import { SandboxUnsupportedError } from "@agentick/sandbox";
import type { SandboxHandle } from "@agentick/sandbox";
import type { HostProcessPort } from "./host-process-port.js";

/**
 * Place the runtime's children inside `handle`.
 *
 * ```ts
 * const sandbox = await localProvider().create({ workspace: true });
 * const runtime = hostRuntime({ host: sandboxHostPort(sandbox) });
 * ```
 *
 * Throws {@link SandboxUnsupportedError} when the provider has no live-process
 * surface — at wiring time, rather than mid-conversation on the first program.
 * Whether the sandbox actually confines anything is the provider's claim to
 * make: `@agentick/sandbox-local` reports it on `isolation`.
 */
export function sandboxHostPort(handle: SandboxHandle): HostProcessPort {
  if (handle.spawn === undefined) {
    throw new SandboxUnsupportedError({ capability: "spawn" });
  }
  const spawn = handle.spawn.bind(handle);

  return {
    spawn: (request) =>
      spawn({
        command: request.command,
        args: request.args,
        env: request.env,
        cwd: request.cwd ?? handle.workspacePath,
        ...(request.readablePaths === undefined ? {} : { readablePaths: request.readablePaths }),
      }),
  };
}
