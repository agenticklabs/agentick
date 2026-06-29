/**
 * `McpServerHarness` skeleton — pin construction, lifecycle, config
 * validation, and the connection-tracking primitives that #171c+
 * transports will hook into.
 *
 * Does NOT test transports, projection, or protocol handling — those
 * land with #171c onward and have their own conformance.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type { McpServerConfig, McpServerConnectionInfo } from "@agentick/spec-next";

import { McpServerHarness, validateConfig, toHandle } from "../index.js";

const stdioTransport = { kind: "stdio" } as const;

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "test-server",
    transports: [stdioTransport],
    ...overrides,
  };
}

async function makeHarness(config: McpServerConfig = makeConfig()): Promise<McpServerHarness> {
  const harness = new McpServerHarness(
    `test:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    { config },
  );
  await harness.ready;
  return harness;
}

describe("McpServerHarness — construction + lifecycle", () => {
  it("constructs from a minimal config", async () => {
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
    // Second close doesn't throw.
    await h.close();
  });

  it("rejects registering connections after close", async () => {
    const h = await makeHarness();
    await h.close();
    expect(caughtTag(() => h._registerConnection(fakeConnection("c1")))).toBe("McpServerClosed");
  });
});

describe("McpServerHarness — config validation", () => {
  it("throws on missing name", () => {
    expect(caughtTag(() => validateConfig({ ...makeConfig(), name: "" }))).toBe(
      "McpServerConfigInvalid",
    );
    expect(
      caughtTag(() =>
        // @ts-expect-error — exercising runtime guard against bad input.
        validateConfig({ ...makeConfig(), name: undefined }),
      ),
    ).toBe("McpServerConfigInvalid");
  });

  it("throws on empty transports array", () => {
    expect(caughtTag(() => validateConfig({ ...makeConfig(), transports: [] }))).toBe(
      "McpServerConfigInvalid",
    );
  });

  it("throws when a transport entry is missing kind", () => {
    expect(
      caughtTag(() =>
        // @ts-expect-error — exercising runtime guard.
        validateConfig({ ...makeConfig(), transports: [{}] }),
      ),
    ).toBe("McpServerConfigInvalid");
  });

  it("returns the config unchanged on valid input", () => {
    const cfg = makeConfig({ metadata: { tier: "public" } });
    expect(validateConfig(cfg)).toEqual(cfg);
  });

  it("accepts capability + auth + tools + prompts slots", () => {
    expect(() =>
      validateConfig({
        ...makeConfig(),
        capabilities: { tools: true, prompts: false },
        auth: { authenticator: () => null },
        tools: { filter: () => true, transforms: [] },
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
    h._removeConnection("c1"); // idempotent
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
    expect(third).toBe(second); // cached
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
    transportKind: "stdio",
    connectedAt,
    user: null,
    clientInfo: null,
  };
}

/** Capture the `_tag` of a typed error thrown synchronously. */
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
