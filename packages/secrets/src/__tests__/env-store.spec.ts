import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEnvStore } from "../env-store.js";

describe("createEnvStore", () => {
  beforeEach(() => {
    // Clean test keys
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TEST_SECRET_")) delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TEST_SECRET_")) delete process.env[key];
    }
  });

  // ===========================================================================
  // Basic operations with prefix
  // ===========================================================================

  it("reports backend as env", () => {
    const store = createEnvStore({ prefix: "TEST_SECRET" });
    expect(store.backend).toBe("env");
  });

  it("get reads from env with prefix", async () => {
    process.env.TEST_SECRET_TELEGRAM_TOKEN = "bot123";
    const store = createEnvStore({ prefix: "TEST_SECRET" });
    expect(await store.get("telegram.token")).toBe("bot123");
  });

  it("get returns null for missing key", async () => {
    const store = createEnvStore({ prefix: "TEST_SECRET" });
    expect(await store.get("nonexistent")).toBeNull();
  });

  it("set writes to env", async () => {
    const store = createEnvStore({ prefix: "TEST_SECRET" });
    await store.set("my.key", "my-value");
    expect(process.env.TEST_SECRET_MY_KEY).toBe("my-value");
  });

  it("has checks env", async () => {
    const store = createEnvStore({ prefix: "TEST_SECRET" });
    expect(await store.has("missing")).toBe(false);
    process.env.TEST_SECRET_MISSING = "found";
    expect(await store.has("missing")).toBe(true);
  });

  it("delete removes from env", async () => {
    process.env.TEST_SECRET_DOOMED = "bye";
    const store = createEnvStore({ prefix: "TEST_SECRET" });
    expect(await store.delete("doomed")).toBe(true);
    expect(process.env.TEST_SECRET_DOOMED).toBeUndefined();
    expect(await store.delete("doomed")).toBe(false);
  });

  // ===========================================================================
  // Key normalization
  // ===========================================================================

  it("normalizes dots to underscores", async () => {
    process.env.TEST_SECRET_A_B_C = "deep";
    const store = createEnvStore({ prefix: "TEST_SECRET" });
    expect(await store.get("a.b.c")).toBe("deep");
  });

  it("normalizes to uppercase", async () => {
    process.env.TEST_SECRET_LOWER = "value";
    const store = createEnvStore({ prefix: "TEST_SECRET" });
    expect(await store.get("lower")).toBe("value");
  });

  it("strips non-alphanumeric chars", async () => {
    process.env.TEST_SECRET_WEIRD_KEY = "value";
    const store = createEnvStore({ prefix: "TEST_SECRET" });
    expect(await store.get("weird-key")).toBe("value");
    expect(await store.get("weird/key")).toBe("value");
  });

  // ===========================================================================
  // List with prefix
  // ===========================================================================

  it("list returns keys matching prefix, denormalized", async () => {
    process.env.TEST_SECRET_FOO = "1";
    process.env.TEST_SECRET_BAR_BAZ = "2";
    process.env.UNRELATED = "3";

    const store = createEnvStore({ prefix: "TEST_SECRET" });
    const keys = await store.list();
    expect(keys).toContain("foo");
    expect(keys).toContain("bar.baz");
    expect(keys).not.toContain("UNRELATED");
  });

  // ===========================================================================
  // No prefix
  // ===========================================================================

  it("works without prefix", async () => {
    process.env.TEST_SECRET_RAW = "direct";
    const store = createEnvStore();
    expect(await store.get("test.secret.raw")).toBe("direct");
  });

  // ===========================================================================
  // Adversarial
  // ===========================================================================

  it("handles empty string value", async () => {
    const store = createEnvStore({ prefix: "TEST_SECRET" });
    await store.set("empty", "");
    // env vars can be empty strings
    expect(await store.get("empty")).toBe("");
  });

  it("concurrent operations don't corrupt", async () => {
    const store = createEnvStore({ prefix: "TEST_SECRET" });
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.set(`key.${i}`, `val-${i}`)));
    for (let i = 0; i < 50; i++) {
      expect(await store.get(`key.${i}`)).toBe(`val-${i}`);
    }
  });
});
