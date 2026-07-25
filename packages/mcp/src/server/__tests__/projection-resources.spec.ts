/**
 * End-to-end round-trip for the resources projection (ADR 62, #237).
 *
 * Drives the full path: ResourcesHarness → McpServerHarness → in-memory
 * connection → SDK Client → initialize handshake → every `resources/*`
 * op + both notifications.
 *
 * Pins:
 *  - `resources` capability advertised (with subscribe + listChanged)
 *    iff the resources slot was wired; absent otherwise
 *  - `resources/list` reflects the harness registry (per-conn filter applied)
 *  - `resources/templates/list` reflects registered templates
 *  - `resources/read` runs the resolver (fixed + templated), maps text/blob
 *  - Per-connection filter hides a fixed resource from BOTH list and read
 *  - unknown uri → JSON-RPC resource-not-found
 *  - `resources/subscribe` → `notifications/resources/updated` on notifyUpdated
 *  - `notifications/resources/list_changed` on register / unregister
 *  - Connection close tears down subscriptions (no leak)
 */

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";
import type { ResourceContents } from "@agentick/spec";
import { ResourcesHarness } from "@agentick/resources";

import { inMemoryServerTransport, McpServerHarness } from "../index.js";
import type { ResourcesFilter } from "../index.js";

function text(uri: string, body: string): ResourceContents {
  return { uri, mimeType: "text/plain", text: body };
}

async function makeResourcesHarness(): Promise<ResourcesHarness> {
  const h = new ResourcesHarness(
    `resources:${ulid()}`,
    new MemoryJournal({ capacity: 256 }),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await h.ready;
  return h;
}

async function makeServer(
  resources: ResourcesHarness | undefined,
  options: { readonly filter?: ResourcesFilter } = {},
): Promise<{
  readonly harness: McpServerHarness;
  readonly transport: ReturnType<typeof inMemoryServerTransport>;
}> {
  const transport = inMemoryServerTransport();
  const harness = new McpServerHarness(
    `srv:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {
      name: "test-server",
      transports: [transport],
      ...(resources
        ? { resources: { use: resources, ...(options.filter ? { filter: options.filter } : {}) } }
        : {}),
      serverInfo: { name: "test", version: "0.0.0" },
    },
  );
  await harness.ready;
  await harness.start();
  return { harness, transport };
}

async function makeClient(
  transport: Awaited<ReturnType<ReturnType<typeof inMemoryServerTransport>["connect"]>>,
): Promise<McpClient> {
  const client = new McpClient({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

describe("resources projection — capability negotiation", () => {
  it("advertises resources capability (subscribe + listChanged) when wired", async () => {
    const resources = await makeResourcesHarness();
    const { harness, transport } = await makeServer(resources);
    const client = await makeClient(await transport.connect());

    const caps = client.getServerCapabilities()?.resources;
    expect(caps).toBeDefined();
    expect(caps).toMatchObject({ subscribe: true, listChanged: true });

    await client.close();
    await harness.close();
    await resources.close();
  });

  it("does NOT advertise resources capability without the slot", async () => {
    const { harness, transport } = await makeServer(undefined);
    const client = await makeClient(await transport.connect());
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    await client.close();
    await harness.close();
  });

  it("server.resources returns null when no resources slot is wired", async () => {
    const { harness } = await makeServer(undefined);
    expect(harness.resources).toBeNull();
    await harness.close();
  });
});

describe("resources projection — list + read", () => {
  it("resources/list returns registered fixed resources with metadata", async () => {
    const resources = await makeResourcesHarness();
    resources.register("mem://a", () => [text("mem://a", "A")], {
      name: "Alpha",
      description: "the a",
      mimeType: "text/plain",
    });
    resources.register("mem://b", () => [text("mem://b", "B")]);

    const { harness, transport } = await makeServer(resources);
    const client = await makeClient(await transport.connect());

    const list = await client.listResources();
    expect(list.resources.map((r) => r.uri).sort()).toEqual(["mem://a", "mem://b"]);
    const a = list.resources.find((r) => r.uri === "mem://a")!;
    expect(a).toMatchObject({ name: "Alpha", description: "the a", mimeType: "text/plain" });

    await client.close();
    await harness.close();
    await resources.close();
  });

  it("resources/templates/list returns registered templates", async () => {
    const resources = await makeResourcesHarness();
    resources.registerTemplate("mem://users/{id}", (u) => [text(u, u)], { name: "User" });

    const { harness, transport } = await makeServer(resources);
    const client = await makeClient(await transport.connect());

    const list = await client.listResourceTemplates();
    expect(list.resourceTemplates).toHaveLength(1);
    expect(list.resourceTemplates[0]).toMatchObject({
      uriTemplate: "mem://users/{id}",
      name: "User",
    });

    await client.close();
    await harness.close();
    await resources.close();
  });

  it("resources/read runs a fixed resolver and maps text contents", async () => {
    const resources = await makeResourcesHarness();
    resources.register("mem://doc", () => [text("mem://doc", "hello")]);

    const { harness, transport } = await makeServer(resources);
    const client = await makeClient(await transport.connect());

    const result = await client.readResource({ uri: "mem://doc" });
    expect(result.contents).toEqual([{ uri: "mem://doc", mimeType: "text/plain", text: "hello" }]);

    await client.close();
    await harness.close();
    await resources.close();
  });

  it("resources/read runs a template resolver with the concrete uri", async () => {
    const resources = await makeResourcesHarness();
    resources.registerTemplate("mem://users/{id}", (uri) => [text(uri, `user:${uri}`)]);

    const { harness, transport } = await makeServer(resources);
    const client = await makeClient(await transport.connect());

    const result = await client.readResource({ uri: "mem://users/7" });
    expect(result.contents).toEqual([
      { uri: "mem://users/7", mimeType: "text/plain", text: "user:mem://users/7" },
    ]);

    await client.close();
    await harness.close();
    await resources.close();
  });

  it("resources/read maps blob contents", async () => {
    const resources = await makeResourcesHarness();
    resources.register("mem://bin", () => [
      { uri: "mem://bin", mimeType: "application/octet-stream", blob: "YmluYXJ5" },
    ]);

    const { harness, transport } = await makeServer(resources);
    const client = await makeClient(await transport.connect());

    const result = await client.readResource({ uri: "mem://bin" });
    expect(result.contents).toEqual([
      { uri: "mem://bin", mimeType: "application/octet-stream", blob: "YmluYXJ5" },
    ]);

    await client.close();
    await harness.close();
    await resources.close();
  });

  it("resources/read of an unknown uri rejects with a not-found error", async () => {
    const resources = await makeResourcesHarness();
    const { harness, transport } = await makeServer(resources);
    const client = await makeClient(await transport.connect());

    await expect(client.readResource({ uri: "mem://nope" })).rejects.toThrow(/not found/i);

    await client.close();
    await harness.close();
    await resources.close();
  });
});

describe("resources projection — per-connection filter", () => {
  it("filter hides a fixed resource from BOTH list and read", async () => {
    const resources = await makeResourcesHarness();
    resources.register("public://thing", () => [text("public://thing", "pub")]);
    resources.register("internal://secret", () => [text("internal://secret", "sec")]);

    const { harness, transport } = await makeServer(resources, {
      filter: (r) => r.uri.startsWith("public://"),
    });
    const client = await makeClient(await transport.connect());

    const list = await client.listResources();
    expect(list.resources.map((r) => r.uri)).toEqual(["public://thing"]);
    await expect(client.readResource({ uri: "internal://secret" })).rejects.toThrow(/not found/i);

    await client.close();
    await harness.close();
    await resources.close();
  });
});

describe("resources projection — notifications", () => {
  it("subscribe → notifications/resources/updated on notifyUpdated", async () => {
    const resources = await makeResourcesHarness();
    resources.register("mem://watched", () => [text("mem://watched", "v1")]);

    const { harness, transport } = await makeServer(resources);
    const client = await makeClient(await transport.connect());

    const updated: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
      updated.push(n.params.uri);
    });

    await client.subscribeResource({ uri: "mem://watched" });
    resources.notifyUpdated("mem://watched");
    await new Promise((r) => setTimeout(r, 10));
    expect(updated).toEqual(["mem://watched"]);

    await client.close();
    await harness.close();
    await resources.close();
  });

  it("unsubscribe stops further updated notifications", async () => {
    const resources = await makeResourcesHarness();
    resources.register("mem://w", () => [text("mem://w", "v")]);
    const { harness, transport } = await makeServer(resources);
    const client = await makeClient(await transport.connect());

    let updates = 0;
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async () => {
      updates += 1;
    });

    await client.subscribeResource({ uri: "mem://w" });
    resources.notifyUpdated("mem://w");
    await new Promise((r) => setTimeout(r, 10));
    expect(updates).toBe(1);

    await client.unsubscribeResource({ uri: "mem://w" });
    resources.notifyUpdated("mem://w");
    await new Promise((r) => setTimeout(r, 10));
    expect(updates).toBe(1);

    await client.close();
    await harness.close();
    await resources.close();
  });

  it("emits notifications/resources/list_changed on register/unregister", async () => {
    const resources = await makeResourcesHarness();
    const { harness, transport } = await makeServer(resources);
    const client = await makeClient(await transport.connect());

    let notified = 0;
    client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      notified += 1;
    });

    const unregister = resources.register("mem://x", () => [text("mem://x", "x")]);
    await new Promise((r) => setTimeout(r, 10));
    expect(notified).toBeGreaterThanOrEqual(1);

    const before = notified;
    unregister();
    await new Promise((r) => setTimeout(r, 10));
    expect(notified).toBeGreaterThan(before);

    await client.close();
    await harness.close();
    await resources.close();
  });

  it("connection close unsubscribes the list_changed notifier — no further fire", async () => {
    const resources = await makeResourcesHarness();
    const { harness, transport } = await makeServer(resources);
    const client = await makeClient(await transport.connect());

    let notified = 0;
    client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      notified += 1;
    });

    resources.register("mem://a", () => [text("mem://a", "a")]);
    await new Promise((r) => setTimeout(r, 10));
    const beforeClose = notified;
    expect(beforeClose).toBeGreaterThanOrEqual(1);

    await client.close();
    resources.register("mem://b", () => [text("mem://b", "b")]);
    await new Promise((r) => setTimeout(r, 10));
    expect(notified).toBe(beforeClose);

    await harness.close();
    await resources.close();
  });
});
