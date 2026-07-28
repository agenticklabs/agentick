/**
 * `resourcesHandle` — the client-side resources handle on the `ClientHandle`
 * contract (ADR 87). RPC-backed (no `resources-state` channel yet), so the
 * descriptor read side is a poll: an eager `resources/list` seeds the snapshot
 * (unwrapped from `ResourcesListResult.resources`). `read` / `listTemplates`
 * are pure RPC. These tests pin the wire request shapes per verb.
 */

import { describe, expect, it } from "vitest";
import type {
  ResourceContents,
  ResourceDescriptor,
  ResourceTemplateDescriptor,
  ResourcesListResult,
  ResourcesListTemplatesResult,
  WireMethod,
  WireParams,
  WireResult,
} from "@agentick/spec";
import { waitFor, waitForStable } from "@agentick/utils/testing";

import { resourcesHandle } from "../resources-handle.js";

interface Captured {
  method: WireMethod;
  params: unknown;
}

const RESOURCES: readonly ResourceDescriptor[] = [
  { uri: "file:///a.txt", name: "a", description: "A" },
  { uri: "file:///b.txt", name: "b", mimeType: "text/plain" },
];
const TEMPLATES: readonly ResourceTemplateDescriptor[] = [
  { uriTemplate: "file:///{name}.txt", name: "byName" },
];
const CONTENTS: readonly ResourceContents[] = [
  { uri: "file:///a.txt", mimeType: "text/plain", text: "hello" },
];

/** Fake command client: records every request; scripted results per method. */
function fakeCommandClient(captured: Captured[]) {
  return {
    transport: {
      async request<M extends WireMethod>(
        method: M,
        params: WireParams<M>,
      ): Promise<WireResult<M>> {
        captured.push({ method, params });
        if (method === "resources/list") {
          return { resources: RESOURCES } satisfies ResourcesListResult as WireResult<M>;
        }
        if (method === "resources/listTemplates") {
          return { templates: TEMPLATES } satisfies ResourcesListTemplatesResult as WireResult<M>;
        }
        if (method === "resources/read") return CONTENTS as WireResult<M>;
        return null as WireResult<M>;
      },
    },
  };
}

/**
 * Fake whose FIRST request lands only after a MACROTASK — so a subscriber is
 * registered while the seed is still in flight — and, with `failFirst`, throws
 * instead of answering.
 */
function seedGatedClient(captured: Captured[], opts: { readonly failFirst?: boolean } = {}) {
  const ok = fakeCommandClient(captured);
  let calls = 0;
  return {
    transport: {
      async request<M extends WireMethod>(
        method: M,
        params: WireParams<M>,
      ): Promise<WireResult<M>> {
        const first = ++calls === 1;
        if (first) await new Promise((r) => setTimeout(r, 0));
        if (first && opts.failFirst) throw new Error("transport down");
        return ok.transport.request(method, params);
      },
    },
  };
}

describe("resourcesHandle — the eager seed", () => {
  it("notifies subscribers when the seed lands — nothing to await at boot", async () => {
    const captured: Captured[] = [];
    const handle = resourcesHandle(seedGatedClient(captured), "s1");
    let notified = 0;
    const stop = handle.subscribe(() => {
      notified += 1;
    });

    // Render what you have: the snapshot is empty while the seed is in flight…
    expect(handle.list()).toEqual([]);
    // …and re-render when it arrives. No boot `refresh()`, nothing awaited.
    await waitFor(() => notified > 0);

    expect(handle.list()).toEqual(RESOURCES);
    // ONE poll — the seed. A boot-time `refresh()` would be a second.
    expect(captured).toHaveLength(1);
    stop();
  });

  it("a seed that fails settles the snapshot empty; refresh() recovers it", async () => {
    const captured: Captured[] = [];
    const handle = resourcesHandle(seedGatedClient(captured, { failFirst: true }), "s1");

    // A failed seed throws nothing at the caller and leaves no half-filled
    // snapshot — it settles empty, which is what the read surface then reports.
    expect(await waitForStable(() => handle.list())).toEqual([]);

    await handle.refresh();
    expect(handle.list()).toEqual(RESOURCES);
  });
});

describe("resourcesHandle", () => {
  it("list()/get() reflect the eager resources/list poll (unwrapped from .resources)", async () => {
    const captured: Captured[] = [];
    const handle = resourcesHandle(fakeCommandClient(captured), "s1");

    await waitFor(() => handle.list().length > 0);

    expect(handle.list()).toEqual(RESOURCES);
    expect(handle.get("file:///b.txt")).toMatchObject({ name: "b", mimeType: "text/plain" });
    expect(handle.get("nope")).toBeUndefined();
    expect(captured[0]).toEqual({ method: "resources/list", params: { sessionId: "s1" } });
  });

  it("read(uri) is pure RPC over resources/read — no resources/list follow-up", async () => {
    const captured: Captured[] = [];
    const handle = resourcesHandle(fakeCommandClient(captured), "s1");
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    const contents = await handle.read("file:///a.txt");

    expect(contents).toEqual(CONTENTS);
    expect(captured).toEqual([
      { method: "resources/read", params: { sessionId: "s1", uri: "file:///a.txt" } },
    ]);
    expect(captured.some((c) => c.method === "resources/list")).toBe(false);
  });

  it("listTemplates() is pure RPC over resources/listTemplates — unwrapped from .templates", async () => {
    const captured: Captured[] = [];
    const handle = resourcesHandle(fakeCommandClient(captured), "s1");
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    const templates = await handle.listTemplates();

    expect(templates).toEqual(TEMPLATES);
    expect(captured).toEqual([{ method: "resources/listTemplates", params: { sessionId: "s1" } }]);
  });

  it("refresh() re-polls resources/list and resolves the fresh snapshot", async () => {
    const captured: Captured[] = [];
    const handle = resourcesHandle(fakeCommandClient(captured), "s1");
    await waitFor(() => handle.list().length > 0);
    captured.length = 0;

    const rows = await handle.refresh();

    expect(rows).toEqual(RESOURCES);
    expect(captured[0]).toEqual({ method: "resources/list", params: { sessionId: "s1" } });
  });

  it("subscribe(cb) fires when the snapshot changes; cb receives NO arguments", async () => {
    const handle = resourcesHandle(fakeCommandClient([]), "s1");

    let notified = 0;
    let argCount = -1;
    handle.subscribe((...args: unknown[]) => {
      notified += 1;
      argCount = args.length;
    });

    await waitFor(() => notified > 0);
    expect(notified).toBeGreaterThan(0);
    expect(argCount).toBe(0);
  });
});
