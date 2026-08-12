/**
 * `withSandbox()` — the install form for the sandbox surface.
 *
 * Two ways in, one type (a {@link SandboxDefinition}):
 *
 *   - `createApp({ sandbox: defineSandbox({ provider }) })` — the top-level
 *     SLOT (ADR 93), lit by this package's `augment.ts`. The normal path.
 *   - `extensions: [withSandbox({ provider })]` — the dynamic escape hatch. An
 *     explicit entry OVERRIDES the slot (namespace registration is
 *     last-writer-wins).
 *
 * Session-scoped, because the jail is per conversation: the bridge is wired to
 * the session's substrate so its ops journal alongside everything else, and the
 * auto-spun `"primary"` sandbox is created with the session's elicitation
 * harness (its permission gate) and torn down on session close. Whether a
 * `<Sandbox>` is also mounted in the tree is irrelevant — the bridge is ready.
 *
 * @see ./augment.ts — the top-level slot registration
 * @see docs/proposals/v2/blueprint/24-sandbox-as-harness.md
 */

import { omitUndefined } from "@agentick/utils";
import type { SessionExtension, SessionInstaller } from "@agentick/spec";

import { createSandboxBridge } from "./bridge.js";
import { aclOf, toCreateOptions } from "./create-options.js";
import type { SandboxDefinition } from "./definition.js";

export const EXTENSION_NAME = "@agentick/sandbox";

export function withSandbox(definition: SandboxDefinition = {}): SessionExtension {
  return {
    name: EXTENSION_NAME,
    target: "session",
    install: async (installer: SessionInstaller) => {
      const bridge = createSandboxBridge({ substrate: installer.substrate });
      installer.registerNamespace("sandbox", bridge);

      const { provider } = definition;
      if (!provider) return;

      const id = definition.id ?? "primary";
      await bridge.createHarness({
        sandboxId: id,
        provider,
        options: toCreateOptions(definition),
        elicitation: installer.elicitation,
        ...omitUndefined({
          acl: aclOf(definition.allow),
          permissionTimeoutDecision: definition.onPermissionTimeout,
          permissionTimeoutMs: definition.permissionTimeoutMs,
        }),
      });

      installer.onClose(async () => {
        const harness = bridge.get(id);
        if (!harness) return;
        await harness.destroy();
        bridge.unregister(id);
      });
    },
  };
}
