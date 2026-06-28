/**
 * Module augmentation — registers prompts slots on spec interfaces.
 *
 *   1. `HookBridges.prompts`              → full `PromptsHarnessProtocol`
 *   2. `SessionHarnessProtocol.prompts`   → curated `PromptsHandle`
 *
 * Loaded as side effect when anything imports from
 * `@agentick/prompts-next` (per ADR 27).
 */

import type { PromptsHarnessProtocol } from "@agentick/spec-next";
import type { PromptsHandle } from "./handle.js";

declare module "@agentick/spec-next" {
  interface HookBridges {
    readonly prompts: PromptsHarnessProtocol;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SessionHarnessProtocol<P> {
    /** The session's prompts library — register, invoke, get. */
    readonly prompts: PromptsHandle;
  }
}
