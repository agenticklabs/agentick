/**
 * `skill://<name>` body projection (three-audiences-plan §0 / §E2).
 *
 * Pins:
 *  - register-then-read: `skill://<name>` returns the skill content through the
 *    resources harness; the projected descriptor carries name + description +
 *    `text/markdown`.
 *  - LIVE resolver: an `update` reflects on the next read WITHOUT a re-wire.
 *  - LIVE set: a skill registered AFTER install projects; a removed skill
 *    unregisters (read then degrades to a resolver error).
 *  - `exposeAsResources: false` → no `skill://` resource.
 *  - Coexistence with E2: a disk skill with `references/` has BOTH the body uri
 *    (`skill://<name>`) and the reference uris (`skill://<name>/references/*`).
 *  - No resources harness (stub installer) → skills still install, no throw.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { Resources, SessionInstaller, Skills } from "@agentick/spec";
import { ResourcesHarness } from "@agentick/resources";

import { withSkills } from "../extension.js";
import { hydrateFrom } from "../hydrators.js";
import { hydrateFromDirectory } from "../hydrators-node.js";

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

function newResources(): ResourcesHarness {
  return new ResourcesHarness(
    `res:${generateId()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
}

describe("skill:// body projection", () => {
  it("projects each registered skill as a readable skill://<name> resource", async () => {
    const resources = newResources();
    await resources.ready;
    const { installer } = fakeInstaller(resources);

    await withSkills({
      hydrate: hydrateFrom([{ name: "greet", description: "Say hi", content: "# Greet\nSay hi." }]),
    }).install(installer);

    expect(resources.has("skill://greet")).toBe(true);
    const contents = await resources.read("skill://greet");
    expect(contents[0]).toMatchObject({
      uri: "skill://greet",
      text: "# Greet\nSay hi.",
      mimeType: "text/markdown",
    });

    const descriptor = resources.snapshot().resources.find((r) => r.uri === "skill://greet");
    expect(descriptor).toMatchObject({
      uri: "skill://greet",
      name: "greet",
      description: "Say hi",
      mimeType: "text/markdown",
    });
  });

  it("reads the LIVE harness — an update reflects on the next read", async () => {
    const resources = newResources();
    await resources.ready;
    const { installer, namespaces } = fakeInstaller(resources);

    await withSkills({
      hydrate: hydrateFrom([{ name: "recipe", description: "v1", content: "step one" }]),
    }).install(installer);

    const skills = namespaces.get("skills") as Skills;
    await skills.update({ name: "recipe", content: "step one\nstep two" });

    const contents = await resources.read("skill://recipe");
    expect(contents[0]).toMatchObject({ text: "step one\nstep two" });
  });

  it("projects a skill registered AFTER install (live set)", async () => {
    const resources = newResources();
    await resources.ready;
    const { installer, namespaces } = fakeInstaller(resources);

    await withSkills().install(installer);
    expect(resources.has("skill://late")).toBe(false);

    const skills = namespaces.get("skills") as Skills;
    await skills.register({ name: "late", description: "added later", content: "body" });

    expect(resources.has("skill://late")).toBe(true);
    const contents = await resources.read("skill://late");
    expect(contents[0]).toMatchObject({ uri: "skill://late", text: "body" });
  });

  it("unregisters the resource when its skill is removed", async () => {
    const resources = newResources();
    await resources.ready;
    const { installer, namespaces } = fakeInstaller(resources);

    await withSkills({
      hydrate: hydrateFrom([{ name: "temp", description: "ephemeral", content: "gone soon" }]),
    }).install(installer);
    expect(resources.has("skill://temp")).toBe(true);

    const skills = namespaces.get("skills") as Skills;
    await skills.remove({ name: "temp" });

    expect(resources.has("skill://temp")).toBe(false);
    // The resource is gone — read degrades (ResourceNotFound from the harness).
    await expect(resources.read("skill://temp")).rejects.toMatchObject({
      _tag: "ResourceNotFound",
    });
  });

  it("does not project when exposeAsResources is false", async () => {
    const resources = newResources();
    await resources.ready;
    const { installer, namespaces } = fakeInstaller(resources);

    await withSkills({
      hydrate: hydrateFrom([{ name: "hidden", description: "no resource", content: "x" }]),
      exposeAsResources: false,
    }).install(installer);

    expect(resources.has("skill://hidden")).toBe(false);
    // The skills namespace still works — the body door is off, not the harness.
    const skills = namespaces.get("skills") as Skills;
    expect(skills.has("hidden")).toBe(true);
  });

  it("does not throw when the installer has no resources harness", async () => {
    const { installer, namespaces } = fakeInstaller(undefined);
    await withSkills({
      hydrate: hydrateFrom([{ name: "solo", description: "no sink", content: "x" }]),
    }).install(installer);

    const skills = namespaces.get("skills") as Skills;
    expect(skills.has("solo")).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Coexistence with E2 references — body uri AND reference uris live together
// ---------------------------------------------------------------------

describe("skill:// body projection — coexistence with E2 references", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skill-projection-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("a disk skill with references has BOTH the body uri and the reference uris", async () => {
    const skillDir = join(root, "guide");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: guide\ndescription: G\n---\nGuide body.",
    );
    await writeFile(join(skillDir, "references", "checklist.md"), "# Checklist");

    const resources = newResources();
    await resources.ready;
    const { installer } = fakeInstaller(resources);

    await withSkills({ hydrate: hydrateFromDirectory({ root }) }).install(installer);

    // Body — the new projection.
    expect(resources.has("skill://guide")).toBe(true);
    const body = await resources.read("skill://guide");
    expect(body[0]).toMatchObject({ uri: "skill://guide", text: "Guide body." });

    // Reference file — E2, distinct uri, coexists.
    const refUri = "skill://guide/references/checklist.md";
    expect(resources.has(refUri)).toBe(true);
    const ref = await resources.read(refUri);
    expect(ref[0]).toMatchObject({ uri: refUri, text: "# Checklist" });
  });
});
