/**
 * `agentSkillsDirectory` — Agent Skills (agentskills.io) layout preset (E1) +
 * `references/*` riding the resources harness (E2) + the C2 allowed-tools loop
 * closure.
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
import { agentSkillsDirectory } from "../loaders-node.js";

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

describe("agentSkillsDirectory — discovery", () => {
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

    const records = await agentSkillsDirectory({ root }).load();
    expect(records.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("defaults `name` to the directory name when frontmatter omits it", async () => {
    await writeSkill("my-skill", "description: no explicit name");
    const [record] = await agentSkillsDirectory({ root }).load();
    expect(record!.name).toBe("my-skill");
    expect(record!.description).toBe("no explicit name");
  });

  it("skips a skill directory whose SKILL.md has no description", async () => {
    await writeSkill("described", "name: described\ndescription: has one");
    await writeSkill("nodesc", "name: nodesc");
    const records = await agentSkillsDirectory({ root }).load();
    expect(records.map((r) => r.name)).toEqual(["described"]);
  });

  it("loads EMPTY when the root directory is absent", async () => {
    const records = await agentSkillsDirectory({ root: join(root, "does-not-exist") }).load();
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
    const records = await agentSkillsDirectory({ root }).load();
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

describe("agentSkillsDirectory — allowed-tools mapping", () => {
  it("maps an inline-array `allowed-tools` → allowedTools", async () => {
    await writeSkill("arr", "name: arr\ndescription: A\nallowed-tools: [Bash, Read]");
    const [record] = await agentSkillsDirectory({ root }).load();
    expect(record!.allowedTools).toEqual(["Bash", "Read"]);
  });

  it("maps a comma-separated-string `allowed-tools` → allowedTools", async () => {
    await writeSkill("str", 'name: str\ndescription: A\nallowed-tools: "Bash, Read"');
    const [record] = await agentSkillsDirectory({ root }).load();
    expect(record!.allowedTools).toEqual(["Bash", "Read"]);
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

describe("agentSkillsDirectory — references as resources (E2)", () => {
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
    await withSkills({ loaders: [agentSkillsDirectory({ root })] }).install(installer);

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
    const [record] = await agentSkillsDirectory({ root }).load();
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
    await withSkills({ loaders: [agentSkillsDirectory({ root })] }).install(installer);

    const skills = namespaces.get("skills") as Skills;
    expect(skills.has("guide")).toBe(true);
  });
});

// ---------------------------------------------------------------------
// C2 — allowed-tools loop closure (disk → register → composeRun)
// ---------------------------------------------------------------------

describe("agentSkillsDirectory — C2 allowed-tools loop closure", () => {
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

    const [input] = await agentSkillsDirectory({ root }).load();
    await harness.register(input as SkillsRegisterInput);

    const skill = harness.get("restricted")!;
    const send = defaultComposeRun(skill, {});
    expect(send.allowedTools).toEqual(["Bash", "Read"]);
  });
});
