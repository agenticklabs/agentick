/**
 * Module augmentation — registers prompts slots on spec interfaces.
 *
 *   1. `HookBridges.prompts`              → full `PromptsHarnessProtocol`
 *   2. `SessionHarnessProtocol.prompts`   → curated `PromptsHandle`
 *
 * Loaded as side effect when anything imports from
 * `@agentick/prompts-next` (per ADR 27).
 */

import type { Prompts } from "@agentick/spec-next";
import type { PromptsHandle } from "./handle.js";

declare module "@agentick/spec-next" {
  interface HookBridges {
    /**
     * Present when `withPrompts` is installed; consumers must check
     * before use. Optional per ADR 27 §"Built-ins are bundled, not
     * privileged" — the reconciler iterates `HookBridges` generically
     * via feature detection, so absence is a valid state.
     */
    readonly prompts?: Prompts;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /**
     * The session's prompts library — register, invoke, get. Present
     * only when `withPrompts` is installed on the session; consumers
     * must check before use. Optional per ADR 27 §"Built-ins are
     * bundled, not privileged".
     */
    readonly prompts?: PromptsHandle;
  }
}
