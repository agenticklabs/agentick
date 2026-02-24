/**
 * Config System Tests
 *
 * Covers: ConfigStore, schema registry, interpolation, config loader,
 * global binding, redaction, and protocol integration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createConfigStore,
  registerConfigSchema,
  buildConfigSchema,
  resetConfigSchemaRegistry,
  bindConfig,
  getConfig,
  getConfigOrNull,
  resetConfigBinding,
  type FileConfig,
} from "../config.js";
import {
  interpolateConfig,
  loadConfig,
  ConfigValidationError,
} from "../config-loader.js";
import { BUILT_IN_METHOD_SCHEMAS, GATEWAY_EVENTS } from "../method-schemas.js";

// ============================================================================
// ConfigStore
// ============================================================================

describe("ConfigStore", () => {
  it("get() returns a top-level section", () => {
    const store = createConfigStore({
      gateway: { port: 3000, host: "localhost" },
    });

    expect(store.get("gateway")).toEqual({ port: 3000, host: "localhost" });
  });

  it("get() returns undefined for missing sections", () => {
    const store = createConfigStore({});
    expect(store.get("gateway")).toBeUndefined();
    expect(store.get("connectors")).toBeUndefined();
  });

  it("resolved() returns the full frozen config", () => {
    const config: FileConfig = {
      gateway: { port: 8080 },
      connectors: {},
    };
    const store = createConfigStore(config);
    const resolved = store.resolved();

    expect(resolved).toEqual(config);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it("resolved() is not the same object reference as input", () => {
    const config: FileConfig = { gateway: { port: 1234 } };
    const store = createConfigStore(config);

    // structuredClone means different reference
    expect(store.resolved()).not.toBe(config);
  });

  it("onChange returns unsubscribe function", () => {
    const store = createConfigStore({});
    const handler = vi.fn();

    const unsub = store.onChange(handler);
    expect(typeof unsub).toBe("function");

    // Calling unsub should not throw
    unsub();
  });

  it("multiple onChange handlers don't interfere", () => {
    const store = createConfigStore({});
    const h1 = vi.fn();
    const h2 = vi.fn();

    const unsub1 = store.onChange(h1);
    const unsub2 = store.onChange(h2);

    unsub1();
    unsub2();
  });

  it("redacted() replaces secret values with ***", () => {
    const secretPaths = new Set(["connectors.telegram.token"]);
    const store = createConfigStore(
      { connectors: { telegram: { token: "real-secret" } } as any },
      secretPaths,
    );

    const redacted = store.redacted();
    expect((redacted.connectors as any).telegram.token).toBe("***");
  });

  it("redacted() returns frozen config when no secrets", () => {
    const store = createConfigStore({ gateway: { port: 3000 } });
    expect(store.redacted()).toBe(store.resolved());
  });
});

// ============================================================================
// Schema Registry
// ============================================================================

describe("Schema Registry", () => {
  beforeEach(() => {
    resetConfigSchemaRegistry();
  });

  it("registers and builds a schema from fragments", () => {
    registerConfigSchema("gateway", {
      parse: (data: unknown) => {
        if (typeof data !== "object" || data === null) throw new Error("bad");
        return data;
      },
      _output: {} as { port?: number },
    });

    const schema = buildConfigSchema();
    const result = schema.parse({ gateway: { port: 3000 } });
    expect(result).toEqual({ gateway: { port: 3000 } });
  });

  it("merges multiple fragments", () => {
    registerConfigSchema("gateway", {
      parse: (data: unknown) => data,
      _output: {} as { port?: number },
    });
    registerConfigSchema("connectors", {
      parse: (data: unknown) => data,
      _output: {} as Record<string, unknown>,
    });

    const schema = buildConfigSchema();
    const result = schema.parse({
      gateway: { port: 3000 },
      connectors: { telegram: { token: "abc" } },
    });

    expect(result).toEqual({
      gateway: { port: 3000 },
      connectors: { telegram: { token: "abc" } },
    });
  });

  it("passes through keys without registered schemas", () => {
    const schema = buildConfigSchema();
    const result = schema.parse({ unknown: { foo: "bar" } });
    expect(result).toEqual({ unknown: { foo: "bar" } });
  });

  it("throws on duplicate key registration", () => {
    registerConfigSchema("gateway", {
      parse: (data: unknown) => data,
      _output: {},
    });

    expect(() =>
      registerConfigSchema("gateway", {
        parse: (data: unknown) => data,
        _output: {},
      }),
    ).toThrow('Config schema already registered for "gateway"');
  });

  it("throws on registration after build", () => {
    buildConfigSchema();

    expect(() =>
      registerConfigSchema("late", {
        parse: (data: unknown) => data,
        _output: {},
      }),
    ).toThrow("after buildConfigSchema()");
  });

  it("buildConfigSchema is idempotent", () => {
    registerConfigSchema("gateway", {
      parse: (data: unknown) => data,
      _output: {},
    });

    const schema1 = buildConfigSchema();
    const schema2 = buildConfigSchema();
    expect(schema1).toBe(schema2);
  });

  it("rejects non-object input", () => {
    const schema = buildConfigSchema();
    expect(() => schema.parse("string")).toThrow("Config must be an object");
    expect(() => schema.parse(null)).toThrow("Config must be an object");
  });

  it("fragment validation errors propagate", () => {
    registerConfigSchema("strict", {
      parse: () => {
        throw new Error("nope");
      },
      _output: {},
    });

    const schema = buildConfigSchema();
    expect(() => schema.parse({ strict: {} })).toThrow("nope");
  });
});

// ============================================================================
// Global Binding
// ============================================================================

describe("Global binding", () => {
  beforeEach(() => {
    resetConfigBinding();
  });

  afterEach(() => {
    resetConfigBinding();
  });

  it("getConfig() throws before bindConfig()", () => {
    expect(() => getConfig()).toThrow("Config not bound");
  });

  it("getConfigOrNull() returns null before bindConfig()", () => {
    expect(getConfigOrNull()).toBeNull();
  });

  it("bindConfig() makes getConfig() return the store", () => {
    const store = createConfigStore({ gateway: { port: 9999 } });
    bindConfig(store);

    expect(getConfig()).toBe(store);
    expect(getConfig().get("gateway")?.port).toBe(9999);
  });

  it("getConfigOrNull() returns store after binding", () => {
    const store = createConfigStore({});
    bindConfig(store);

    expect(getConfigOrNull()).toBe(store);
  });

  it("concurrent bindConfig() calls — last one wins", () => {
    const store1 = createConfigStore({ gateway: { port: 1 } });
    const store2 = createConfigStore({ gateway: { port: 2 } });

    bindConfig(store1);
    bindConfig(store2);

    expect(getConfig().get("gateway")?.port).toBe(2);
  });

  it("resetConfigBinding() clears the store", () => {
    const store = createConfigStore({});
    bindConfig(store);
    resetConfigBinding();

    expect(getConfigOrNull()).toBeNull();
    expect(() => getConfig()).toThrow("Config not bound");
  });
});

// ============================================================================
// Interpolation
// ============================================================================

describe("interpolateConfig", () => {
  it("resolves ${env:VAR} from process.env", async () => {
    process.env.__TEST_CONFIG_VAR = "hello";
    try {
      const { resolved } = await interpolateConfig({
        key: "${env:__TEST_CONFIG_VAR}",
      });
      expect(resolved.key).toBe("hello");
    } finally {
      delete process.env.__TEST_CONFIG_VAR;
    }
  });

  it("throws on missing env var", async () => {
    delete process.env.__MISSING_VAR;

    await expect(
      interpolateConfig({ key: "${env:__MISSING_VAR}" }),
    ).rejects.toThrow('Environment variable "__MISSING_VAR" not set');
  });

  it("resolves ${secret:KEY} from SecretStore", async () => {
    const secrets = {
      get: vi.fn().mockResolvedValue("secret-value"),
      set: vi.fn(),
      delete: vi.fn(),
      has: vi.fn(),
      list: vi.fn(),
      backend: "mock",
    };

    const { resolved, secretPaths } = await interpolateConfig(
      { nested: { token: "${secret:API_KEY}" } },
      secrets,
    );

    expect(resolved).toEqual({ nested: { token: "secret-value" } });
    expect(secrets.get).toHaveBeenCalledWith("API_KEY");
    expect(secretPaths.has("nested.token")).toBe(true);
  });

  it("throws when secret not found", async () => {
    const secrets = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      delete: vi.fn(),
      has: vi.fn(),
      list: vi.fn(),
      backend: "mock",
    };

    await expect(
      interpolateConfig({ key: "${secret:MISSING}" }, secrets),
    ).rejects.toThrow('Secret "MISSING" not found');
  });

  it("throws when secret referenced but no SecretStore", async () => {
    await expect(
      interpolateConfig({ key: "${secret:KEY}" }),
    ).rejects.toThrow("no SecretStore provided");
  });

  it("leaves non-interpolation strings untouched", async () => {
    const { resolved } = await interpolateConfig({
      normal: "just a string",
      number: 42,
      bool: true,
      nested: { arr: [1, 2, 3] },
    });

    expect(resolved).toEqual({
      normal: "just a string",
      number: 42,
      bool: true,
      nested: { arr: [1, 2, 3] },
    });
  });

  it("handles arrays with interpolation", async () => {
    process.env.__ARR_TEST = "val";
    try {
      const { resolved } = await interpolateConfig({
        list: ["${env:__ARR_TEST}", "static"],
      });
      expect(resolved.list).toEqual(["val", "static"]);
    } finally {
      delete process.env.__ARR_TEST;
    }
  });

  it("partial env patterns are NOT interpolated (only exact match)", async () => {
    const { resolved } = await interpolateConfig({
      key: "prefix ${env:NOPE} suffix",
    });
    // Not an exact match — the regex requires ^...$ so it stays as-is
    expect(resolved.key).toBe("prefix ${env:NOPE} suffix");
  });
});

// ============================================================================
// Redaction
// ============================================================================

describe("ConfigStore.redacted()", () => {
  it("replaces secret values with ***", () => {
    const store = createConfigStore(
      { connectors: { telegram: { token: "real-secret" } } as any },
      new Set(["connectors.telegram.token"]),
    );

    const redacted = store.redacted();
    expect((redacted.connectors as any).telegram.token).toBe("***");
  });

  it("leaves non-secret values intact", () => {
    const store = createConfigStore(
      {
        gateway: { port: 3000 },
        connectors: { telegram: { token: "secret", chatId: "123" } } as any,
      },
      new Set(["connectors.telegram.token"]),
    );

    const redacted = store.redacted();
    expect(redacted.gateway?.port).toBe(3000);
    expect((redacted.connectors as any).telegram.chatId).toBe("123");
  });

  it("returns same frozen object when no secret paths", () => {
    const store = createConfigStore({ gateway: { port: 1234 } });
    // No secrets → returns the same frozen resolved config
    expect(store.redacted()).toBe(store.resolved());
  });

  it("handles missing intermediate paths gracefully", () => {
    const store = createConfigStore(
      {},
      new Set(["connectors.telegram.token"]),
    );

    // Should not throw
    const redacted = store.redacted();
    expect(redacted).toEqual({});
  });
});

// ============================================================================
// Config Loader
// ============================================================================

describe("loadConfig", () => {
  beforeEach(() => {
    resetConfigSchemaRegistry();
    resetConfigBinding();
  });

  afterEach(() => {
    resetConfigBinding();
    resetConfigSchemaRegistry();
  });

  it("returns a ConfigStore with defaults when no file exists", async () => {
    const store = await loadConfig({ path: "/nonexistent/config.json" });

    expect(store.resolved()).toEqual({});
  });

  it("does NOT auto-bind — callers must bindConfig() explicitly", async () => {
    await loadConfig({ path: "/nonexistent/config.json" });
    expect(getConfigOrNull()).toBeNull();
  });

  it("throws ConfigValidationError on invalid JSON file", async () => {
    // Create a temp file with bad JSON
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmpFile = join(tmpdir(), `agentick-test-${Date.now()}.json`);
    writeFileSync(tmpFile, "not valid json{{{");

    try {
      await expect(loadConfig({ path: tmpFile })).rejects.toThrow(ConfigValidationError);
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("merges overrides on top of file config", async () => {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmpFile = join(tmpdir(), `agentick-test-${Date.now()}.json`);
    writeFileSync(tmpFile, JSON.stringify({ gateway: { port: 3000, host: "file-host" } }));

    try {
      const store = await loadConfig({
        path: tmpFile,
        overrides: { gateway: { port: 9999 } },
      });

      // Port overridden, host preserved from file
      expect(store.get("gateway")?.port).toBe(9999);
      expect(store.get("gateway")?.host).toBe("file-host");
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("reads and parses a valid JSON config file", async () => {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmpFile = join(tmpdir(), `agentick-test-${Date.now()}.json`);
    writeFileSync(
      tmpFile,
      JSON.stringify({
        gateway: { port: 4000, transport: "http" },
        connectors: { test: { enabled: true } },
      }),
    );

    try {
      const store = await loadConfig({ path: tmpFile });
      expect(store.get("gateway")).toEqual({ port: 4000, transport: "http" });
      expect(store.get("connectors")).toEqual({ test: { enabled: true } });
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("interpolates env vars in config file", async () => {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    process.env.__LOADER_TEST_PORT = "5000";
    const tmpFile = join(tmpdir(), `agentick-test-${Date.now()}.json`);
    writeFileSync(
      tmpFile,
      JSON.stringify({ gateway: { host: "${env:__LOADER_TEST_PORT}" } }),
    );

    try {
      const store = await loadConfig({ path: tmpFile });
      expect(store.get("gateway")?.host).toBe("5000");
    } finally {
      delete process.env.__LOADER_TEST_PORT;
      unlinkSync(tmpFile);
    }
  });
});

// ============================================================================
// Protocol Integration (static checks — no gateway needed)
// ============================================================================

describe("Protocol integration", () => {
  it('"config" is in BUILT_IN_METHOD_SCHEMAS', () => {
    expect(BUILT_IN_METHOD_SCHEMAS.has("config")).toBe(true);

    const schema = BUILT_IN_METHOD_SCHEMAS.get("config")!;
    expect(schema.description).toContain("configuration");
    expect(schema.response).toBeDefined();
  });

  it('"config:changed" appears in GATEWAY_EVENTS', () => {
    const types = GATEWAY_EVENTS.map((e) => e.type);
    expect(types).toContain("config:changed");

    const entry = GATEWAY_EVENTS.find((e) => e.type === "config:changed");
    expect(entry?.category).toBe("gateway");
  });
});

// ============================================================================
// Adversarial
// ============================================================================

describe("Adversarial", () => {
  beforeEach(() => {
    resetConfigSchemaRegistry();
    resetConfigBinding();
  });

  afterEach(() => {
    resetConfigBinding();
    resetConfigSchemaRegistry();
  });

  it("ConfigStore is immune to mutation of the original input", () => {
    const config: FileConfig = { gateway: { port: 1 } };
    const store = createConfigStore(config);

    // Mutate the original — should not affect the store
    config.gateway!.port = 999;
    expect(store.get("gateway")?.port).toBe(1);
  });

  it("resolved() object is frozen (cannot be mutated)", () => {
    const store = createConfigStore({ gateway: { port: 1 } });
    const resolved = store.resolved();

    expect(() => {
      (resolved as any).gateway = { port: 999 };
    }).toThrow();
  });

  it("rapid bindConfig calls don't corrupt state", () => {
    for (let i = 0; i < 100; i++) {
      bindConfig(createConfigStore({ gateway: { port: i } }));
    }
    expect(getConfig().get("gateway")?.port).toBe(99);
  });

  it("schema registry after reset allows re-registration", () => {
    registerConfigSchema("key", {
      parse: (d: unknown) => d,
      _output: {},
    });
    resetConfigSchemaRegistry();

    // Should NOT throw — fresh registry
    registerConfigSchema("key", {
      parse: (d: unknown) => d,
      _output: {},
    });

    const schema = buildConfigSchema();
    expect(schema.parse({ key: "value" })).toEqual({ key: "value" });
  });

  it("interpolateConfig handles deeply nested objects", async () => {
    process.env.__DEEP_TEST = "deep-value";
    try {
      const { resolved } = await interpolateConfig({
        a: { b: { c: { d: { e: "${env:__DEEP_TEST}" } } } },
      });
      expect((resolved as any).a.b.c.d.e).toBe("deep-value");
    } finally {
      delete process.env.__DEEP_TEST;
    }
  });

  it("interpolateConfig with empty object returns empty object", async () => {
    const { resolved } = await interpolateConfig({});
    expect(resolved).toEqual({});
  });

  it("redacted() deep clones — mutating result doesn't affect resolved", () => {
    const store = createConfigStore(
      {
        gateway: { port: 1234 },
        connectors: { tg: { token: "secret" } } as any,
      },
      new Set(["connectors.tg.token"]),
    );

    const redacted = store.redacted();
    // redacted() is frozen, but let's verify the resolved snapshot is separate
    expect(store.resolved().gateway?.port).toBe(1234);
    expect((redacted.connectors as any).tg.token).toBe("***");
    // resolved() should still have the real value
    expect((store.resolved().connectors as any).tg.token).toBe("secret");
  });

  it("loadConfig with schema validation catches fragment errors", async () => {
    registerConfigSchema("strict", {
      parse: (data: unknown) => {
        if (typeof data !== "object" || data === null) throw new Error("must be object");
        if (!("required" in data)) throw new Error('missing "required" field');
        return data;
      },
      _output: {},
    });

    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmpFile = join(tmpdir(), `agentick-test-${Date.now()}.json`);
    writeFileSync(tmpFile, JSON.stringify({ strict: { notRequired: true } }));

    try {
      await expect(loadConfig({ path: tmpFile })).rejects.toThrow(ConfigValidationError);
    } finally {
      unlinkSync(tmpFile);
    }
  });
});
