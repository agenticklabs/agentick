/**
 * `McpServerHarness` skeleton — construction, lifecycle, options
 * validation, connection-tracking primitives.
 *
 * Pins the post-ADR-40-amendment flat options shape: no `config`
 * nesting, no duplicate transports list. `tools` is a single object
 * with registry + projection rules.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type { McpServerConnectionInfo } from "@agentick/spec-next";

import { inMemoryServerTransport, McpServerHarness, validateOptions, toHandle } from "../index.js";
import type { McpServerOptions } from "../index.js";

function makeOptions(overrides: Partial<McpServerOptions> = {}): McpServerOptions {
  return {
    name: "test-server",
    transports: [inMemoryServerTransport()],
    ...overrides,
  };
}

async function makeHarness(options: McpServerOptions = makeOptions()): Promise<McpServerHarness> {
  const harness = new McpServerHarness(
    `test:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    options,
  );
  await harness.ready;
  return harness;
}

describe("McpServerHarness — construction + lifecycle", () => {
  it("constructs from minimal options", async () => {
    const h = await makeHarness();
    expect(h.name).toBe("test-server");
    expect(h.id).toMatch(/^test:/);
  });

  it("close() is idempotent + empties connections", async () => {
    const h = await makeHarness();
    h._registerConnection(fakeConnection("c1"));
    expect(h.connections()).toHaveLength(1);
    await h.close();
    expect(h.connections()).toHaveLength(0);
    await h.close();
  });

  it("rejects registering connections after close", async () => {
    const h = await makeHarness();
    await h.close();
    expect(caughtTag(() => h._registerConnection(fakeConnection("c1")))).toBe("McpServerClosed");
  });
});

describe("McpServerHarness — options validation", () => {
  it("throws on missing name", () => {
    expect(caughtTag(() => validateOptions({ ...makeOptions(), name: "" }))).toBe(
      "McpServerConfigInvalid",
    );
  });

  it("throws on empty transports array", () => {
    expect(caughtTag(() => validateOptions({ ...makeOptions(), transports: [] }))).toBe(
      "McpServerConfigInvalid",
    );
  });

  it("throws when a transport is missing listen()", () => {
    expect(
      caughtTag(() =>
        validateOptions({
          ...makeOptions(),
          // Bare object — has kind but no listen method.
          transports: [{ kind: "stdio" } as unknown as ReturnType<typeof inMemoryServerTransport>],
        }),
      ),
    ).toBe("McpServerConfigInvalid");
  });

  it("throws when tools is missing registry or resolveHandler", () => {
    expect(
      caughtTag(() =>
        validateOptions({
          ...makeOptions(),
          tools: {
            // Missing registry.
            resolveHandler: () => null,
          } as unknown as McpServerOptions["tools"],
        }),
      ),
    ).toBe("McpServerConfigInvalid");
  });

  it("returns the options unchanged on valid input", () => {
    const opts = makeOptions({ metadata: { tier: "public" } });
    expect(validateOptions(opts)).toEqual(opts);
  });

  it("accepts capabilities + auth + tools + prompts slots", () => {
    expect(() =>
      validateOptions({
        ...makeOptions(),
        capabilities: { tools: false },
        auth: { authenticator: async () => ({ authenticated: false, reason: "x" }) },
        tools: { registry: [], resolveHandler: () => null, filter: () => true, transforms: [] },
        prompts: { filter: () => true },
      }),
    ).not.toThrow();
  });
});

describe("McpServerHarness — connection tracking", () => {
  it("tracks open connections + sorts by connectedAt", async () => {
    const h = await makeHarness();
    h._registerConnection(fakeConnection("a", 100));
    h._registerConnection(fakeConnection("b", 50));
    h._registerConnection(fakeConnection("c", 200));
    expect(h.connections().map((c) => c.connectionId)).toEqual(["b", "a", "c"]);
  });

  it("removes connections idempotently", async () => {
    const h = await makeHarness();
    h._registerConnection(fakeConnection("c1"));
    h._removeConnection("c1");
    h._removeConnection("c1");
    expect(h.connections()).toHaveLength(0);
  });

  it("notifies subscribers on open + close", async () => {
    const h = await makeHarness();
    let count = 0;
    const unsubscribe = h.onConnectionChange(() => count++);
    h._registerConnection(fakeConnection("c1"));
    h._removeConnection("c1");
    expect(count).toBe(2);
    unsubscribe();
    h._registerConnection(fakeConnection("c2"));
    expect(count).toBe(2);
  });

  it("invalidates connections cache on mutation", async () => {
    const h = await makeHarness();
    const first = h.connections();
    h._registerConnection(fakeConnection("c1"));
    const second = h.connections();
    expect(first).not.toBe(second);
    const third = h.connections();
    expect(third).toBe(second);
  });
});

describe("McpServerHarness — asClient placeholder", () => {
  it("throws with a helpful message pointing at #171g", async () => {
    const h = await makeHarness();
    expect(() => h.asClient()).toThrow(/171g/);
  });
});

describe("toHandle", () => {
  it("projects harness to the read-only handle surface", async () => {
    const h = await makeHarness();
    const handle = toHandle(h);
    expect(handle.name).toBe("test-server");
    expect(handle.connections()).toHaveLength(0);
    expect(typeof handle.onConnectionChange).toBe("function");
    expect(typeof handle.asClient).toBe("function");
  });

  it("handle.connections() reflects underlying state", async () => {
    const h = await makeHarness();
    const handle = toHandle(h);
    h._registerConnection(fakeConnection("c1"));
    expect(handle.connections()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

function fakeConnection(
  id: string,
  connectedAt: number = Number(`1${id.charCodeAt(0)}00000`),
): McpServerConnectionInfo {
  return {
    connectionId: id,
    transportKind: "in-memory",
    connectedAt,
    user: null,
    clientInfo: null,
  };
}

function caughtTag(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return typeof e === "object" && e !== null && "_tag" in e
      ? String((e as { _tag: unknown })._tag)
      : undefined;
  }
}
