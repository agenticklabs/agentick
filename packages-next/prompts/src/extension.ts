/**
 * `withPrompts()` — `SessionExtension` factory.
 *
 * Constructs a {@link PromptsHarness} per-session at session install
 * time, wired to the session's substrate. Adopters pass renderers
 * for framework-specific content (e.g., `reactPromptRenderer` from
 * `@agentick/prompts-react-next`); `string` and `MessageEntry[]`
 * content shapes work natively in core without any renderer.
 *
 * For single-framework adopters, prefer the framework binding's
 * convenience extension (e.g., `withReactPrompts`) which pre-bakes
 * the renderer.
 *
 * @see docs/proposals/v2/blueprint/32-extension-shape-spectrum.md
 */

import type { PromptsRegisterInput, SessionExtension, SessionInstaller } from "@agentick/spec-next";

import { PromptsHarness } from "./harness.js";
import type { PromptRenderer } from "./renderer.js";

export interface WithPromptsOptions {
  /**
   * Initial prompts seeded at session construction. Each entry is a
   * full `PromptDeclaration` wrapped in the register input. Useful for
   * shipping bundled prompts or restore-from-snapshot at startup.
   */
  readonly initial?: readonly PromptsRegisterInput[];
  /**
   * Renderers handling non-native content shapes. First-match-wins on
   * `renderer.handles(content)`. Framework bindings ship their own.
   */
  readonly renderers?: readonly PromptRenderer[];
}

export function withPrompts(options: WithPromptsOptions = {}): SessionExtension {
  return {
    name: "@agentick/prompts-next",
    target: "session",
    install: async (installer: SessionInstaller) => {
      // Read the session's timeline harness if available — `invoke()`
      // uses it to queue messages into the durable timeline. When
      // absent (e.g., test setup), `invoke()` skips queueing.
      const timeline = (installer.getNamespace?.("timeline") ?? undefined) as
        | import("@agentick/spec-next").TimelineHarnessProtocol
        | undefined;

      const harness = new PromptsHarness(
        `${installer.hostId}:prompts`,
        installer.substrate.journal,
        installer.substrate.bus,
        installer.substrate.inbox,
        {
          ...(options.renderers ? { renderers: options.renderers } : {}),
          ...(timeline ? { timeline } : {}),
        },
      );
      await harness.ready;

      if (options.initial && options.initial.length > 0) {
        for (const decl of options.initial) {
          await harness.register(decl);
        }
      }

      installer.registerNamespace("prompts", harness);
      installer.onClose(() => harness.close());
    },
  };
}
