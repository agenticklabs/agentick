/**
 * Conformance suite for {@link MountStore}-backed resource mounts.
 *
 * Certifies that ANY store driven through `storeResolver` / `createTree`
 * upholds the mount invariants:
 *
 *   1. **get / list round-trip** — a leaf uri resolves to the store's content
 *      under its home address; a directory uri lists its children.
 *   2. **projection round-trip is fail-closed** — a child whose internal key
 *      does not project (`toHome` → undefined) is DROPPED from the listing,
 *      and reading that child DIRECTLY is not-found rather than a bypass.
 *   3. **id-elision** — with a stripping projection, NO internal-key substring
 *      appears anywhere in the serialized response, `nextPage` included (the
 *      load-bearing pin).
 *   4. **longest-prefix routing** — an incoming path routes to the deepest
 *      matching mount.
 *   5. **boundary correctness** — `clients/jo` is NOT under `clients/johnson/`.
 *   6. **root merge** — reading the empty path lists every mount with its
 *      `meta.description` (the workspace-legend source).
 */

import { describe, expect, it } from "vitest";
import type { ResourceContents, ResourceResolver } from "@agentick/spec";
import type { Child, MountProjection, MountStore } from "./mounts.js";
import { createTree, mount, storeResolver } from "./mounts.js";

export interface MountConformanceInput {
  readonly label: string;
  /** Build a store seeded to the canonical fixture below. */
  readonly makeStore: (seed: FixtureSeed) => MountStore;
}

export interface FixtureSeed {
  readonly leaves: Readonly<Record<string, string>>;
  readonly children: Readonly<Record<string, readonly Child[]>>;
  /** internal prefix → the cursor its first page must report. */
  readonly cursors: Readonly<Record<string, string>>;
}

const ROOT = "tenants/42";

const stripRoot: MountProjection = {
  toInternal: (home) => `${ROOT}/${home}`,
  toHome: (key) => {
    if (!key.startsWith(`${ROOT}/`)) return undefined;
    const home = key.slice(ROOT.length + 1);
    return home.split("/").some((seg) => seg.startsWith("_")) ? undefined : home;
  },
};

const FIXTURE: FixtureSeed = {
  leaves: {
    [`${ROOT}/notes/afman.md`]: "AFMAN body",
    [`${ROOT}/notes/_draft.md`]: "draft body",
  },
  children: {
    [`${ROOT}/notes`]: [
      {
        name: "afman.md",
        kind: "leaf",
        meta: { description: "The AFMAN note", title: "AFMAN", size: 11 },
      },
      { name: "_draft.md", kind: "leaf" },
    ],
  },
  cursors: { [`${ROOT}/notes`]: "afman.md" },
};

function firstText(result: readonly ResourceContents[]): string {
  const first = result[0];
  if (first === undefined || !("text" in first))
    throw new Error("expected a text ResourceContents");
  return first.text;
}

function sentinel(name: string): ResourceResolver {
  return async (uri) => [{ uri, mimeType: "text/plain", text: name }];
}

export function runResourceMountConformance(input: MountConformanceInput): void {
  describe(`ResourceMount conformance — ${input.label}`, () => {
    const store = input.makeStore(FIXTURE);

    it("get round-trip: a leaf resolves to its content under a home address", async () => {
      const resolver = storeResolver(store, stripRoot);
      const [content] = await resolver("mem://notes/afman.md");
      expect(content).toMatchObject({ uri: "mem://notes/afman.md", text: "AFMAN body" });
    });

    it("list round-trip: a directory lists projected children carrying their whole meta", async () => {
      const resolver = storeResolver(store, stripRoot);
      const listing = JSON.parse(firstText(await resolver("mem://notes"))) as {
        uri: string;
        children: { uri: string; description?: string }[];
      };
      expect(listing.uri).toBe("mem://notes");
      expect(listing.children).toContainEqual({
        uri: "mem://notes/afman.md",
        name: "afman.md",
        kind: "leaf",
        title: "AFMAN",
        description: "The AFMAN note",
        size: 11,
      });
    });

    it("fail-closed: a child whose key does not project is dropped", async () => {
      const resolver = storeResolver(store, stripRoot);
      const listing = JSON.parse(firstText(await resolver("mem://notes"))) as {
        children: { uri: string }[];
      };
      expect(listing.children).toHaveLength(1);
      expect(JSON.stringify(listing)).not.toContain("_draft");
    });

    it("fail-closed: reading a dropped child DIRECTLY is not-found, not a bypass", async () => {
      const resolver = storeResolver(store, stripRoot);
      await expect(resolver("mem://notes/_draft.md")).rejects.toMatchObject({
        _tag: "ResourceNotFound",
      });
    });

    it("id-elision: no internal-key substring appears in any emitted address", async () => {
      const resolver = storeResolver(store, stripRoot);
      const serialized = JSON.stringify(await resolver("mem://notes"));
      expect(serialized).not.toContain(ROOT);
      expect(serialized).not.toContain("tenants");
    });

    it("id-elision covers the cursor: nextPage is an id-free, readable address", async () => {
      const resolver = storeResolver(store, stripRoot);
      const listing = JSON.parse(firstText(await resolver("mem://notes"))) as {
        nextPage?: string;
      };
      expect(listing.nextPage).toBeDefined();
      expect(listing.nextPage).not.toContain("tenants");
      const next = JSON.parse(firstText(await resolver(listing.nextPage as string))) as {
        uri: string;
      };
      expect(next.uri).toBe("mem://notes");
      expect(JSON.stringify(next)).not.toContain("tenants");
    });

    it("longest-prefix routing + boundary correctness", async () => {
      const tree = createTree({
        clients: mount(sentinel("clients"), { description: "All clients" }),
        "clients/johnson": mount(sentinel("johnson"), { description: "Johnson account" }),
      });
      expect(firstText(await tree("mem://clients/johnson/brief.md"))).toBe("johnson");
      expect(firstText(await tree("mem://clients/jo"))).toBe("clients");
    });

    it("a computed tree is rebuilt per read, so no ctx ever serves another's tree", async () => {
      let builds = 0;
      const tree = createTree((ctx) => {
        builds += 1;
        return { notes: mount(sentinel(ctx?.requestId ?? "?"), { description: "Notes" }) };
      });
      const a = { requestId: "r-a" } as never;
      const b = { requestId: "r-b" } as never;
      await tree("mem://notes", a);
      await tree("mem://notes", a);
      expect(builds).toBe(2);
      expect(firstText(await tree("mem://notes", b))).toBe("r-b");
      expect(firstText(await tree("mem://notes", a))).toBe("r-a");
    });

    it("root merge: the empty path lists mounts with their descriptions", async () => {
      const tree = createTree({
        clients: mount(sentinel("clients"), { description: "All clients" }),
        "clients/johnson": mount(sentinel("johnson"), { description: "Johnson account" }),
      });
      const root = JSON.parse(firstText(await tree("mem://"))) as {
        children: { uri: string; description?: string }[];
      };
      expect(root.children.map((c) => c.description)).toEqual(["All clients", "Johnson account"]);
    });
  });
}
