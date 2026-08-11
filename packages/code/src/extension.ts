/**
 * `withCode()` — the install form for the {@link CodeHarness}.
 *
 * Two ways in, one type:
 *
 *   - `createApp({ code: defineCode({ runtime }) })` — the top-level SLOT
 *     (ADR 93), lit by this package's `augment.ts`. The normal path.
 *   - `extensions: [withCode({ runtime })]` — the dynamic escape hatch
 *     (a runtime chosen at boot, conditional composition). An explicit entry
 *     OVERRIDES the slot: extensions run after the slot-minted install and
 *     namespace registration is last-writer-wins.
 *
 * Both take the same {@link CodeConfig} — the ADR-42 dichotomy: a definition
 * (`{ runtime }`), or a live `Code` instance whose lifecycle the adopter owns
 * (so it is NOT closed on session close).
 *
 * Session-scoped, because a context's bindings, workspace and teardown are:
 * the harness closes with the session and disposes every context it opened
 * plus the runtime itself.
 *
 * @see ./augment.ts — the top-level slot registration
 * @see docs/proposals/v2/code.md
 */

import { inheritedFrom } from "@agentick/runtime";
import type { SessionExtension, SessionInstaller } from "@agentick/spec";

import { isCodeInstance, type Code } from "./contract.js";
import { CodeHarness } from "./harness.js";
import type { CodeConfig, CodeDefinition } from "./definition.js";

/**
 * FLAT options — `withCode({ runtime })`, never `withCode({ config: {...} })`.
 * An alias of the definition rather than a parallel shape: there is one bag.
 */
export type WithCodeOptions = CodeDefinition;

export const EXTENSION_NAME = "@agentick/code";

export function withCode(config: CodeConfig): SessionExtension {
  return {
    name: EXTENSION_NAME,
    target: "session",
    install: async (installer: SessionInstaller) => {
      // Live-instance arm: we do not close what we did not open — so what gets
      // registered is a FACADE, not the instance.
      if (isCodeInstance(config)) {
        installer.registerNamespace("code", adopted(config));
        return;
      }

      // ADR 93 landmine 11 — `code:execute` IS an op, and the cascade must be
      // total: an `app.guard()` that vetoes model-authored code, or an audit
      // hook that records it, has to reach this harness.
      const harness = new CodeHarness(
        `${installer.hostId}:code`,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
        {
          parentScope: { sessionId: installer.sessionId },
          ...inheritedFrom(installer),
          runtime: config.runtime,
        },
      );
      await harness.ready;

      installer.registerNamespace("code", harness);
      installer.onClose(() => harness.close());
    },
  };
}

/**
 * An adopter-owned `Code` wrapped so session teardown cannot end it.
 *
 * The session's close fold walks every bridge and calls `close()` on anything
 * that has one — which is right for the harnesses it built, and fatal for one
 * it did not: registering the bare instance means the FIRST session to close
 * disposes a runtime the adopter intended to share across many. The facade
 * delegates the whole surface and answers `close()` honestly-idle, so the
 * sweep gets its promise and the instance keeps running.
 */
function adopted(instance: Code): Code {
  return {
    get id() {
      return instance.id;
    },
    get ready() {
      return instance.ready;
    },
    get fx() {
      return instance.fx;
    },
    /** No-op by design: the adopter owns this instance's lifecycle. */
    close: () => Promise.resolve(),
    hasRuntime: () => instance.hasRuntime(),
    capabilities: () => instance.capabilities(),
    createContext: (options) => instance.createContext(options),
    run: (source, options) => instance.run(source, options),
  };
}
