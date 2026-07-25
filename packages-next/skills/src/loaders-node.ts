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

import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import process from "node:process";

import type { ResourceContents, SkillsRegisterInput } from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";
import { extractFrontmatter, mapLoader } from "@agentick/utils-next/loaders";
import {
  type FromDirectoryOptions,
  sourceFromDirectory,
  sourceFromFile,
} from "@agentick/utils-next/loaders/node";

import type { SkillLoader } from "./loaders.js";
import {
  SKILL_REFERENCE_WIRING,
  type SkillReference,
  type SkillReferenceWiring,
} from "./references.js";

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
// agentSkillsDirectory — Agent Skills (agentskills.io) layout preset
// ---------------------------------------------------------------------

export interface AgentSkillsDirectoryOptions {
  /**
   * Root under which each IMMEDIATE subdirectory containing a `SKILL.md` is one
   * skill. Defaults to `<cwd>/.agents/skills/`. A MISSING root loads as empty —
   * a preset pointed at a default path must not explode on absence.
   */
  readonly root?: string;
  /** Override the default frontmatter parser. */
  readonly parseFrontmatter?: (text: string) => FrontmatterRecord;
  readonly encoding?: BufferEncoding;
}

/**
 * `SkillLoader` for the [Agent Skills](https://agentskills.io/specification)
 * directory layout: each immediate subdirectory of `root` that contains a
 * `SKILL.md` becomes ONE skill record. Non-`SKILL.md` files in a skill
 * directory are NOT skills — files under `references/` are surfaced as
 * resources instead (see `references.ts` + `withSkills`).
 *
 * Frontmatter → `SkillsRegisterInput`:
 *  - `name` — defaults to the directory name when the frontmatter omits it (the
 *    Agent Skills convention).
 *  - `description` — REQUIRED; a skill directory with no description is skipped.
 *  - `tags` — optional.
 *  - `allowed-tools` → `allowedTools` — inline array OR comma-separated string.
 *  - every remaining key → `metadata` (plus `sourcePath` + `references`).
 *
 * Security (Flue packaging rule): hidden (`.`-prefixed) and symlinked skill
 * directories are rejected at load; the recursive `references/` walk applies
 * the same rejection (via {@link walkReferenceFiles}). An unreadable `SKILL.md`
 * or one whose frontmatter yields no description is SKIPPED — matching
 * `fromDirectory`'s skip semantics.
 */
export function agentSkillsDirectory(options: AgentSkillsDirectoryOptions = {}): SkillLoader {
  const root = options.root ?? join(process.cwd(), ".agents", "skills");
  const parser = options.parseFrontmatter ?? parseSimpleFrontmatter;
  const encoding = options.encoding ?? "utf-8";

  const load = async (): Promise<readonly SkillsRegisterInput[]> => {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (cause) {
      if (isENOENT(cause)) return []; // missing root → empty load
      throw new Error(`agentSkillsDirectory: readdir failed on ${root}: ${String(cause)}`, {
        cause,
      });
    }

    const out: SkillsRegisterInput[] = [];
    for (const entry of entries) {
      // Reject hidden + symlinked skill directories at load (Flue rule).
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;

      const skillDir = join(root, entry.name);
      const skillMdPath = join(skillDir, "SKILL.md");
      let raw: string;
      try {
        raw = await readFile(skillMdPath, encoding);
      } catch {
        // No readable SKILL.md → not a skill directory; skip.
        continue;
      }
      const record = await agentSkillRecord(
        entry.name,
        skillDir,
        skillMdPath,
        raw,
        parser,
        encoding,
      );
      if (record) out.push(record);
    }
    // Deterministic, name-sorted output.
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };

  return {
    load,
    lookup: async (name) => {
      const all = await load();
      return all.find((s) => s.name === name) ?? null;
    },
  };
}

// TODO(E3): `fromPackage("@acme/review-skills/review")` — resolve the npm
// subpath via the host's module resolver (e.g. `import.meta.resolve` /
// `createRequire(...).resolve`) to the on-disk skill directory, then delegate
// to `agentSkillsDirectory({ root })`'s directory semantics. CAVEAT: the target
// package MUST export its `SKILL.md` / skill-directory subpaths in its
// `exports` map — an unexported subpath is unresolvable, so `fromPackage` reads
// only what the package author chose to publish. Distribution is npm's problem;
// discovery reuses (1)'s walk. Deferred to a separate PR (three-audiences-plan
// §E3); the import-attribute loader-hook form (`with { type: "skill" }`) stays
// deferred beyond that.

/** Build one Agent Skills record from a `<dir>/SKILL.md`. `null` → skip. */
async function agentSkillRecord(
  dirName: string,
  skillDir: string,
  skillMdPath: string,
  raw: string,
  parser: (text: string) => FrontmatterRecord,
  encoding: BufferEncoding,
): Promise<SkillsRegisterInput | null> {
  const { frontmatter, body } = extractFrontmatter(raw);
  const meta = frontmatter != null ? parser(frontmatter) : {};
  const name = stringField(meta, "name") ?? dirName; // Agent Skills: default to dir name
  const description = stringField(meta, "description");
  if (!description) return null; // no description → skip (matches fromDirectory)

  const tags = arrayField(meta, "tags");
  const allowedTools = allowedToolsField(meta);
  const { pure, wiring } = await collectReferences(skillDir, name, encoding);

  const metadata: Record<string, unknown> = { sourcePath: skillMdPath, ...stripKnown(meta) };
  if (pure.length > 0) {
    metadata.references = pure; // pure data — persists
    metadata[SKILL_REFERENCE_WIRING] = wiring; // transient resolver closures
  }

  return {
    name,
    description,
    content: body,
    ...(tags ? { tags } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    metadata,
  };
}

/**
 * Discover `<skillDir>/references/**` and produce both the pure-data
 * descriptors (`{ uri, path }`) and the transient wiring (`{ uri, resolver,
 * meta }`) whose resolver LAZILY reads the file on `resource_read`. The uri is
 * precomputed as `skill://<name>/references/<posix-relpath>`. A missing
 * `references/` directory yields none.
 */
async function collectReferences(
  skillDir: string,
  name: string,
  encoding: BufferEncoding,
): Promise<{
  readonly pure: readonly SkillReference[];
  readonly wiring: readonly SkillReferenceWiring[];
}> {
  const referencesDir = join(skillDir, "references");
  const files = await walkReferenceFiles(referencesDir);
  const pure: SkillReference[] = [];
  const wiring: SkillReferenceWiring[] = [];
  for (const path of files) {
    const rel = relative(referencesDir, path).split(sep).join("/"); // posix relpath in the uri
    const uri = `skill://${name}/references/${rel}`;
    const mimeType = guessMimeType(path);
    pure.push({ uri, path });
    wiring.push({
      uri,
      meta: omitUndefined({ name: `${name}: references/${rel}`, mimeType }),
      // Lazy — the file is read only when the model actually pulls the resource.
      resolver: async (): Promise<readonly ResourceContents[]> => {
        const text = await readFile(path, encoding);
        return [omitUndefined({ uri, mimeType, text }) as ResourceContents];
      },
    });
  }
  return { pure, wiring };
}

/**
 * Minimal recursive file walk for a skill's `references/` tree. Rejects hidden
 * (`.`-prefixed) + symlinked entries at every level — same rule as
 * `sourceFromDirectory`, but PATHS-ONLY so the resolver can read lazily
 * (`sourceFromDirectory` eager-reads content, which would defeat laziness). A
 * missing / unreadable directory yields `[]`.
 */
async function walkReferenceFiles(dir: string): Promise<readonly string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue; // absent references/ dir (or unreadable subdir) → nothing here
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile()) out.push(full);
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Best-effort mime type from the file extension. `undefined` → resolver omits. */
function guessMimeType(path: string): string | undefined {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "text/markdown";
  if (name.endsWith(".txt")) return "text/plain";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "application/yaml";
  if (name.endsWith(".html") || name.endsWith(".htm")) return "text/html";
  if (name.endsWith(".csv")) return "text/csv";
  return undefined;
}

/** `true` when the error is a filesystem "no such file/directory". */
function isENOENT(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: string }).code === "ENOENT"
  );
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
  const allowedTools = allowedToolsField(meta);
  const out: SkillsRegisterInput = {
    name,
    description,
    content: body,
    ...(tags ? { tags } : {}),
    ...(allowedTools ? { allowedTools } : {}),
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

/**
 * Map the Agent Skills `allowed-tools` frontmatter onto `Skill.allowedTools`.
 * Accepts BOTH the inline-array form (`[Bash, Read]` — already an array from
 * `parseSimpleFrontmatter`) and the comma-separated-string form
 * (`"Bash, Read"` → `["Bash", "Read"]`, trimmed, empties dropped). Returns
 * `null` when absent or empty so the caller conditionally spreads the field.
 */
function allowedToolsField(meta: FrontmatterRecord): readonly string[] | null {
  const v = meta["allowed-tools"];
  if (Array.isArray(v)) {
    const out = v.filter((x): x is string => typeof x === "string");
    return out.length > 0 ? out : null;
  }
  if (typeof v === "string") {
    const out = v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return out.length > 0 ? out : null;
  }
  return null;
}

function stripKnown(meta: FrontmatterRecord): FrontmatterRecord {
  const { name: _n, description: _d, tags: _t, "allowed-tools": _a, ...rest } = meta;
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
