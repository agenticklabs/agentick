/**
 * `@agentick/skills-next/loaders/node` — Node filesystem-backed
 * `SkillLoader` factories.
 *
 *  - `fromFile(path, opts?)` — one `.md` file with frontmatter
 *  - `fromDirectory(path, opts?)` — recursive walk of `.md` files
 *
 * Frontmatter is parsed by a deliberately-minimal `key: value` parser
 * (one entry per line, optional quoted values, no nested structures).
 * This covers the Claude-Skills default shape (`name`, `description`,
 * optional `tags: [a, b, c]`). Adopters with TOML / nested YAML pass a
 * custom `parseFrontmatter` callback — for full YAML, wire the `yaml`
 * package yourself.
 *
 * Body of the file becomes `Skill.content` verbatim.
 */

import type { SkillsRegisterInput } from "@agentick/spec-next";
import { extractFrontmatter, mapLoader } from "@agentick/utils-next/loaders";
import {
  type FromDirectoryOptions,
  sourceFromDirectory,
  sourceFromFile,
} from "@agentick/utils-next/loaders/node";

import type { SkillLoader } from "./loaders.js";

/**
 * Parsed frontmatter — keys typed as `unknown` so callers handle
 * whatever the parser produces. The default `parseSimpleFrontmatter`
 * only produces strings + string arrays.
 */
export type FrontmatterRecord = Record<string, unknown>;

export interface FromFileOptions {
  readonly path: string;
  readonly encoding?: BufferEncoding;
  /** Override the default frontmatter parser. */
  readonly parseFrontmatter?: (text: string) => FrontmatterRecord;
}

export interface FromDirectoryOptionsForSkills extends Omit<FromDirectoryOptions, "match"> {
  /**
   * RegExp / predicate for which files to load. Default `/\.md$/` —
   * adopters using `.skill.md` or `.mdx` extensions override.
   */
  readonly match?: FromDirectoryOptions["match"];
  /** Override the default frontmatter parser. */
  readonly parseFrontmatter?: (text: string) => FrontmatterRecord;
}

/**
 * Load a single skill file. The file MUST start with a `---`
 * frontmatter block carrying at minimum `name` and `description`.
 * Missing either → load error.
 */
export function fromFile(options: FromFileOptions): SkillLoader {
  const inner = mapLoader(
    sourceFromFile({
      path: options.path,
      ...(options.encoding ? { encoding: options.encoding } : {}),
    }),
    (record) => fileRecordToSkill(record, options.parseFrontmatter ?? parseSimpleFrontmatter),
  );
  return {
    load: inner.load,
    lookup: async (name) => {
      try {
        const all = await inner.load();
        return all.find((s) => s.name === name) ?? null;
      } catch {
        // A bad file → lookup returns null rather than poisoning the chain.
        return null;
      }
    },
  };
}

/**
 * Recursively load every matching file under `path`. Files without
 * frontmatter or missing required fields are skipped silently — pass
 * `parseFrontmatter` if you need stricter behavior.
 */
export function fromDirectory(options: FromDirectoryOptionsForSkills): SkillLoader {
  const match = options.match ?? /\.md$/;
  const parser = options.parseFrontmatter ?? parseSimpleFrontmatter;
  const dirOpts: FromDirectoryOptions = {
    path: options.path,
    match,
    ...(options.recursive !== undefined ? { recursive: options.recursive } : {}),
    ...(options.includeHidden !== undefined ? { includeHidden: options.includeHidden } : {}),
    ...(options.encoding ? { encoding: options.encoding } : {}),
  };
  const inner = mapLoader(sourceFromDirectory(dirOpts), (record) => {
    try {
      return fileRecordToSkill(record, parser);
    } catch {
      // Skip files whose frontmatter doesn't yield a valid skill.
      return null;
    }
  });
  return {
    load: inner.load,
    lookup: async (name) => {
      const all = await inner.load();
      return all.find((s) => s.name === name) ?? null;
    },
  };
}

// ---------------------------------------------------------------------
// Internal: frontmatter → SkillsRegisterInput
// ---------------------------------------------------------------------

function fileRecordToSkill(
  record: { path: string; content: string },
  parser: (text: string) => FrontmatterRecord,
): SkillsRegisterInput {
  const { frontmatter, body } = extractFrontmatter(record.content);
  if (frontmatter == null) {
    throw new Error(`skills.fromFile: ${record.path} has no frontmatter block`);
  }
  const meta = parser(frontmatter);
  const name = stringField(meta, "name");
  const description = stringField(meta, "description");
  if (!name || !description) {
    throw new Error(
      `skills.fromFile: ${record.path} frontmatter missing required name/description`,
    );
  }
  const tags = arrayField(meta, "tags");
  const out: SkillsRegisterInput = {
    name,
    description,
    content: body,
    ...(tags ? { tags } : {}),
    metadata: { sourcePath: record.path, ...stripKnown(meta) },
  };
  return out;
}

function stringField(meta: FrontmatterRecord, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" ? v : null;
}

function arrayField(meta: FrontmatterRecord, key: string): readonly string[] | null {
  const v = meta[key];
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : null;
}

function stripKnown(meta: FrontmatterRecord): FrontmatterRecord {
  const { name: _n, description: _d, tags: _t, ...rest } = meta;
  return rest;
}

// ---------------------------------------------------------------------
// Built-in minimal parser
// ---------------------------------------------------------------------

/**
 * Parse `key: value` frontmatter. Each non-empty line is one entry.
 * Quoted strings preserve internal whitespace + special characters.
 * `[item1, item2, item3]` becomes a string array (top-level only —
 * no nested arrays / objects). Anything else is held as a raw string.
 *
 * Comments (`# ...`) and blank lines are ignored. Indentation is NOT
 * significant — this is intentionally NOT a full YAML implementation.
 * If you need nested structures, pass your own `parseFrontmatter`.
 */
export function parseSimpleFrontmatter(text: string): FrontmatterRecord {
  const out: FrontmatterRecord = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s*#.*$/, "").trim();
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const valueRaw = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    out[key] = parseValue(valueRaw);
  }
  return out;
}

function parseValue(raw: string): unknown {
  if (raw === "") return "";
  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Inline array — `[a, b, c]` or `[ "a", "b" ]`
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => {
      const t = s.trim();
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1);
      }
      return t;
    });
  }
  return raw;
}
