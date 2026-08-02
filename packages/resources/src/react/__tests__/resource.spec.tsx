/**
 * `<Resource>` + the `resources` catalog default projection —
 * integration against the REAL `CompilerHarness` + a REAL
 * `ResourcesHarness` bridge (per the modularity rule: cross-harness
 * tests live where their deps live; @agentick/resources/react depends on
 * compiler-react).
 *
 * Verifies:
 *   - rendering `<Resource>` registers a `uri → resolver` binding on the
 *     resources bridge; a read resolves the content.
 *   - the three content sources (static `content`, `resolver` prop,
 *     function child) all resolve.
 *   - the template variant resolves the CONCRETE matched uri.
 *   - unmounting unregisters.
 *   - the `resources` default projection folds the catalog into the IR
 *     (a `grounding` message entry per ADR 94, provenance
 *     `default:resources`), and a `<Project projectionKey="resources">`
 *     override suppresses it.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { fakeBridges } from "@agentick/compiler";
import { Project, CompilerHarness } from "@agentick/compiler-react";
import type { HookBridges } from "@agentick/spec";

import { ResourcesHarness } from "../../harness.js";
import { Resource } from "../resource.js";

async function makeHarness(): Promise<CompilerHarness> {
  const harness = new CompilerHarness(
    `h_resource_${Math.random().toString(36).slice(2)}`,
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

function bridgesWith(resources: ResourcesHarness): HookBridges {
  return { ...fakeBridges(), resources } as HookBridges;
}

describe("<Resource> — registration + read", () => {
  it("registers static content and resolves it through the bridge", async () => {
    const resources = new ResourcesHarness(
      "r1",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await resources.ready;
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m1",
      sessionId: "s1",
      element: React.createElement(Resource, {
        uri: "config://app",
        name: "App config",
        mimeType: "application/json",
        content: '{"debug":true}',
      }),
      bridges: bridgesWith(resources),
    });
    await harness.renderTree({ mountId: "m1", sessionId: "s1" });

    expect(resources.has("config://app")).toBe(true);
    const contents = await resources.read("config://app");
    expect(contents).toEqual([
      { uri: "config://app", text: '{"debug":true}', mimeType: "application/json" },
    ]);
  });

  it("resolves via a `resolver` prop and a function child identically", async () => {
    const resources = new ResourcesHarness(
      "r2",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await resources.ready;
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m2",
      sessionId: "s2",
      element: React.createElement(
        React.Fragment,
        null,
        React.createElement(Resource, {
          uri: "prop://x",
          resolver: () => "from-prop",
        }),
        React.createElement(Resource, { uri: "child://y", children: () => "from-child" }),
      ),
      bridges: bridgesWith(resources),
    });
    await harness.renderTree({ mountId: "m2", sessionId: "s2" });

    expect((await resources.read("prop://x"))[0]).toMatchObject({ text: "from-prop" });
    expect((await resources.read("child://y"))[0]).toMatchObject({ text: "from-child" });
  });

  it("template variant resolves the concrete matched uri", async () => {
    const resources = new ResourcesHarness(
      "r3",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await resources.ready;
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m3",
      sessionId: "s3",
      element: React.createElement(Resource, {
        uriTemplate: "file://{name}",
        children: (uri: string) => `read:${uri}`,
      }),
      bridges: bridgesWith(resources),
    });
    await harness.renderTree({ mountId: "m3", sessionId: "s3" });

    const contents = await resources.read("file://readme");
    expect(contents[0]).toMatchObject({ uri: "file://readme", text: "read:file://readme" });
  });

  it("unmounting unregisters the binding", async () => {
    const resources = new ResourcesHarness(
      "r4",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await resources.ready;
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m4",
      sessionId: "s4",
      element: React.createElement(Resource, { uri: "gone://soon", content: "x" }),
      bridges: bridgesWith(resources),
    });
    await harness.renderTree({ mountId: "m4", sessionId: "s4" });
    expect(resources.has("gone://soon")).toBe(true);

    // Re-render with the Resource removed → its useEffect cleanup fires.
    await harness.rerender({ mountId: "m4", element: React.createElement(React.Fragment, null) });
    expect(resources.has("gone://soon")).toBe(false);
  });
});

describe("resources default projection (catalog surfacing)", () => {
  it("folds registered resources into a catalog grounding entry tagged default:resources", async () => {
    const resources = new ResourcesHarness(
      "r5",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await resources.ready;
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m5",
      sessionId: "s5",
      element: React.createElement(Resource, {
        uri: "config://app",
        name: "App config",
        description: "Runtime configuration",
      }),
      bridges: bridgesWith(resources),
    });
    const { tree } = await harness.renderTree({ mountId: "m5", sessionId: "s5" });

    // ADR 94: the catalog is a `grounding` message whose content is the
    // lowered section — the title leads its single coalesced text block.
    const section = tree.context.entries.find(
      (e) => e.role === "grounding" && e.id === "resources-catalog",
    );
    expect(section).toBeDefined();
    const text = (section!.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("# Available resources");
    expect(text).toContain("config://app");
    expect(text).toContain("Runtime configuration");

    const idx = tree.context.entries.indexOf(section!);
    expect(tree.provenance?.entries?.[idx]).toBe("default:resources");
  });

  it("contributes nothing when the registry is empty", async () => {
    const resources = new ResourcesHarness(
      "r6",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await resources.ready;
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m6",
      sessionId: "s6",
      element: React.createElement(React.Fragment, null),
      bridges: bridgesWith(resources),
    });
    const { tree } = await harness.renderTree({ mountId: "m6", sessionId: "s6" });
    expect(
      tree.context.entries.some((e) => e.role === "grounding" && e.id === "resources-catalog"),
    ).toBe(false);
  });

  it('a <Project projectionKey="resources"> override suppresses the default', async () => {
    const resources = new ResourcesHarness(
      "r7",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await resources.ready;
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m7",
      sessionId: "s7",
      element: React.createElement(
        React.Fragment,
        null,
        React.createElement(Resource, { uri: "config://app", content: "x" }),
        React.createElement(Project, { projectionKey: "resources" }),
      ),
      bridges: bridgesWith(resources),
    });
    const { tree } = await harness.renderTree({ mountId: "m7", sessionId: "s7" });
    // The default is suppressed — no auto catalog section.
    expect(
      tree.context.entries.some((e) => e.role === "grounding" && e.id === "resources-catalog"),
    ).toBe(false);
    // ...but the binding still registered (registration is a separate axis).
    expect(resources.has("config://app")).toBe(true);
  });
});
