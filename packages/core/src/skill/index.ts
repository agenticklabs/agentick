/**
 * Skill exports.
 */
export {
  defineSkill,
  validateSkillName,
  SKILL_NAME_REGEX,
  SKILL_NAME_MAX,
  SKILL_DESCRIPTION_MAX,
  SKILL_COMPATIBILITY_MAX,
  type SkillDef,
} from "./skill.js";
export { loadSkill, parseSkill, type LoadSkillOptions } from "./loader.js";
export { parseFrontmatter, type ParsedFrontmatter } from "./frontmatter.js";
export { SkillRegistry, type SkillSearchQuery } from "./registry.js";
export {
  substituteSkillVars,
  templateUsesArguments,
  type SubstituteOptions,
} from "./substitute.js";
export {
  findShellInjections,
  bodyHasShellInjections,
  applyShellInjections,
  type ShellInjection,
} from "./shell-injection.js";
