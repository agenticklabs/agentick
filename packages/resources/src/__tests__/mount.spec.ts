import { describe, expect, it } from "vitest";
import type { ResourceContents } from "@agentick/spec";
import { fakeResources } from "../testing/fake-resources.js";
import { fakeMountStore } from "../testing/fake-mount-store.js";
import { mount, registerTree, storeResolver } from "../mounts.js";
import type { MountProjection } from "../mounts.js";
import { runResourceMountConformance } from "../mount-conformance.js";

runResourceMountConformance({ label: "fakeMountStore", makeStore: fakeMountStore });

const stripRoot = (root: string): MountProjection => ({
  toInternal: (home) => `${root}/${home}`,
  toHome: (key) => (key.startsWith(`${root}/`) ? key.slice(root.length + 1) : undefined),
});

describe("mounts through a real ResourcesHarness", () => {
  const store = fakeMountStore({
    leaves: { "tenants/42/notes/afman.md": "AFMAN body" },
    children: {
      "tenants/42/notes": [
        { name: "afman.md", kind: "leaf", meta: { description: "The AFMAN note" } },
      ],
    },
  });

  const bodyOf = (result: readonly ResourceContents[]): string => {
    const first = result[0];
    if (first === undefined || !("text" in first)) throw new Error("expected text");
    return first.text;
  };

  it("registerTree wires the root + descent; reads project to home addresses", async () => {
    const { harness, close } = await fakeResources();
    const off = registerTree(harness, "mem://", {
      notes: mount(storeResolver(store, stripRoot("tenants/42")), {
        description: "Personal notes",
      }),
    });

    const root = JSON.parse(bodyOf(await harness.read("mem://"))) as {
      children: { uri: string; description?: string }[];
    };
    expect(root.children).toContainEqual(
      expect.objectContaining({ uri: "mem://notes", description: "Personal notes" }),
    );

    const dir = JSON.parse(bodyOf(await harness.read("mem://notes"))) as {
      children: { uri: string }[];
    };
    expect(dir.children).toContainEqual(expect.objectContaining({ uri: "mem://notes/afman.md" }));

    const [leaf] = await harness.read("mem://notes/afman.md");
    expect(leaf).toMatchObject({ uri: "mem://notes/afman.md", text: "AFMAN body" });
    expect(JSON.stringify(await harness.read("mem://notes"))).not.toContain("tenants/42");

    off();
    await close();
  });
});
