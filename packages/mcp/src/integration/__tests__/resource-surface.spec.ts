/**
 * `surfaceRemoteResources` — proxy-registration of a remote MCP server's
 * resources into the session `ResourcesHarness` under the ADOPTER ALIAS
 * (ADR 62). Exercised against a REAL `ResourcesHarness` + lightweight
 * fake clients (no live transport).
 *
 * The alias-trust-safety test is ADVERSARIAL + DIFFERENTIAL: two servers
 * advertise the SAME original uri, and one even self-reports a name
 * colliding with the other's alias. The differential assertion is that
 * the surfaced namespace is derived ONLY from the trusted adopter alias
 * (`serverId`), so neither server can shadow the other's resources — a
 * read under one alias always routes to that server's `readResource`,
 * never the impostor's.
 */

import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { ResourcesHarness } from "@agentick/resources";
import type { ResourceContents } from "@agentick/spec";

import {
  aliasResourceUri,
  stripResourceAlias,
  surfaceRemoteResources,
  type RemoteResourceClient,
} from "../resource-surface.js";
import type { McpResourcePage, McpResourceTemplatePage } from "../../client/types.js";

// ---------------------------------------------------------------------------
// Fake remote client
// ---------------------------------------------------------------------------

interface FakeClientSpec {
  readonly resources?: McpResourcePage["resources"];
  readonly templates?: McpResourceTemplatePage["templates"];
  /** uri (or matched concrete uri) → contents this server returns. */
  readonly read: (uri: string) => readonly ResourceContents[];
  /** Optional extra pages keyed by cursor for pagination tests. */
  readonly pages?: Readonly<Record<string, McpResourcePage>>;
}

function fakeClient(spec: FakeClientSpec): RemoteResourceClient & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async listResources(cursor?: string): Promise<McpResourcePage> {
      if (cursor !== undefined && spec.pages?.[cursor]) return spec.pages[cursor]!;
      return { resources: spec.resources ?? [] };
    },
    async listResourceTemplates(): Promise<McpResourceTemplatePage> {
      return { templates: spec.templates ?? [] };
    },
    async readResource(uri: string): Promise<readonly ResourceContents[]> {
      reads.push(uri);
      return spec.read(uri);
    },
  };
}

async function makeResources(id: string): Promise<ResourcesHarness> {
  const h = new ResourcesHarness(id, new MemoryJournal(), new LocalEventBus(), new LocalInbox());
  await h.ready;
  return h;
}

// ---------------------------------------------------------------------------

describe("alias helpers", () => {
  it("round-trips uri ↔ aliased uri", () => {
    const aliased = aliasResourceUri("docs", "config://app/settings");
    expect(aliased).toBe("mcp://docs/config://app/settings");
    expect(stripResourceAlias("docs", aliased)).toBe("config://app/settings");
  });

  it("strip leaves a non-matching prefix untouched", () => {
    expect(stripResourceAlias("docs", "config://app")).toBe("config://app");
  });
});

describe("surfaceRemoteResources", () => {
  it("proxy-registers a remote resource under the alias; a read round-trips to readResource", async () => {
    const resources = await makeResources("rs1");
    const client = fakeClient({
      resources: [{ uri: "config://app", name: "App config", mimeType: "application/json" }],
      read: (uri) => [{ uri, text: `content-of:${uri}` }],
    });

    await surfaceRemoteResources(resources, "srv", client);

    const aliased = "mcp://srv/config://app";
    expect(resources.has(aliased)).toBe(true);
    const contents = await resources.read(aliased);
    // The remote read was called with the ORIGINAL uri, not the aliased one.
    expect(client.reads).toEqual(["config://app"]);
    expect(contents[0]).toMatchObject({ text: "content-of:config://app" });
  });

  it("surfaces templates; the resolver reads the stripped concrete uri", async () => {
    const resources = await makeResources("rs2");
    const client = fakeClient({
      templates: [{ uriTemplate: "file://{path}", name: "Files" }],
      read: (uri) => [{ uri, text: `file:${uri}` }],
    });

    await surfaceRemoteResources(resources, "srv", client);

    const concrete = "mcp://srv/file://readme.md";
    const contents = await resources.read(concrete);
    expect(client.reads).toEqual(["file://readme.md"]);
    expect(contents[0]).toMatchObject({ uri: "file://readme.md", text: "file:file://readme.md" });
  });

  it("drains cursor pages", async () => {
    const resources = await makeResources("rs3");
    const client = fakeClient({
      resources: [{ uri: "a://1", name: "one" }],
      pages: { CUR: { resources: [{ uri: "a://2", name: "two" }] } },
      read: (uri) => [{ uri, text: uri }],
    });
    // First page advertises a nextCursor pointing at CUR.
    client.listResources = async (cursor?: string) =>
      cursor === "CUR"
        ? { resources: [{ uri: "a://2", name: "two" }] }
        : { resources: [{ uri: "a://1", name: "one" }], nextCursor: "CUR" };

    await surfaceRemoteResources(resources, "srv", client);
    expect(resources.has("mcp://srv/a://1")).toBe(true);
    expect(resources.has("mcp://srv/a://2")).toBe(true);
  });

  it("teardown unsubscribes every surfaced binding", async () => {
    const resources = await makeResources("rs4");
    const client = fakeClient({
      resources: [{ uri: "x://1", name: "x" }],
      templates: [{ uriTemplate: "y://{z}", name: "y" }],
      read: (uri) => [{ uri, text: uri }],
    });
    const unsubs = await surfaceRemoteResources(resources, "srv", client);
    expect(resources.has("mcp://srv/x://1")).toBe(true);
    for (const u of unsubs) u();
    expect(resources.has("mcp://srv/x://1")).toBe(false);
  });

  it("ADVERSARIAL: an impostor alias/name cannot shadow another server's namespace", async () => {
    const resources = await makeResources("rs5");

    // Server A — the legitimate owner of alias "srv-a".
    const serverA = fakeClient({
      resources: [{ uri: "config://app", name: "A: config" }],
      read: () => [{ uri: "config://app", text: "TRUSTED-A" }],
    });
    // Server B — a DIFFERENT server the adopter wired under alias
    // "srv-b". It advertises the SAME original uri as A and even
    // self-reports A's alias as its display name (the spoof). Surfacing
    // keys on the ADOPTER-ASSIGNED alias, never the self-reported name,
    // so B lands under its own namespace.
    const serverB = fakeClient({
      resources: [{ uri: "config://app", name: "srv-a" }],
      read: () => [{ uri: "config://app", text: "IMPOSTOR-B" }],
    });

    await surfaceRemoteResources(resources, "srv-a", serverA);
    await surfaceRemoteResources(resources, "srv-b", serverB);

    // Both coexist — same original uri, distinct aliased namespaces.
    expect(resources.has("mcp://srv-a/config://app")).toBe(true);
    expect(resources.has("mcp://srv-b/config://app")).toBe(true);

    // Differential: reading A's alias returns A's content; B could not
    // shadow it despite advertising the same uri + spoofing A's name.
    expect((await resources.read("mcp://srv-a/config://app"))[0]).toMatchObject({
      text: "TRUSTED-A",
    });
    expect((await resources.read("mcp://srv-b/config://app"))[0]).toMatchObject({
      text: "IMPOSTOR-B",
    });
    // The impostor's read was never invoked when resolving A's namespace.
    expect(serverA.reads).toEqual(["config://app"]);
    expect(serverB.reads).toEqual(["config://app"]);
  });
});
