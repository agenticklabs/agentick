/**
 * Model-facing `skill_*` tools — auto-registered by {@link withSkills}
 * (default-on, opt-outable via `registerModelTools: false`).
 *
 * **Progressive disclosure (the Claude Code pattern).** Skills are
 * durable, reusable capability documents the application curates. Rather
 * than dumping every skill's full body into the prompt, the model
 * DISCOVERS what exists and reads one on demand:
 *
 *   - `skill_list` — enumerate the available skills (name + one-line
 *     description + tags). Cheap; surfaces the catalog so the model can
 *     decide what it needs.
 *   - `skill_read` — resolve one skill by `name` to its full content
 *     (the skill document) plus its description/tags.
 *
 * **Naming: `<harness-noun>_<verb>`** (three-audiences-plan §D). The
 * skills harness owns the `skill` noun; its tools sort together under it
 * in the model's list — `skill_list`, `skill_read`. Singular noun per the
 * law even though the wire namespace stays `skills:*` (a separate
 * contract). Underscore-separated for cross-provider tool-name safety.
 *
 * Both handlers reach the session's {@link Skills} instance via
 * `ctx.skills` — the augmented, dispatch-resolved ctx slot (ADR 66) that
 * the AppHarness fills from the same bridge `withSkills` registered under
 * the session's `skills` namespace. When no skills harness is mounted
 * (substrate-stripped fixtures, or `withSkills` absent), the handlers
 * degrade honestly (`skill_list` → empty; `skill_read` → a typed
 * "unavailable" text block).
 *
 * @see docs/proposals/v2/blueprint/27-modular-built-ins.md (§Model tools)
 * @see docs/proposals/v2/blueprint/66-tool-dependency-resolution.md
 */

import { jsonSchema, toRegistration } from "@agentick/spec-next";
import type {
  ContentBlock,
  Skill,
  ToolDeclaration,
  ToolHandler,
  ToolHandlerCtx,
  ToolRegistration,
} from "@agentick/spec-next";

import { EXTENSION_NAME } from "./extension-name.js";

// ============================================================================
// Tool names
// ============================================================================

export const SKILL_LIST = "skill_list";
export const SKILL_READ = "skill_read";

/**
 * Handler-ref namespace. Includes the sessionId so cross-session
 * registrations on the shared HandlerResolver don't collide — same
 * pattern as `resources` / `withMCP` / `withTasks`.
 */
function handlerRefFor(sessionId: string, suffix: string): string {
  return `@agentick/skills-next:${sessionId}:${suffix}`;
}

// ============================================================================
// Tool declarations
// ============================================================================

function listDeclaration(handlerRef: string): ToolDeclaration {
  return {
    id: SKILL_LIST,
    name: SKILL_LIST,
    description:
      "List the skills available to you — reusable capability documents the " +
      "application curates (recipes, playbooks, domain guides). Returns " +
      "`{ skills: Array<{ name, description, tags? }> }`. Skills are guidance " +
      "you read and apply; discover what exists here, then pull one by name " +
      "with `skill_read` when you need its full instructions.",
    inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
    exposure: ["model", "dispatch"],
    handlerRef,
  };
}

function readDeclaration(handlerRef: string): ToolDeclaration {
  return {
    id: SKILL_READ,
    name: SKILL_READ,
    description:
      "Read one skill's full content by its `name` (discover names with " +
      "`skill_list`). Returns `{ name, description, content, tags? }` — the " +
      "`content` is the skill's complete document. Returns " +
      "`{ error: 'skill_not_found', name }` if no skill by that name is " +
      "registered.",
    inputSchema: jsonSchema({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    }),
    exposure: ["model", "dispatch"],
    handlerRef,
  };
}

// ============================================================================
// Handlers
// ============================================================================

function jsonBlock(payload: unknown): readonly ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(payload) } as ContentBlock];
}

/** Trim a skill record to the model-facing summary shape (no content). */
function summarizeSkill(s: Skill): Record<string, unknown> {
  return {
    name: s.name,
    description: s.description,
    ...(s.tags !== undefined && s.tags.length > 0 ? { tags: s.tags } : {}),
  };
}

const listHandler: ToolHandler = async (_input, { ctx }) => {
  const skills = (ctx as ToolHandlerCtx).skills;
  if (skills === undefined) return jsonBlock({ skills: [] });
  return jsonBlock({ skills: skills.list().map(summarizeSkill) });
};

const readHandler: ToolHandler = async (input, { ctx }) => {
  const skills = (ctx as ToolHandlerCtx).skills;
  const { name } = input as { readonly name: string };
  if (skills === undefined) {
    return jsonBlock({ error: "skills_unavailable", name });
  }
  // A model guessing a name it didn't see in `skill_list` is a DOMAIN
  // case, not a programming error — degrade honestly rather than throwing
  // the must-exist `SkillNotFound` (which `require()` reserves for
  // adopter code). Registered-only lookup: `skill_list` is the catalog
  // the model reads from.
  const skill = skills.get(name);
  if (skill === undefined) {
    return jsonBlock({ error: "skill_not_found", name });
  }
  return jsonBlock({
    name: skill.name,
    description: skill.description,
    content: skill.content,
    ...(skill.tags !== undefined && skill.tags.length > 0 ? { tags: skill.tags } : {}),
  });
};

// ============================================================================
// Bundle
// ============================================================================

export interface SkillsToolsBundle {
  readonly registrations: readonly ToolRegistration[];
  readonly handlers: ReadonlyArray<{
    readonly handlerRef: string;
    readonly handler: ToolHandler;
  }>;
}

/**
 * Build the `skill_list` + `skill_read` tool registrations + their
 * handlers, scoped to a single session. Returned as a bundle so
 * {@link withSkills} registers both surfaces in lockstep — mirrors
 * `buildResourcesTools`.
 */
export function buildSkillsTools(sessionId: string): SkillsToolsBundle {
  const listRef = handlerRefFor(sessionId, "list");
  const readRef = handlerRefFor(sessionId, "read");

  const binding = {
    scope: "extension",
    extensionName: EXTENSION_NAME,
    level: "session",
  } as const;

  return {
    registrations: [
      toRegistration(listDeclaration(listRef), binding),
      toRegistration(readDeclaration(readRef), binding),
    ],
    handlers: [
      { handlerRef: listRef, handler: listHandler },
      { handlerRef: readRef, handler: readHandler },
    ],
  };
}
