/**
 * `prompt://<name>` projection (three-audiences-plan §0).
 *
 * Pins the HONEST content decision:
 *  - a function-`render` prompt → a `{ name, description, arguments }`
 *    declaration document (`application/json`); the fn is never serialized, the
 *    argument `schema` validators are dropped.
 *  - a static string `template` → served as `text/markdown`.
 * Plus: LIVE set (register-after-install + remove), opt-out, degradation.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import type { Prompts, Resources, SessionInstaller, StandardSchemaV1 } from "@agentick/spec";
import { ResourcesHarness } from "@agentick/resources";

import { withPrompts } from "../extension.js";
import { hydrateFrom } from "../hydrators.js";

/** Minimal `SessionInstaller` carrying a real resources harness (or none). */
function fakeInstaller(resources: Resources | undefined): {
  installer: SessionInstaller;
  namespaces: Map<string, unknown>;
} {
  const namespaces = new Map<string, unknown>();
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
    onClose: () => () => {},
  } as unknown as SessionInstaller;
  return { installer, namespaces };
}

function newResources(): ResourcesHarness {
  return new ResourcesHarness(
    `res:${ulid()}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
}

/** Trivial Standard-Schema (non-serializable — carries a `~standard.validate` fn). */
const passthroughSchema: StandardSchemaV1 = {
  "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) },
};

describe("prompt:// projection", () => {
  it("serves a DECLARATION DOCUMENT for a function-render prompt (schema stripped)", async () => {
    const resources = newResources();
    await resources.ready;
    const { installer } = fakeInstaller(resources);

    await withPrompts({
      hydrate: hydrateFrom([
        {
          declaration: {
            name: "summarize",
            description: "Summarize text",
            arguments: [
              { name: "text", description: "input", required: true, schema: passthroughSchema },
              { name: "tone" },
            ],
            render: (args: Record<string, unknown>) => `Summarize: ${String(args.text)}`,
          },
        },
      ]),
    }).install(installer);

    expect(resources.has("prompt://summarize")).toBe(true);
    const contents = await resources.read("prompt://summarize");
    expect(contents[0]).toMatchObject({
      uri: "prompt://summarize",
      mimeType: "application/json",
    });
    const doc = JSON.parse((contents[0] as { text: string }).text);
    expect(doc).toEqual({
      name: "summarize",
      description: "Summarize text",
      arguments: [{ name: "text", description: "input", required: true }, { name: "tone" }],
    });
    // The render fn never appears; the non-serializable schema is dropped.
    expect((contents[0] as { text: string }).text).not.toContain("~standard");
    expect((contents[0] as { text: string }).text).not.toContain("function");

    const descriptor = resources.snapshot().resources.find((r) => r.uri === "prompt://summarize");
    expect(descriptor).toMatchObject({
      name: "summarize",
      description: "Summarize text",
      mimeType: "application/json",
    });
  });

  it("serves a static string template as text/markdown", async () => {
    const resources = newResources();
    await resources.ready;
    const { installer } = fakeInstaller(resources);

    await withPrompts({
      hydrate: hydrateFrom([
        {
          declaration: {
            name: "boilerplate",
            description: "Static boilerplate",
            template: "# Boilerplate\nHello.",
          },
        },
      ]),
    }).install(installer);

    const contents = await resources.read("prompt://boilerplate");
    expect(contents[0]).toMatchObject({
      uri: "prompt://boilerplate",
      mimeType: "text/markdown",
      text: "# Boilerplate\nHello.",
    });
    const descriptor = resources.snapshot().resources.find((r) => r.uri === "prompt://boilerplate");
    expect(descriptor?.mimeType).toBe("text/markdown");
  });

  it("projects a prompt registered AFTER install and unregisters on remove", async () => {
    const resources = newResources();
    await resources.ready;
    const { installer, namespaces } = fakeInstaller(resources);

    await withPrompts().install(installer);
    expect(resources.has("prompt://late")).toBe(false);

    const prompts = namespaces.get("prompts") as Prompts;
    await prompts.register({
      declaration: { name: "late", description: "added later", template: "hi" },
    });
    expect(resources.has("prompt://late")).toBe(true);

    await prompts.remove({ name: "late" });
    expect(resources.has("prompt://late")).toBe(false);
    await expect(resources.read("prompt://late")).rejects.toMatchObject({
      _tag: "ResourceNotFound",
    });
  });

  it("does not project when exposeAsResources is false", async () => {
    const resources = newResources();
    await resources.ready;
    const { installer, namespaces } = fakeInstaller(resources);

    await withPrompts({
      hydrate: hydrateFrom([
        { declaration: { name: "hidden", description: "no resource", template: "x" } },
      ]),
      exposeAsResources: false,
    }).install(installer);

    expect(resources.has("prompt://hidden")).toBe(false);
    const prompts = namespaces.get("prompts") as Prompts;
    expect(prompts.has("hidden")).toBe(true);
  });

  it("does not throw when the installer has no resources harness", async () => {
    const { installer, namespaces } = fakeInstaller(undefined);
    await withPrompts({
      hydrate: hydrateFrom([
        { declaration: { name: "solo", description: "no sink", template: "x" } },
      ]),
    }).install(installer);

    const prompts = namespaces.get("prompts") as Prompts;
    expect(prompts.has("solo")).toBe(true);
  });
});
