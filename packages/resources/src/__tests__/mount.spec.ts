import { describe, expect, it, vi } from "vitest";
import type { ResourceContents } from "@agentick/spec";
import { fakeResources } from "../testing/fake-resources.js";
import { fakeMountStore } from "../testing/fake-mount-store.js";
import { createTree, mount, registerTree, storeResolver } from "../mounts.js";
import type { MountListQuery, MountProjection, MountStore } from "../mounts.js";
import { runResourceMountConformance } from "../mount-conformance.js";

runResourceMountConformance({ label: "fakeMountStore", makeStore: fakeMountStore });

const stripRoot = (root: string): MountProjection => ({
  toInternal: (home) => `${root}/${home}`,
  toHome: (key) => (key.startsWith(`${root}/`) ? key.slice(root.length + 1) : undefined),
});

const bodyOf = (result: readonly ResourceContents[]): string => {
  const first = result[0];
  if (first === undefined || !("text" in first)) throw new Error("expected text");
  return first.text;
};

describe("mounts through a real ResourcesHarness", () => {
  const store = fakeMountStore({
    leaves: { "tenants/42/notes/afman.md": "AFMAN body" },
    children: {
      "tenants/42/notes": [
        { name: "afman.md", kind: "leaf", meta: { description: "The AFMAN note" } },
      ],
    },
  });

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

describe("the address boundary", () => {
  const store = fakeMountStore({
    leaves: { "tenants/42/notes/afman.md": "AFMAN body", "tenants/43/secret.md": "other tenant" },
    children: { "tenants/42/notes": [{ name: "afman.md", kind: "leaf" }] },
  });
  const resolver = storeResolver(store, stripRoot("tenants/42"));

  it.each([
    ["a parent traversal", "mem://notes/../../43/secret.md"],
    ["a self segment", "mem://notes/./afman.md"],
    ["an empty interior segment", "mem://notes//afman.md"],
    ["a leading empty segment", "mem:///notes/afman.md"],
  ])("rejects %s before the store sees a key", async (_label, uri) => {
    await expect(resolver(uri)).rejects.toMatchObject({ _tag: "ResourceNotFound" });
  });

  it("a trailing slash names the same directory, not an empty one", async () => {
    const listing = JSON.parse(bodyOf(await resolver("mem://notes/"))) as {
      uri: string;
      children: { uri: string }[];
    };
    expect(listing.uri).toBe("mem://notes");
    expect(listing.children).toHaveLength(1);
  });

  it("an unroutable path is not-found, not a resolver crash", async () => {
    const tree = createTree({ notes: mount(resolver) });
    await expect(tree("mem://elsewhere/x.md")).rejects.toMatchObject({
      _tag: "ResourceNotFound",
    });
  });
});

describe("paging reaches the store", () => {
  const spyStore = (): MountStore & { calls: MountListQuery[] } => {
    const calls: MountListQuery[] = [];
    return {
      calls,
      get: vi.fn(async () => undefined),
      listChildren: async (query) => {
        calls.push(query);
        return { entries: [], cursor: query.cursor === undefined ? "afman.md" : undefined };
      },
    };
  };

  it("a mount's limit and a listing's own nextPage cursor both arrive as a query", async () => {
    const store = spyStore();
    const resolver = storeResolver(store, undefined, { limit: 25 });
    const listing = JSON.parse(bodyOf(await resolver("mem://notes"))) as { nextPage: string };
    await resolver(listing.nextPage);
    expect(store.calls).toEqual([
      { prefix: "notes", cursor: undefined, limit: 25 },
      { prefix: "notes", cursor: "afman.md", limit: 25 },
    ]);
  });
});
