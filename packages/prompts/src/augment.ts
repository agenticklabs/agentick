/**
 * Module augmentation — registers prompts slots on spec interfaces.
 *
 *   1. `HookBridges.prompts`              → full `PromptsHarnessProtocol`
 *   2. `SessionHarnessProtocol.prompts`   → curated `PromptsHandle`
 *
 * Loaded as side effect when anything imports from
 * `@agentick/prompts` (per ADR 27).
 */

import type { Prompts } from "@agentick/spec";
import type { PromptsHandle } from "./handle.js";

// The `prompts/*` WireMethods rows live in the type-only `./wire-augment.ts`
// (split so the `/client` subpath can type the wire without loading this
// server augment). Re-imported here for its side effect so importing
// `@agentick/prompts` still contributes the rows.
import "./wire-augment.js";

declare module "@agentick/spec" {
  interface HookBridges {
    /**
     * Present when `withPrompts` is installed; consumers must check
     * before use. Optional per ADR 27 §"Built-ins are bundled, not
     * privileged" — the compiler iterates `HookBridges` generically
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
