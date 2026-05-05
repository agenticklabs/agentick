/**
 * Skill loader — read skill directories or `.md` files, parse frontmatter,
 * return SkillDef.
 *
 * The canonical layout follows the [Agent Skills](https://agentskills.io)
 * open spec:
 *
 *   my-skill/
 *   ├── SKILL.md          # required entrypoint (frontmatter + body)
 *   ├── scripts/          # optional: executable code
 *   ├── references/       # optional: documentation loaded on demand
 *   ├── assets/           # optional: templates, images, data files
 *   └── ...
 *
 * Two loading modes:
 *   - **Folder mode (canonical)**: `loadSkill("./skills/triage")` reads
 *     `triage/SKILL.md`. Full open-spec validation: `name` required and
 *     must match the parent directory; `description` required.
 *     `skillDir` is set on the returned SkillDef.
 *   - **Flat mode (Agentick convenience)**: `loadSkill("./inline.md")`.
 *     Not part of the open spec — used for tests / embedded / single-file
 *     cases. Strict validation is relaxed (no parent-dir match; missing
 *     description warns but doesn't throw).
 *
 * Frontmatter fields recognized:
 *
 *   Open spec (validated):
 *     - `name`, `description`, `license`, `compatibility`, `metadata`
 *     - `allowed-tools` (string or YAML list, experimental)
 *
 *   Claude Code extensions (parsed, supplementary):
 *     - `when_to_use`, `argument-hint`, `arguments`
 *     - `disable-model-invocation`, `user-invocable`
 *     - `maxTicks` (Agentick extension — loop budget)
 *
 *   Reserved (not parsed yet):
 *     - `model`, `effort`, `context`, `agent`, `hooks`, `paths`, `shell`
 *     - Dynamic context injection (` !`<command>` `) — security gate, later
 *
 * @module @agentick/core/skill/loader
 */

import { readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { ZodSchema } from "../tool/tool.js";
import { parseFrontmatter } from "./frontmatter.js";
import { defineSkill, type SkillDef } from "./skill.js";

export interface LoadSkillOptions<TInput = unknown> {
  /**
   * Optional Zod schema for the skill's args. When provided, args are
   * validated at invocation time. Files don't carry typed schemas; pass
   * one here to opt into validation for a particular caller.
   */
  input?: ZodSchema<TInput>;

  /**
   * Override the skill's name. Resolution order: opts.name → frontmatter
   * `name` → directory name (for folder loads) → filename (for `.md` loads).
   */
  name?: string;
}

/**
 * Load a skill from disk.
 *
 * If `path` is a directory, reads `<path>/SKILL.md`. If `path` ends with
 * `.md`, reads it as a single-file skill (convenience).
 *
 * @example Folder-based (canonical)
 * ```typescript
 * const Triage = await loadSkill("./skills/triage");
 * // reads ./skills/triage/SKILL.md
 * ```
 *
 * @example Single-file (convenience)
 * ```typescript
 * const Inline = await loadSkill("./inline-skill.md");
 * ```
 */
export async function loadSkill<TInput = unknown>(
  path: string,
  opts: LoadSkillOptions<TInput> = {},
): Promise<SkillDef<TInput>> {
  const { sourcePath, skillDir, fallbackName } = await resolveSkillPath(path);
  const source = await readFile(sourcePath, "utf8");
  // Strict spec validation when loading from a folder (skillDir set).
  // Flat-file form is an Agentick convenience and stays lenient.
  return parseSkill<TInput>(source, {
    ...opts,
    _skillDir: skillDir,
    _fallbackName: fallbackName,
    _strict: skillDir !== undefined,
  });
}

/**
 * Parse a skill from an in-memory markdown string. Useful for embedded
 * skills, tests, or skills served from databases / network sources.
 *
 * @param source - The full markdown source (frontmatter + body).
 * @param opts - Options including resolved skill dir, fallback name, and
 *   strict mode (folder-loaded skills get strict open-spec validation;
 *   flat-mode and pure parseSkill calls are lenient).
 */
export function parseSkill<TInput = unknown>(
  source: string,
  opts: LoadSkillOptions<TInput> & {
    _skillDir?: string;
    _fallbackName?: string;
    /** Folder mode → enforce open-spec required fields & name-matches-dir */
    _strict?: boolean;
  } = {},
): SkillDef<TInput> {
  const { data, body } = parseFrontmatter(source);

  // ── Open-spec core fields ────────────────────────────────────────────
  const fmName = strField(data, "name");
  const fmDescription = strField(data, "description");
  const fmLicense = strField(data, "license");
  const fmCompatibility = strField(data, "compatibility");
  const fmMetadata = recordField(data, "metadata");
  const fmAllowedTools = stringList(data["allowed-tools"]);

  // ── Claude Code extensions ───────────────────────────────────────────
  const fmWhenToUse = strField(data, "when_to_use");
  const fmArgumentHint = strField(data, "argument-hint");
  const fmDisableModelInvocation = boolField(data, "disable-model-invocation");
  const fmUserInvocable = boolField(data, "user-invocable");
  const fmArgumentNames = stringList(data["arguments"]);

  // ── Agentick extensions ──────────────────────────────────────────────
  const fmMaxTicks = numField(data, "maxTicks");

  // ── Name resolution (strict mode enforces match-parent-dir) ─────────
  const name = opts.name ?? fmName ?? opts._fallbackName;
  if (!name) {
    throw new Error(
      "loadSkill / parseSkill: skill name could not be determined. " +
        "Provide opts.name, frontmatter `name`, or load from a path.",
    );
  }

  if (opts._strict && opts._fallbackName) {
    // Open spec: `name` must match the parent directory name.
    // We compare the resolved final name against the fallback (= dir name).
    if (name !== opts._fallbackName) {
      throw new Error(
        `loadSkill: frontmatter name "${name}" must match parent directory "${opts._fallbackName}" ` +
          `(per Agent Skills spec).`,
      );
    }
  }

  // ── Description requirement (strict mode) ───────────────────────────
  if (opts._strict && (!fmDescription || fmDescription.trim() === "")) {
    throw new Error(
      `loadSkill: skill "${name}" is missing required \`description\` frontmatter ` +
        `(required by the Agent Skills spec for folder-loaded skills).`,
    );
  }

  // ── Body requirement ────────────────────────────────────────────────
  const instructions = body.trim();
  if (!instructions) {
    throw new Error(
      `loadSkill: skill "${name}" has no instructions (empty body after frontmatter).`,
    );
  }

  // In flat mode (Agentick convenience), description is optional. Use a
  // generic placeholder rather than mining the body's first line — the
  // first line is likely to be instructional ("You are a triage agent.")
  // and that's a poor pseudo-description. Folder-loaded skills require a
  // real description per spec.
  const description = fmDescription ?? `Skill: ${name}`;

  return defineSkill<TInput>({
    name,
    description,
    license: fmLicense,
    compatibility: fmCompatibility,
    metadata: fmMetadata,
    whenToUse: fmWhenToUse,
    argumentHint: fmArgumentHint,
    instructions,
    input: opts.input,
    argumentNames: fmArgumentNames,
    allowedTools: fmAllowedTools,
    disableModelInvocation: fmDisableModelInvocation,
    userInvocable: fmUserInvocable,
    maxTicks: fmMaxTicks,
    skillDir: opts._skillDir,
  });
}

// ============================================================================
// Path resolution
// ============================================================================

interface ResolvedSkillPath {
  /** Path to the file we'll read */
  sourcePath: string;
  /** Directory containing the skill (set for folder-based loads) */
  skillDir?: string;
  /** Name fallback when frontmatter omits `name` */
  fallbackName: string;
}

async function resolveSkillPath(path: string): Promise<ResolvedSkillPath> {
  const abs = resolve(path);

  let info;
  try {
    info = await stat(abs);
  } catch {
    // The path doesn't exist — surface a useful error
    throw new Error(`loadSkill: path not found: ${path}`);
  }

  if (info.isDirectory()) {
    const sourcePath = join(abs, "SKILL.md");
    return {
      sourcePath,
      skillDir: abs,
      fallbackName: basename(abs),
    };
  }

  // File path: must end with .md (the spec assumes folder-based; we keep
  // .md as a convenience for tests / embedded / single-file cases)
  const ext = extname(abs).toLowerCase();
  if (ext !== ".md") {
    throw new Error(
      `loadSkill: expected a directory or a .md file, got "${path}" (extension "${ext}").`,
    );
  }
  return {
    sourcePath: abs,
    fallbackName: basename(abs, ext),
  };
}

// ============================================================================
// Frontmatter field extraction
// ============================================================================

function strField(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === "string" ? v : undefined;
}

function boolField(data: Record<string, unknown>, key: string): boolean | undefined {
  const v = data[key];
  return typeof v === "boolean" ? v : undefined;
}

function numField(data: Record<string, unknown>, key: string): number | undefined {
  const v = data[key];
  return typeof v === "number" ? v : undefined;
}

/**
 * Parse a metadata field per spec — "string keys to string values".
 *
 * Rejects non-string values with a clear error rather than silently
 * coercing. YAML parses `version: 1.0` as a number; the user almost
 * certainly meant `version: "1.0"` (the spec example explicitly quotes
 * it). Failing loudly is more honest than coercing — the alternative
 * (`{author: "x", version: 1}` → `{author: "x", version: "1"}`) hides
 * the lossy parse and diverges from `defineSkill`'s strict behavior.
 */
function recordField(
  data: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const v = data[key];
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(
      `loadSkill: \`${key}\` frontmatter must be a mapping of string keys to string values.`,
    );
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") {
      const hint =
        typeof val === "number" || typeof val === "boolean"
          ? ` Did you mean to quote it (e.g. \`${k}: "${String(val)}"\`)?`
          : "";
      throw new Error(
        `loadSkill: \`${key}.${k}\` must be a string per Agent Skills spec, got ${typeof val}.${hint}`,
      );
    }
    out[k] = val;
  }
  return out;
}

/**
 * Spec accepts either a space-separated string or a YAML list for fields
 * like `allowed-tools` and `arguments`. Normalize both to `string[]`.
 */
function stringList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const items = v.filter((x) => typeof x === "string") as string[];
    return items.length > 0 ? items : undefined;
  }
  if (typeof v === "string") {
    const items = v.split(/\s+/).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}
