/**
 * Skill — scoped sub-agent invocations with caller-typed results.
 *
 * Aligns with the [Agent Skills](https://agentskills.io) open standard
 * (the cross-tool spec) and the Claude Code [skills extension](https://code.claude.com/docs/en/skills)
 * (substitution, invocation control, runtime hints). A skill is a folder
 * containing `SKILL.md` with YAML frontmatter + markdown instructions,
 * optionally bundled with supporting files.
 *
 * Canonical directory layout (Agent Skills spec):
 *   my-skill/
 *   ├── SKILL.md          # required: metadata + instructions
 *   ├── scripts/          # optional: executable code
 *   ├── references/       # optional: documentation files loaded on demand
 *   ├── assets/           # optional: templates, images, data files
 *   └── ...               # any additional files
 *
 * Reference these subdirectories from SKILL.md by relative path; agents
 * load them lazily when the body says to.
 *
 * Frontmatter — Agent Skills core (open spec):
 *   - name (required, strict format, must match parent dir)
 *   - description (required, ≤1024 chars)
 *   - license (optional)
 *   - compatibility (optional, ≤500 chars)
 *   - metadata (optional, key/value)
 *   - allowed-tools (optional, experimental)
 *
 * Frontmatter — Claude Code extensions (recognized as additions):
 *   - when_to_use, argument-hint, arguments
 *   - disable-model-invocation, user-invocable
 *   - (reserved, not parsed: model, effort, context, agent, hooks, paths, shell)
 *
 * Our extensions over the spec:
 *   - Programmatic invocation: `session.skill(skill, { args, result? })`
 *   - Caller-typed `result` schema (structured outputs at call time)
 *   - The skill is invocation-shape-agnostic — same file can be invoked
 *     from chat (text args) or from code (typed object args)
 *
 * Substitution syntax follows the Claude Code spec — `$ARGUMENTS`, `$N`,
 * `$name`, `${VARS}`. See `./substitute.ts`. Shell injections (`` !`cmd` ``
 * and ``` ```! ``` blocks) handled in `./shell-injection.ts`.
 *
 * ──────────────────────────────────────────────────────────────────────
 * TODO(claude-code-reserved-fields): The following Claude Code skill
 * frontmatter fields are NOT yet acted on. They're parsed (or could be)
 * but currently ignored at runtime. Each is a separate phase of work:
 *
 *   - `model` — per-skill model override. Implementation: when running a
 *     skill, swap the session's default model for the skill's model for
 *     the duration of the call. Spans `session.skill()` (typed-result
 *     path) and the implicit-tool's load-into-context path (which
 *     doesn't currently swap models — could append a model switch
 *     directive to the body, or fork).
 *
 *   - `effort` — Claude-specific effort level (low/medium/high/xhigh/max).
 *     Maps to provider-specific knobs. Adapter-level concern; needs an
 *     "effort" abstraction at the EngineModel layer first.
 *
 *   - `context: fork` + `agent` — run the skill in a forked subagent
 *     context with a specified agent type. Couples to Phase 4 (`fork()`)
 *     and the broader subagent surface. Today, programmatic
 *     `session.skill()` already runs as a sub-execution; `context: fork`
 *     would make this the implicit-tool's behavior too (vs the current
 *     load-into-context model).
 *
 *   - `hooks` — skill-scoped lifecycle hooks (startup/teardown/etc). Maps
 *     to existing kernel/engine hook surface; needs scope-binding so
 *     hooks declared in a skill only fire while that skill is active.
 *
 *   - `paths` — glob patterns that auto-activate the skill when working
 *     with matching files. A discovery/auto-suggest concern; lives at
 *     the registry layer, not on `SkillDef` semantics.
 *
 *   - `shell: bash | powershell` — alternate shell for `` !`cmd` ``
 *     execution. Currently we always route through `session.shell` →
 *     the registered Bash tool. Adding PowerShell support is a sandbox
 *     adapter concern.
 *
 * Plus: `disableSkillShellExecution` (managed-settings opt-out for `!`
 * blocks) — would gate `applyShellInjections` at the session/app level.
 *
 * Add fields to `SkillDef` and the loader's frontmatter parser as each
 * phase lands. Until then, these fields parse to `undefined` and are
 * silently ignored.
 * ──────────────────────────────────────────────────────────────────────
 *
 * @module @agentick/core/skill
 */

import type { ExecutableTool, ZodSchema } from "../tool/tool.js";

// ============================================================================
// SkillDef
// ============================================================================

/**
 * Definition of a callable skill. Mirrors the Agent Skills frontmatter
 * spec, with optional Agentick-specific extensions.
 *
 * @typeParam TInput - Type of the args object. Defaults to `unknown`
 *   for skills loaded from files where the input shape isn't declared.
 */
export interface SkillDef<TInput = unknown> {
  // ── Identity (Agent Skills spec, required) ───────────────────────────
  /**
   * Skill name. **Strict spec format**: 1–64 characters, lowercase
   * alphanumeric and hyphens only, no leading/trailing or consecutive
   * hyphens. For folder-loaded skills must match the parent directory
   * name (validated by the loader).
   *
   * Examples: `pdf-processing`, `code-review`, `triage-issues`.
   * Invalid: `PDF-Processing`, `pdf--processing`, `-pdf`, `pdf_proc`.
   */
  readonly name: string;

  /**
   * What the skill does and when to use it. **Required** by the open
   * Agent Skills spec (and by `defineSkill`). ≤1024 characters. Surfaced
   * to the model in skill listings to help it decide when to apply the
   * skill automatically.
   */
  readonly description: string;

  // ── Metadata (Agent Skills spec, optional) ───────────────────────────
  /**
   * License applied to the skill. Spec recommends keeping it short — the
   * name of a license, or the name of a bundled license file
   * (e.g. `Apache-2.0`, `Proprietary. LICENSE.txt has complete terms`).
   */
  readonly license?: string;

  /**
   * Environment requirements (intended product, system packages, network
   * access, etc.). ≤500 chars. Most skills omit this.
   *
   * Example: `Requires git, docker, jq, and access to the internet`.
   */
  readonly compatibility?: string;

  /**
   * Arbitrary metadata mapping (string keys to string values, per spec).
   * Use for additional properties not covered by the standard fields.
   * Reasonably-unique keys avoid collisions across tools.
   *
   * Example:
   * ```yaml
   * metadata:
   *   author: example-org
   *   version: "1.0"
   * ```
   */
  readonly metadata?: Record<string, string>;

  // ── Claude Code extensions (recognized as supplementary fields) ──────
  /**
   * Additional invocation hints — example phrases / triggers. Appended to
   * `description` for selection. Claude Code extension (`when_to_use`).
   */
  readonly whenToUse?: string;

  /**
   * Hint shown during autocomplete to indicate expected arguments
   * (e.g. `[issue-number]`). Claude Code extension (`argument-hint`).
   */
  readonly argumentHint?: string;

  // ── Body ─────────────────────────────────────────────────────────────
  /**
   * Skill instructions — the markdown body of `SKILL.md`. May contain
   * `$ARGUMENTS`, `$N`, `$name`, `${VARS}` substitutions resolved at
   * invocation time.
   */
  readonly instructions: string;

  // ── Args ─────────────────────────────────────────────────────────────
  /**
   * Optional Zod schema for the args object. Validated at invocation if
   * provided. Omit to accept any args.
   */
  readonly input?: ZodSchema<TInput>;

  /**
   * Names of positional arguments, in order. From the spec's `arguments`
   * frontmatter field. Enables `$0`/`$1`/... and `$name` substitution.
   *
   * For typed object args, the values at these names are looked up by
   * key; the order also defines positional access (`$0` = first, etc.).
   */
  readonly argumentNames?: string[];

  // ── Tools ────────────────────────────────────────────────────────────
  /**
   * Tools the skill is allowed to use during execution. Maps to spec
   * field `allowed-tools`. String entries are tool names resolved against
   * the session's tool registry at execution time; ExecutableTool entries
   * are used directly.
   */
  readonly allowedTools?: (ExecutableTool | string)[];

  // ── Invocation gating (captured but enforcement is later phases) ─────
  /**
   * When true, the model cannot auto-invoke this skill — only explicit
   * programmatic / user invocation. Maps to `disable-model-invocation`.
   * NOTE: captured but not enforced in Phase 2; gating belongs with the
   * skill registry (Phase 3+).
   */
  readonly disableModelInvocation?: boolean;

  /**
   * When false, the skill is hidden from user-facing listings. Maps to
   * `user-invocable`. Captured; enforcement is registry-side (later).
   */
  readonly userInvocable?: boolean;

  // ── Execution ────────────────────────────────────────────────────────
  /**
   * Maximum ticks the skill loop may run. Default 10.
   */
  readonly maxTicks?: number;

  // ── Filesystem / supporting files ────────────────────────────────────
  /**
   * Absolute path to the directory containing `SKILL.md`. Set by the
   * loader; supports `${AGENTICK_SKILL_DIR}` substitution and lets skill
   * authors reference supporting files (templates, examples, scripts) in
   * the same directory.
   */
  readonly skillDir?: string;
}

/**
 * Strict Agent Skills name format: 1–64 chars, lowercase alphanumeric and
 * hyphens only, no leading/trailing hyphens, no consecutive hyphens.
 *
 * @see https://agentskills.io/specification#name-field
 */
export const SKILL_NAME_REGEX = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/;

/** Spec cap on `description` length. */
export const SKILL_DESCRIPTION_MAX = 1024;
/** Spec cap on `compatibility` length. */
export const SKILL_COMPATIBILITY_MAX = 500;
/** Spec cap on `name` length. */
export const SKILL_NAME_MAX = 64;

/**
 * Validate a skill name against the open Agent Skills spec. Throws with a
 * specific reason on failure.
 */
export function validateSkillName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`Skill name must be a non-empty string, got ${typeof name}`);
  }
  if (name.length > SKILL_NAME_MAX) {
    throw new Error(
      `Skill name exceeds ${SKILL_NAME_MAX} characters (got ${name.length}): "${name}"`,
    );
  }
  if (!SKILL_NAME_REGEX.test(name)) {
    throw new Error(
      `Skill name "${name}" is invalid. Must be lowercase alphanumeric and hyphens only, ` +
        `no leading/trailing or consecutive hyphens (per Agent Skills spec).`,
    );
  }
}

/**
 * Define a skill. Identity-typed factory — gives TypeScript the inference
 * handles to flow `TInput` from the input schema to call sites.
 *
 * Validates name format and length per the Agent Skills open spec, plus
 * any provided `description` / `compatibility` length caps. `description`
 * is *recommended* by the open spec but defineSkill keeps it optional —
 * the loader enforces required-when-loading-from-folder.
 *
 * @example
 * ```typescript
 * const Triage = defineSkill({
 *   name: "triage",
 *   description: "Investigate an issue and decide on action",
 *   instructions: "You are a triage agent. Investigate, decide, submit.",
 *   input: z.object({ issueNumber: z.number() }),
 *   allowedTools: ["search", "read_file"],
 *   argumentNames: ["issueNumber"],
 * });
 * ```
 */
export function defineSkill<TInput = unknown>(def: SkillDef<TInput>): SkillDef<TInput> {
  validateSkillName(def.name);

  if (!def.instructions || def.instructions.trim().length === 0) {
    throw new Error(`defineSkill: "${def.name}" must have non-empty instructions`);
  }

  // description is REQUIRED per Agent Skills open spec
  if (typeof def.description !== "string" || def.description.length === 0) {
    throw new Error(
      `defineSkill: "${def.name}" requires a non-empty description (per Agent Skills spec).`,
    );
  }
  if (def.description.length > SKILL_DESCRIPTION_MAX) {
    throw new Error(
      `defineSkill: "${def.name}" description exceeds ${SKILL_DESCRIPTION_MAX} characters ` +
        `(got ${def.description.length}).`,
    );
  }

  // metadata values must be strings per spec
  if (def.metadata !== undefined) {
    if (typeof def.metadata !== "object" || def.metadata === null || Array.isArray(def.metadata)) {
      throw new Error(`defineSkill: "${def.name}" metadata must be an object map.`);
    }
    for (const [k, v] of Object.entries(def.metadata)) {
      if (typeof v !== "string") {
        throw new Error(
          `defineSkill: "${def.name}" metadata.${k} must be a string (per spec), got ${typeof v}.`,
        );
      }
    }
  }

  if (def.compatibility !== undefined) {
    if (typeof def.compatibility !== "string") {
      throw new Error(`defineSkill: "${def.name}" compatibility must be a string`);
    }
    if (def.compatibility.length > SKILL_COMPATIBILITY_MAX) {
      throw new Error(
        `defineSkill: "${def.name}" compatibility exceeds ${SKILL_COMPATIBILITY_MAX} characters ` +
          `(got ${def.compatibility.length}).`,
      );
    }
  }

  return def;
}
