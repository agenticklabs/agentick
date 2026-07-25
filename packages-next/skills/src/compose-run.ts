/**
 * `defaultComposeRun` — the framework's default `skills.run` composition
 * (three-audiences-plan §C).
 *
 * A skill run is a `session.send` primed with the skill's content. The default
 * composition is two messages:
 *
 *   1. a `system`-role message carrying the skill body + a short framing line
 *      (v2 has no structural `system` field — a `messages` entry with
 *      `role: "system"` is the path);
 *   2. a `user`-role message carrying the serialized `args` (JSON) or, when no
 *      args were supplied, an args-free instruction to proceed.
 *
 * `output` / `maxTicks` / `signal` pass straight through to the send; the
 * structured-output machinery (§B2) lives on the send path, not here.
 *
 * This is the DEFAULT — the `withSkills({ composeRun })` seam is the truth. An
 * adopter override fully owns composition (a different framing, tool
 * restriction once C2 lands, few-shot priming, …).
 */

import type { SendInput, SendMessageInput, Skill } from "@agentick/spec-next";
import type { SkillRunOptions } from "./handle.js";

/** Args-free run instruction — the user turn that drives generation when a
 *  skill takes no arguments (the skill body in the system message is the task). */
const ARGS_FREE_INSTRUCTION = "Follow the skill above and produce the result.";

export function defaultComposeRun(skill: Skill, opts: SkillRunOptions): SendInput {
  const framing = `You are running the "${skill.name}" skill. Follow its instructions to complete the task.`;
  const messages: SendMessageInput[] = [
    { role: "system", content: `${skill.content}\n\n${framing}` },
    {
      role: "user",
      content: opts.args !== undefined ? JSON.stringify(opts.args, null, 2) : ARGS_FREE_INSTRUCTION,
    },
  ];
  // C2 — thread the skill's tool allowlist into the send's per-execution
  // RESTRICTION seam (`SendInput.allowedTools`). When present, only these
  // canonical tool names reach the MODEL for this run; dispatch-door tools are
  // unaffected. The skill record is the ONLY source in C2 (no `opts`-level
  // override). Populated from Agent Skills `allowed-tools` frontmatter by the
  // Node loaders (E1 — `agentSkillsDirectory` / `fromFile` / `fromDirectory`).
  return {
    messages,
    ...(skill.allowedTools !== undefined ? { allowedTools: skill.allowedTools } : {}),
    ...(opts.output !== undefined ? { output: opts.output } : {}),
    ...(opts.maxTicks !== undefined ? { maxTicks: opts.maxTicks } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
}
