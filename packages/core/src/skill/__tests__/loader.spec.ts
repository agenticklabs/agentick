/**
 * Skill loader tests.
 *
 * Covers:
 * - Frontmatter parsing (key/value, arrays, comments, edge cases)
 * - parseSkill() with full frontmatter, partial, none
 * - loadSkill() reads from filesystem (uses tmp file)
 * - Anthropic-compatible minimal format
 * - Name resolution: opts > frontmatter > filename
 * - Errors: empty body, no name resolvable
 */

import { describe, it, expect } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseFrontmatter } from "../frontmatter.js";
import { parseSkill, loadSkill } from "../loader.js";

// ============================================================================
// parseFrontmatter
// ============================================================================

describe("parseFrontmatter", () => {
  it("returns body unchanged when there is no frontmatter", () => {
    const src = "Just a body, no frontmatter.";
    const r = parseFrontmatter(src);
    expect(r.data).toEqual({});
    expect(r.body).toBe(src);
  });

  it("parses simple key: value pairs", () => {
    const src = `---
name: triage
description: Investigate
maxTicks: 15
active: true
---
Body here.`;
    const r = parseFrontmatter(src);
    expect(r.data).toEqual({
      name: "triage",
      description: "Investigate",
      maxTicks: 15,
      active: true,
    });
    expect(r.body).toBe("Body here.");
  });

  it("parses flow-style arrays of strings", () => {
    const src = `---
tools: [search, read_file, grep]
---
Body`;
    const r = parseFrontmatter(src);
    expect(r.data.tools).toEqual(["search", "read_file", "grep"]);
  });

  it("handles quoted values with commas", () => {
    const src = `---
description: "Has, commas, in it"
tools: ["one with, comma", another]
---
B`;
    const r = parseFrontmatter(src);
    expect(r.data.description).toBe("Has, commas, in it");
    expect(r.data.tools).toEqual(["one with, comma", "another"]);
  });

  it("strips comments outside quotes", () => {
    const src = `---
name: triage  # this is a comment
description: "with a # hash inside"
---
B`;
    const r = parseFrontmatter(src);
    expect(r.data.name).toBe("triage");
    expect(r.data.description).toBe("with a # hash inside");
  });

  it("treats malformed (unclosed) frontmatter as no frontmatter", () => {
    const src = `---
name: triage
no closing delim`;
    const r = parseFrontmatter(src);
    expect(r.data).toEqual({});
    expect(r.body).toBe(src);
  });

  it("strips a single leading blank line on body", () => {
    const src = `---
name: x
---

Body line one.`;
    const r = parseFrontmatter(src);
    expect(r.body).toBe("Body line one.");
  });

  // ──────────────────────────────────────────────────────────────────────
  // Real-YAML cases (the gaps the previous hand-rolled parser couldn't do)
  // ──────────────────────────────────────────────────────────────────────

  it("parses block-style arrays (the dominant YAML idiom)", () => {
    const src = `---
tools:
  - search
  - read_file
  - grep
---
Body`;
    const r = parseFrontmatter(src);
    expect(r.data.tools).toEqual(["search", "read_file", "grep"]);
  });

  it("parses literal multiline strings (|)", () => {
    const src = `---
description: |
  Line one.
  Line two.
  Line three.
---
Body`;
    const r = parseFrontmatter(src);
    expect(r.data.description).toBe("Line one.\nLine two.\nLine three.\n");
  });

  it("parses folded multiline strings (>)", () => {
    const src = `---
description: >
  This is
  one paragraph
  folded together.
---
Body`;
    const r = parseFrontmatter(src);
    expect(r.data.description).toBe("This is one paragraph folded together.\n");
  });

  it("parses nested objects", () => {
    const src = `---
limits:
  maxTicks: 10
  timeout: 30000
---
Body`;
    const r = parseFrontmatter(src);
    expect(r.data.limits).toEqual({ maxTicks: 10, timeout: 30000 });
  });

  it("parses YAML boolean variants (yes/no/on/off via YAML 1.2 → strings)", () => {
    // YAML 1.2 (the spec `yaml` package targets) treats yes/no/on/off as
    // strings, only true/false as booleans. This is the modern correct
    // behavior; YAML 1.1 treated them as booleans.
    const src = `---
a: true
b: false
c: yes
d: no
---
Body`;
    const r = parseFrontmatter(src);
    expect(r.data.a).toBe(true);
    expect(r.data.b).toBe(false);
    expect(r.data.c).toBe("yes");
    expect(r.data.d).toBe("no");
  });
});

// ============================================================================
// parseSkill
// ============================================================================

describe("parseSkill", () => {
  it("parses a full skill file (spec frontmatter — allowed-tools, when_to_use)", () => {
    const src = `---
name: triage
description: Investigate and decide
when_to_use: When the user reports a bug or asks to triage an issue.
argument-hint: "[issueNumber]"
allowed-tools: [search, read_file]
arguments: [issueNumber]
disable-model-invocation: true
maxTicks: 12
---
You are a triage agent. Investigate, decide, submit.`;
    const skill = parseSkill(src);
    expect(skill.name).toBe("triage");
    expect(skill.description).toBe("Investigate and decide");
    expect(skill.whenToUse).toBe("When the user reports a bug or asks to triage an issue.");
    expect(skill.argumentHint).toBe("[issueNumber]");
    expect(skill.allowedTools).toEqual(["search", "read_file"]);
    expect(skill.argumentNames).toEqual(["issueNumber"]);
    expect(skill.disableModelInvocation).toBe(true);
    expect(skill.maxTicks).toBe(12);
    expect(skill.instructions).toBe("You are a triage agent. Investigate, decide, submit.");
  });

  it("accepts allowed-tools as a space-separated string (spec alternative)", () => {
    const src = `---
name: x
allowed-tools: search read_file grep
---
Body`;
    const skill = parseSkill(src);
    expect(skill.allowedTools).toEqual(["search", "read_file", "grep"]);
  });

  it("accepts arguments as a space-separated string", () => {
    const src = `---
name: migrate
arguments: component fromFw toFw
---
Body`;
    const skill = parseSkill(src);
    expect(skill.argumentNames).toEqual(["component", "fromFw", "toFw"]);
  });

  it("supports the minimal Anthropic-compatible format (just name + body)", () => {
    const src = `---
name: summarize
---
Summarize the input.`;
    const skill = parseSkill(src);
    expect(skill.name).toBe("summarize");
    expect(skill.instructions).toBe("Summarize the input.");
    expect(skill.allowedTools).toBeUndefined();
    expect(skill.maxTicks).toBeUndefined();
  });

  it("uses opts.name when provided (overrides frontmatter)", () => {
    const src = `---
name: original
---
Body`;
    const skill = parseSkill(src, { name: "overridden" });
    expect(skill.name).toBe("overridden");
  });

  it("attaches a typed input schema when opts.input is given", () => {
    const src = `---
name: x
---
Body`;
    const inputSchema = z.object({ task: z.string() });
    const skill = parseSkill(src, { input: inputSchema });
    expect(skill.input).toBe(inputSchema);
  });

  it("throws when name cannot be determined (no frontmatter, no opts, no path)", () => {
    expect(() => parseSkill("Body without frontmatter")).toThrow(/skill name/);
  });

  it("throws when body is empty", () => {
    const src = `---
name: x
---
`;
    expect(() => parseSkill(src)).toThrow(/no instructions/);
  });
});

// ============================================================================
// loadSkill (filesystem)
// ============================================================================

describe("loadSkill", () => {
  it("reads a flat .md skill file from disk (convenience form)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentick-skill-test-"));
    try {
      const path = join(dir, "triage.md");
      await writeFile(
        path,
        `---
name: triage
allowed-tools: [search, read_file]
---
You are a triage agent.`,
      );

      const skill = await loadSkill(path);
      expect(skill.name).toBe("triage");
      expect(skill.allowedTools).toEqual(["search", "read_file"]);
      expect(skill.instructions).toBe("You are a triage agent.");
      // Flat-file form does not set skillDir
      expect(skill.skillDir).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads a directory-based skill (canonical SKILL.md form)", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentick-skill-test-"));
    try {
      const skillDir = join(root, "triage");
      await import("node:fs/promises").then((m) => m.mkdir(skillDir));
      const skillFile = join(skillDir, "SKILL.md");
      await writeFile(
        skillFile,
        `---
description: Triage an issue
allowed-tools:
  - search
  - read_file
---
You are a triage agent.`,
      );

      // Pass the DIRECTORY, not the file
      const skill = await loadSkill(skillDir);
      // Name falls back to directory name when frontmatter omits it
      expect(skill.name).toBe("triage");
      expect(skill.description).toBe("Triage an issue");
      expect(skill.allowedTools).toEqual(["search", "read_file"]);
      expect(skill.skillDir).toBe(skillDir);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports supporting files alongside SKILL.md (skillDir is exposed)", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentick-skill-test-"));
    try {
      const skillDir = join(root, "build");
      const fs = await import("node:fs/promises");
      await fs.mkdir(skillDir);
      await fs.mkdir(join(skillDir, "scripts"));
      await writeFile(
        join(skillDir, "SKILL.md"),
        `---
description: Build the project
---
Run \${AGENTICK_SKILL_DIR}/scripts/build.sh`,
      );
      await writeFile(join(skillDir, "scripts/build.sh"), "#!/bin/bash\necho ok\n");

      const skill = await loadSkill(skillDir);
      expect(skill.skillDir).toBe(skillDir);
      // Substitution is applied at exec time, so instructions stays templated
      expect(skill.instructions).toContain("${AGENTICK_SKILL_DIR}/scripts/build.sh");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws on a non-md file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentick-skill-test-"));
    try {
      const path = join(dir, "not-a-skill.txt");
      await writeFile(path, "anything");
      await expect(loadSkill(path)).rejects.toThrow(/expected a directory or a \.md file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when path doesn't exist", async () => {
    await expect(loadSkill("/nonexistent/path/here")).rejects.toThrow(/path not found/);
  });

  it("falls back to filename for the skill name when frontmatter omits it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentick-skill-test-"));
    try {
      const path = join(dir, "auto-named.md");
      await writeFile(
        path,
        `---
description: No name in frontmatter
---
Body content.`,
      );

      const skill = await loadSkill(path);
      expect(skill.name).toBe("auto-named");
      expect(skill.description).toBe("No name in frontmatter");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads a file with no frontmatter (Anthropic-style minimal)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentick-skill-test-"));
    try {
      const path = join(dir, "minimal.md");
      await writeFile(path, "You are a minimal agent. Do the thing.");

      const skill = await loadSkill(path);
      expect(skill.name).toBe("minimal"); // from filename
      expect(skill.instructions).toBe("You are a minimal agent. Do the thing.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Open-spec compliance (folder mode is strict)
  // ──────────────────────────────────────────────────────────────────────

  it("folder mode requires `description` (per Agent Skills spec)", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentick-skill-test-"));
    try {
      const skillDir = join(root, "no-desc");
      const fs = await import("node:fs/promises");
      await fs.mkdir(skillDir);
      await writeFile(
        join(skillDir, "SKILL.md"),
        `---
name: no-desc
---
Body here, but no description in frontmatter.`,
      );
      await expect(loadSkill(skillDir)).rejects.toThrow(/required `description`/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("folder mode enforces frontmatter `name` matches parent dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentick-skill-test-"));
    try {
      const skillDir = join(root, "actual-dir-name");
      const fs = await import("node:fs/promises");
      await fs.mkdir(skillDir);
      await writeFile(
        join(skillDir, "SKILL.md"),
        `---
name: different-from-dir
description: Mismatch.
---
Body.`,
      );
      await expect(loadSkill(skillDir)).rejects.toThrow(/must match parent directory/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("folder mode allows omitting `name` (falls back to dir name)", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentick-skill-test-"));
    try {
      const skillDir = join(root, "from-dir");
      const fs = await import("node:fs/promises");
      await fs.mkdir(skillDir);
      await writeFile(
        join(skillDir, "SKILL.md"),
        `---
description: Name comes from dir.
---
Body.`,
      );
      const skill = await loadSkill(skillDir);
      expect(skill.name).toBe("from-dir");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flat-file mode is lenient (description not required, no dir match)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentick-skill-test-"));
    try {
      const path = join(dir, "lenient.md");
      await writeFile(
        path,
        `---
name: different-name
---
Body, no description.`,
      );
      const skill = await loadSkill(path);
      expect(skill.name).toBe("different-name");
      // Loader uses a generic placeholder when frontmatter omits description
      // (instead of mining the body's first line, which is typically
      // instructional rather than descriptive). Folder-loaded skills require
      // a real description per spec.
      expect(skill.description).toBe("Skill: different-name");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses license, compatibility, metadata fields", () => {
    const src = `---
name: pdf-processing
description: Extract PDF text.
license: Apache-2.0
compatibility: Requires Python 3.14+ and uv
metadata:
  author: example-org
  version: "1.0"
---
Body.`;
    const skill = parseSkill(src);
    expect(skill.license).toBe("Apache-2.0");
    expect(skill.compatibility).toBe("Requires Python 3.14+ and uv");
    expect(skill.metadata).toEqual({ author: "example-org", version: "1.0" });
  });

  it("rejects spec-invalid name (uppercase) in frontmatter", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentick-skill-test-"));
    try {
      const skillDir = join(root, "bad-name");
      const fs = await import("node:fs/promises");
      await fs.mkdir(skillDir);
      await writeFile(
        join(skillDir, "SKILL.md"),
        `---
name: Bad-Name
description: Has uppercase.
---
Body.`,
      );
      await expect(loadSkill(skillDir)).rejects.toThrow(
        'loadSkill: frontmatter name "Bad-Name" must match parent directory "bad-name" (per Agent Skills spec).',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
