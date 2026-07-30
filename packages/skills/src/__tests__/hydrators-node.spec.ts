/**
 * The FILESYSTEM hydrators (`@agentick/skills/hydrators/node`) — the Agent Skills
 * (agentskills.io) directory layout (E1), `references/*` riding the resources
 * harness (E2), the C2 allowed-tools loop closure, and the flat markdown walk.
 *
 * `hydrateFromDirectory` is the rename of the former directory LOADER with its
 * semantics unchanged (ADR 93 landmine 8: SKILL.md semantics are preserved
 * exactly, and this file is the parity proof).
 *
 * Pins:
 *  - E1 discovery: each immediate subdir with a `SKILL.md` is one skill; dirs
 *    without SKILL.md, hidden dirs, and loose root files are NOT skills.
 *  - E1 frontmatter mapping: `name` defaults to the dir name; `description`
 *    required (missing → skipped); `allowed-tools` as array AND comma-string →
 *    `allowedTools`.
 *  - E1 security: a MISSING root loads empty; a symlinked skill dir is rejected.
 *  - E2: a skill's `references/*` register as `skill://<name>/references/<rel>`
 *    resources on the session resources harness; the resolver reads file
 *    content. Degradation: no resources harness → skills still load, no throw.
 *  - C2: a DISK-loaded skill with `allowed-tools` produces a `composeRun`
 *    SendInput carrying `allowedTools`.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import type { Resources, SessionInstaller, Skills, SkillsRegisterInput } from "@agentick/spec";
import { ResourcesHarness } from "@agentick/resources";

import { SkillsHarness } from "../harness.js";
import { withSkills } from "../extension.js";
import { defaultComposeRun } from "../compose-run.js";
import {
  hydrateFromDirectory,
  hydrateFromFile,
  hydrateFromMarkdownFiles,
  parseSimpleFrontmatter,
} from "../hydrators-node.js";
import type { SkillsHydrateCtx } from "../definition.js";

/** Filesystem hydrators never read the ctx — the store facet is not their source. */
const noCtx = {} as SkillsHydrateCtx;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-skills-dir-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write `<root>/<dir>/SKILL.md` (creating the dir). */
async function writeSkill(dir: string, frontmatter: string, body = "body"): Promise<string> {
  const skillDir = join(root, dir);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
  return skillDir;
}

// ---------------------------------------------------------------------
// E1 — discovery
// ---------------------------------------------------------------------

describe("hydrateFromDirectory — discovery", () => {
  it("finds exactly the immediate subdirs with a SKILL.md", async () => {
    await writeSkill("alpha", "name: alpha\ndescription: A");
    await writeSkill("beta", "name: beta\ndescription: B");
    // A dir WITHOUT SKILL.md → not a skill.
    await mkdir(join(root, "notaskill"), { recursive: true });
    await writeFile(join(root, "notaskill", "README.md"), "hi");
    // A hidden dir → rejected even with SKILL.md.
    await writeSkill(".hidden", "name: hidden\ndescription: H");
    // A loose file at the root → not a skill.
    await writeFile(join(root, "loose.md"), "---\nname: loose\ndescription: L\n---\nx");

    const records = await hydrateFromDirectory({ root })(noCtx);
    expect(records.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("defaults `name` to the directory name when frontmatter omits it", async () => {
    await writeSkill("my-skill", "description: no explicit name");
    const [record] = await hydrateFromDirectory({ root })(noCtx);
    expect(record!.name).toBe("my-skill");
    expect(record!.description).toBe("no explicit name");
  });

  it("skips a skill directory whose SKILL.md has no description", async () => {
    await writeSkill("described", "name: described\ndescription: has one");
    await writeSkill("nodesc", "name: nodesc");
    const records = await hydrateFromDirectory({ root })(noCtx);
    expect(records.map((r) => r.name)).toEqual(["described"]);
  });

  it("loads EMPTY when the root directory is absent", async () => {
    const records = await hydrateFromDirectory({ root: join(root, "does-not-exist") })(noCtx);
    expect(records).toEqual([]);
  });

  it("rejects a symlinked skill directory at load", async () => {
    const real = await writeSkill("real", "name: real\ndescription: R");
    let symlinked = false;
    try {
      await symlink(real, join(root, "linked"), "dir");
      symlinked = true;
    } catch {
      // Platforms/privileges where symlink creation fails — skip the assertion.
    }
    const records = await hydrateFromDirectory({ root })(noCtx);
    expect(records.map((r) => r.name)).toEqual(["real"]);
    if (symlinked) {
      // The symlink dir must NOT have produced a second "real" record.
      expect(records).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------
// E1 — allowed-tools mapping
// ---------------------------------------------------------------------

describe("hydrateFromDirectory — allowed-tools mapping", () => {
  it("maps an inline-array `allowed-tools` → allowedTools", async () => {
    await writeSkill("arr", "name: arr\ndescription: A\nallowed-tools: [Bash, Read]");
    const [record] = await hydrateFromDirectory({ root })(noCtx);
    expect(record!.allowedTools).toEqual(["Bash", "Read"]);
  });

  it("maps a comma-separated-string `allowed-tools` → allowedTools", async () => {
    await writeSkill("str", 'name: str\ndescription: A\nallowed-tools: "Bash, Read"');
    const [record] = await hydrateFromDirectory({ root })(noCtx);
    expect(record!.allowedTools).toEqual(["Bash", "Read"]);
  });
});

// ---------------------------------------------------------------------
// `version` — the DECLARED field, promoted out of the metadata bag so the
// run's provenance stamp can carry it.
// ---------------------------------------------------------------------

describe("hydrateFromDirectory — version mapping", () => {
  it("maps frontmatter `version` onto the declared field, not metadata", async () => {
    await writeSkill("ver", "name: ver\ndescription: A\nversion: 2026-01-14");
    const [record] = await hydrateFromDirectory({ root })(noCtx);
    expect(record!.version).toBe("2026-01-14");
    expect(record!.metadata).not.toHaveProperty("version");
  });

  it("leaves version absent when the frontmatter omits it", async () => {
    await writeSkill("bare", "name: bare\ndescription: A");
    const [record] = await hydrateFromDirectory({ root })(noCtx);
    expect(record).not.toHaveProperty("version");
  });
});

// ---------------------------------------------------------------------
// E2 — references ride the resources harness
// ---------------------------------------------------------------------

/** Minimal `SessionInstaller` carrying a real resources harness (or none). */
function fakeInstaller(resources: Resources | undefined): {
  installer: SessionInstaller;
  namespaces: Map<string, unknown>;
  closers: Array<() => void>;
} {
  const namespaces = new Map<string, unknown>();
  const closers: Array<() => void> = [];
  const installer = {
    kind: "session",
    hostId: "host",
    sessionId: "sess",
    substrate: {
      journal: new MemoryJournal(),
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
    },
    resources,
    registerNamespace: (name: string, value: unknown) => {
      namespaces.set(name, value);
      return () => {};
    },
    getNamespace: (name: string) => namespaces.get(name),
    registerToolHandler: () => () => {},
    registerExtensionTool: () => () => {},
    onClose: (fn: () => void) => {
      closers.push(fn);
      return () => {};
    },
  } as unknown as SessionInstaller;
  return { installer, namespaces, closers };
}

describe("hydrateFromDirectory — references as resources (E2)", () => {
  it("registers references/* as skill:// resources readable through the harness", async () => {
    const skillDir = await writeSkill("guide", "name: guide\ndescription: G");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(join(skillDir, "references", "checklist.md"), "# Checklist\n- one\n- two");
    // Nested reference to prove the recursive relpath uri.
    await mkdir(join(skillDir, "references", "deep"), { recursive: true });
    await writeFile(join(skillDir, "references", "deep", "notes.txt"), "deep notes");

    const resources = new ResourcesHarness(
      `res:${ulid()}`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await resources.ready;

    const { installer } = fakeInstaller(resources);
    await withSkills({ hydrate: hydrateFromDirectory({ root }) }).install(installer);

    const checklistUri = "skill://guide/references/checklist.md";
    expect(resources.has(checklistUri)).toBe(true);
    const contents = await resources.read(checklistUri);
    expect(contents[0]).toMatchObject({
      uri: checklistUri,
      text: "# Checklist\n- one\n- two",
      mimeType: "text/markdown",
    });

    const notes = await resources.read("skill://guide/references/deep/notes.txt");
    expect(notes[0]).toMatchObject({ text: "deep notes" });

    // Pure-data descriptors are on the loaded record's metadata.
    const [record] = await hydrateFromDirectory({ root })(noCtx);
    expect(record!.metadata?.references).toContainEqual(
      expect.objectContaining({ uri: checklistUri }),
    );
  });

  it("degrades cleanly when the installer has no resources harness", async () => {
    const skillDir = await writeSkill("guide", "name: guide\ndescription: G");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(join(skillDir, "references", "checklist.md"), "content");

    const { installer, namespaces } = fakeInstaller(undefined);
    // Must not throw even though references exist and there's no resources sink.
    await withSkills({ hydrate: hydrateFromDirectory({ root }) }).install(installer);

    const skills = namespaces.get("skills") as Skills;
    expect(skills.has("guide")).toBe(true);
  });
});

// ---------------------------------------------------------------------
// C2 — allowed-tools loop closure (disk → register → composeRun)
// ---------------------------------------------------------------------

describe("hydrateFromDirectory — C2 allowed-tools loop closure", () => {
  it("a disk-loaded skill's allowed-tools reach composeRun's SendInput", async () => {
    await writeSkill(
      "restricted",
      "name: restricted\ndescription: R\nallowed-tools: [Bash, Read]",
      "Do the task.",
    );

    const harness = new SkillsHarness(
      `skills:${ulid()}`,
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await harness.ready;

    const [input] = await hydrateFromDirectory({ root })(noCtx);
    await harness.register(input as SkillsRegisterInput);

    const skill = harness.get("restricted")!;
    const send = defaultComposeRun(skill, {});
    expect(send.allowedTools).toEqual(["Bash", "Read"]);
  });
});

// ---------------------------------------------------------------------
// parseSimpleFrontmatter — the built-in minimal parser
// ---------------------------------------------------------------------

describe("parseSimpleFrontmatter", () => {
  it("parses key: value lines", () => {
    expect(parseSimpleFrontmatter("name: x\ndescription: y")).toEqual({
      name: "x",
      description: "y",
    });
  });

  it("strips quoted strings", () => {
    expect(parseSimpleFrontmatter('name: "long: name"')).toEqual({ name: "long: name" });
    expect(parseSimpleFrontmatter("name: 'with quote'")).toEqual({ name: "with quote" });
  });

  it("parses inline arrays", () => {
    expect(parseSimpleFrontmatter('tags: [a, b, "c d"]')).toEqual({ tags: ["a", "b", "c d"] });
  });

  it("ignores comments + blank lines", () => {
    expect(parseSimpleFrontmatter("# comment\n\nname: x\n# more")).toEqual({ name: "x" });
  });

  it("handles empty input", () => {
    expect(parseSimpleFrontmatter("")).toEqual({});
  });
});

// ---------------------------------------------------------------------
// hydrateFromFile — one markdown file
// ---------------------------------------------------------------------

describe("hydrateFromFile", () => {
  it("opens on a skill parsed from a markdown file with frontmatter", async () => {
    const path = join(root, "greet.md");
    await writeFile(path, "---\nname: greet\ndescription: greet the user\n---\nHello.");
    const records = await hydrateFromFile({ path })(noCtx);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      name: "greet",
      description: "greet the user",
      content: "Hello.",
    });
  });

  it("preserves the source path in metadata", async () => {
    const path = join(root, "x.md");
    await writeFile(path, "---\nname: x\ndescription: x\n---\nbody");
    const [record] = await hydrateFromFile({ path })(noCtx);
    expect(record!.metadata?.sourcePath).toBe(path);
  });

  it("parses tags from frontmatter", async () => {
    const path = join(root, "x.md");
    await writeFile(path, "---\nname: x\ndescription: x\ntags: [foo, bar]\n---\nbody");
    const [record] = await hydrateFromFile({ path })(noCtx);
    expect(record!.tags).toEqual(["foo", "bar"]);
  });

  it("rejects when frontmatter is missing — a malformed file is not a silent empty", async () => {
    const path = join(root, "x.md");
    await writeFile(path, "no frontmatter");
    await expect(hydrateFromFile({ path })(noCtx)).rejects.toThrow(/no frontmatter block/);
  });

  it("rejects when name or description is missing", async () => {
    const path = join(root, "x.md");
    await writeFile(path, "---\nname: x\n---\nbody");
    await expect(hydrateFromFile({ path })(noCtx)).rejects.toThrow(/missing required/);
  });

  it("maps an array `allowed-tools` frontmatter to allowedTools", async () => {
    const path = join(root, "x.md");
    await writeFile(path, "---\nname: x\ndescription: x\nallowed-tools: [Bash, Read]\n---\nbody");
    const [record] = await hydrateFromFile({ path })(noCtx);
    expect(record!.allowedTools).toEqual(["Bash", "Read"]);
    // Stripped from metadata — the canonical field is `allowedTools`.
    expect(record!.metadata).not.toHaveProperty("allowed-tools");
  });

  it("maps a comma-string `allowed-tools` frontmatter to allowedTools", async () => {
    const path = join(root, "x.md");
    await writeFile(path, '---\nname: x\ndescription: x\nallowed-tools: "Bash, Read"\n---\nbody');
    const [record] = await hydrateFromFile({ path })(noCtx);
    expect(record!.allowedTools).toEqual(["Bash", "Read"]);
  });
});

// ---------------------------------------------------------------------
// hydrateFromMarkdownFiles — the flat recursive walk
// ---------------------------------------------------------------------

describe("hydrateFromMarkdownFiles", () => {
  it("walks .md files recursively and skips bad records silently", async () => {
    await writeFile(join(root, "good.md"), "---\nname: good\ndescription: g\n---\nbody");
    await writeFile(join(root, "bad.md"), "no frontmatter");
    await writeFile(join(root, "ignored.txt"), "---\nname: x\n---\nbody");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "more.md"), "---\nname: more\ndescription: m\n---\nbody2");

    const records = await hydrateFromMarkdownFiles({ path: root })(noCtx);
    expect(records.map((r) => r.name).sort()).toEqual(["good", "more"]);
  });

  it("maps `allowed-tools` frontmatter on each record", async () => {
    await writeFile(
      join(root, "restricted.md"),
      "---\nname: restricted\ndescription: r\nallowed-tools: [Bash]\n---\nbody",
    );
    const [record] = await hydrateFromMarkdownFiles({ path: root })(noCtx);
    expect(record!.allowedTools).toEqual(["Bash"]);
  });
});
