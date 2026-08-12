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
import type { SandboxPlacement } from "@agentick/sandbox";
import type { HostProcessPort } from "./host-process-port.js";

/**
 * Place the runtime's children inside `place`.
 *
 * ```ts
 * const sandbox = await localProvider().create({ workspace: true });
 * const runtime = hostRuntime({ host: sandboxHostPort(sandbox) });
 * ```
 *
 * Takes a {@link SandboxPlacement} rather than a whole handle, which is all
 * this needs and all a caller should have to hand over — a session's live
 * sandbox is borrowed as `harness.placement`, so putting a child in someone
 * else's jail never comes with the power to destroy it. A `SandboxHandle`
 * satisfies it directly.
 *
 * Throws {@link SandboxUnsupportedError} when the provider has no live-process
 * surface — at wiring time, rather than mid-conversation on the first program.
 * Whether the sandbox actually confines anything is the provider's claim to
 * make: `@agentick/sandbox-local` reports it on `isolation`.
 */
export function sandboxHostPort(place: SandboxPlacement): HostProcessPort {
  if (place.spawn === undefined) {
    throw new SandboxUnsupportedError({ capability: "spawn" });
  }
  const spawn = place.spawn.bind(place);

  return {
    spawn: (request) =>
      spawn({
        command: request.command,
        args: request.args,
        env: request.env,
        cwd: request.cwd ?? place.workspacePath,
        ...(request.readablePaths === undefined ? {} : { readablePaths: request.readablePaths }),
      }),
  };
}
