import type { CommandInfo } from "@agentick/spec-next";
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

// ADR 51 slice 5 (#141) — prompt CRUD + get (MCP prompts/get analog) +
// invoke (prompt-driven input, same-principal rule applies).
declare module "@agentick/spec-next" {
  interface WireMethods {
    "prompts/register": { params: { sessionId: string; [key: string]: unknown }; result: unknown };
    "prompts/update": { params: { sessionId: string; [key: string]: unknown }; result: unknown };
    "prompts/remove": { params: { sessionId: string; id: string }; result: unknown };
    "prompts/get": { params: { sessionId: string; id: string }; result: unknown };
    "prompts/invoke": { params: { sessionId: string; [key: string]: unknown }; result: unknown };
    "prompts/commands": {
      params: { sessionId: string };
      result: { commands: readonly CommandInfo[] };
    };
  }
}
