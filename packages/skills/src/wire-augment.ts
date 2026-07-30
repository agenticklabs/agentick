/**
 * Wire-method augmentation — adds the skills rows to the spec `WireMethods`
 * seed. Split out from the server-side {@link ./augment.ts} (which augments the
 * `HookBridges` + `SessionHarnessProtocol` slots) because the CLIENT subpath
 * needs `skills/*` typed WITHOUT loading the server augmentations — the skills
 * `/client` handle issues `client.transport.request("skills/list", …)` etc.
 *
 * Pure type-only augmentation (zero runtime), so a browser bundle importing it
 * as a side effect pulls no server code. MUST carry a top-level `import`/`export`
 * (the `import type` below suffices) so this stays a MODULE that AUGMENTS
 * `@agentick/spec` rather than a script that SHADOWS it.
 *
 * These are the ratified `exposure: "wire"` skill commands: `skills/register` /
 * `skills/update` / `skills/remove` (mutations), the G-prep read lane
 * `skills/list` / `skills/get` / `skills/search`, plus the `skills/commands`
 * discovery meta-verb. Routing is the generic dynamic-command lane — no per-verb
 * gateway plumbing.
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md
 * @see docs/proposals/v2/blueprint/87-client-sub-handles.md
 */

import type { CommandInfo, Skill, SkillsSearchInput } from "@agentick/spec";

/**
 * One page of `skills/list` — MCP-shaped (named collection key + `nextCursor`),
 * the same envelope `resources/list` serves. The in-process `SkillsHarness.list()`
 * stays an unpaginated bounded snapshot; paging is a WIRE concern, so the
 * envelope exists only here and on the `skills:list` command it routes to.
 */
export interface SkillsListResult {
  readonly skills: readonly Skill[];
  /** Opaque cursor for the next page; absent on the last page. */
  readonly nextCursor?: string;
}

/** The `skills:list` command input — `cursor` is optional-ABSENT, never `undefined`. */
export interface SkillsListInput {
  readonly cursor?: string;
}

declare module "@agentick/spec" {
  interface WireMethods {
    "skills/register": { params: { sessionId: string; [key: string]: unknown }; result: unknown };
    "skills/update": { params: { sessionId: string; [key: string]: unknown }; result: unknown };
    // The handler reads `SkillsRemoveInput` (`{ name }`) — the wire key is `name`.
    "skills/remove": { params: { sessionId: string; name: string }; result: unknown };
    /**
     * Enumerate skills (wire-safe records — `content` INCLUDED), one page at a
     * time. Pass the previous reply's `nextCursor` to continue.
     */
    "skills/list": {
      params: { sessionId: string; cursor?: string };
      result: SkillsListResult;
    };
    /** Read one skill by name; `null` on miss. */
    "skills/get": { params: { sessionId: string; name: string }; result: Skill | null };
    /** Substring + tag filter (mirrors `SkillsSearchInput`). */
    "skills/search": {
      params: { sessionId: string } & SkillsSearchInput;
      result: readonly Skill[];
    };
    "skills/commands": {
      params: { sessionId: string };
      result: { commands: readonly CommandInfo[] };
    };
  }
}
