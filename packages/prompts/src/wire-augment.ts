/**
 * Wire-method augmentation — adds the prompts rows to the spec `WireMethods`
 * seed. Split out from the server-side {@link ./augment.ts} (which augments the
 * `HookBridges` + `SessionHarnessProtocol` slots) because the CLIENT subpath
 * needs `prompts/*` typed WITHOUT loading the server augmentations — the prompts
 * `/client` handle issues `client.transport.request("prompts/list", …)` etc.
 *
 * Pure type-only augmentation (zero runtime), so a browser bundle importing it
 * as a side effect pulls no server code. MUST carry a top-level `import`/`export`
 * (the `import type` below suffices) so this stays a MODULE that AUGMENTS
 * `@agentick/spec` rather than a script that SHADOWS it.
 *
 * The ratified `exposure: "wire"` prompt commands: `prompts/register` /
 * `prompts/update` / `prompts/remove` (mutations), `prompts/get` (declaration
 * read) / `prompts/list` / `prompts/render` / `prompts/invoke`, plus the
 * `prompts/commands` discovery meta-verb. Routing is the generic dynamic-command
 * lane — no per-verb gateway plumbing.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 * @see docs/proposals/v2/blueprint/87-client-sub-handles.md
 */

import type { CommandInfo, PromptDeclarationRecord } from "@agentick/spec";

/**
 * One page of `prompts/list` — MCP-shaped (named collection key + `nextCursor`),
 * the same envelope `resources/list` serves. The in-process `PromptsHarness.list()`
 * stays an unpaginated bounded snapshot; paging is a WIRE concern, so the envelope
 * exists only here and on the `prompts:list` command it routes to.
 */
export interface PromptsListResult {
  readonly prompts: readonly PromptDeclarationRecord[];
  /** Opaque cursor for the next page; absent on the last page. */
  readonly nextCursor?: string;
}

/** The `prompts:list` command input — `cursor` is optional-ABSENT, never `undefined`. */
export interface PromptsListInput {
  readonly cursor?: string;
}

declare module "@agentick/spec" {
  interface WireMethods {
    "prompts/register": { params: { sessionId: string; [key: string]: unknown }; result: unknown };
    "prompts/update": { params: { sessionId: string; [key: string]: unknown }; result: unknown };
    // The handler reads `PromptsRemoveInput` (`{ name }`) — the wire key is `name`.
    "prompts/remove": { params: { sessionId: string; name: string }; result: unknown };
    /** Declaration read by name (wire-safe record — no `template`/`render` fns); `null` on miss. */
    "prompts/get": {
      params: { sessionId: string; name: string };
      result: PromptDeclarationRecord | null;
    };
    /**
     * Declarations as wire-safe records (name-sorted), one page at a time. Pass
     * the previous reply's `nextCursor` to continue.
     */
    "prompts/list": {
      params: { sessionId: string; cursor?: string };
      result: PromptsListResult;
    };
    /** Render a prompt to messages WITHOUT queueing (the MCP `prompts/get` analog). */
    "prompts/render": { params: { sessionId: string; [key: string]: unknown }; result: unknown };
    "prompts/invoke": { params: { sessionId: string; [key: string]: unknown }; result: unknown };
    "prompts/commands": {
      params: { sessionId: string };
      result: { commands: readonly CommandInfo[] };
    };
  }
}
