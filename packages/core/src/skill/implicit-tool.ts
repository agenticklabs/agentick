/**
 * Implicit `skill` tool — the model-facing affordance for the Agent
 * Skills spec's stage-1 + stage-2 progressive disclosure.
 *
 * When an app's `SkillRegistry` is non-empty, sessions automatically
 * expose this tool. Its **description** lists every registered skill's
 * name + description (stage 1: discovery), and its **handler** loads the
 * full SKILL.md body (stage 2: activation) — substituting `$ARGUMENTS`
 * / `$N` / `$name` / `${VARS}` and returning the rendered text as the
 * tool result. The agent then follows those instructions in its current
 * context (no sub-agent / no submit tool).
 *
 * For the sub-execution model with typed results, callers use
 * `session.skill(skill, { args, result })` programmatically — that's a
 * different code path with its own executor.
 *
 * @module @agentick/core/skill/implicit-tool
 */

import { z } from "zod";
import { createTool } from "../tool/tool.js";
import type { ExecutableTool } from "../tool/tool.js";
import { substituteSkillVars } from "./substitute.js";
import { applyShellInjections } from "./shell-injection.js";
import type { SkillRegistry } from "./registry.js";

const MAX_LISTING_CHARS = 8000;

/**
 * Build the implicit skill tool for a session. Bundles the registry,
 * session-derived substitution vars (`AGENTICK_SESSION_ID`), and an
 * optional shell runner that handles `` !`cmd` `` injections in skill
 * bodies. The runner is typically `session.shell` so injections run in
 * the agent's sandbox.
 *
 * Rebuilt each compile tick so the description reflects the current
 * state of the registry.
 */
export function buildImplicitSkillTool(
  registry: SkillRegistry,
  vars: Record<string, string>,
  shell?: (cmd: string) => Promise<string>,
): ExecutableTool {
  const description = renderToolDescription(registry);

  return createTool({
    name: "skill",
    description,
    input: z.object({
      name: z.string().describe("The name of the skill to load."),
      args: z
        .union([z.record(z.string(), z.unknown()), z.string()])
        .optional()
        .describe(
          "Arguments substituted into the skill body. Pass an object for " +
            "named ($name) and positional ($0, $1) substitution; pass a string " +
            "for raw $ARGUMENTS / shell-tokenized positional access.",
        ),
    }),
    handler: async ({ name, args }) => {
      const skill = registry.get(name);
      if (!skill) {
        const known = registry
          .list()
          .map((s) => s.name)
          .join(", ");
        throw new Error(`Unknown skill: "${name}". Available skills: ${known || "(none)"}`);
      }
      const substituted = substituteSkillVars(skill.instructions, {
        args,
        argumentNames: skill.argumentNames,
        vars: {
          ...vars,
          ...(skill.skillDir ? { AGENTICK_SKILL_DIR: skill.skillDir } : {}),
        },
      });
      const body = shell ? await applyShellInjections(substituted, shell) : substituted;
      return [{ type: "text" as const, text: body }];
    },
  }) as unknown as ExecutableTool;
}

/**
 * Render the tool description with an inline listing of registered
 * skills. Truncated at {@link MAX_LISTING_CHARS} to bound prompt cost.
 */
function renderToolDescription(registry: SkillRegistry): string {
  const skills = registry.list();
  if (skills.length === 0) {
    return (
      "Load a skill's instructions into your context. " +
      "Pass the skill `name` (and optional `args`) to receive the skill's " +
      "rendered body as the tool result. (No skills are currently registered.)"
    );
  }

  let listing = "";
  let truncated = 0;
  for (const skill of skills) {
    const line = `- ${skill.name}: ${skill.description}\n`;
    if (listing.length + line.length > MAX_LISTING_CHARS) {
      truncated = skills.length - skills.indexOf(skill);
      break;
    }
    listing += line;
  }
  if (truncated > 0) {
    listing += `… (${truncated} more skill(s) omitted to fit the listing budget; ask the user to narrow the request if the right one isn't shown)\n`;
  }

  return (
    "Load a skill's instructions into your context. Pass the skill `name` " +
    "(and optional `args`) to receive the skill's rendered body. After " +
    "calling, follow the instructions in the result.\n\n" +
    `Available skills:\n${listing}`
  );
}
