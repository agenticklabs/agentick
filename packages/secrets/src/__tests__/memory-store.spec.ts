import { describe, it, expect } from "vitest";
import { createMemoryStore } from "../memory-store.js";

describe("createMemoryStore", () => {
  it("starts empty", async () => {
    const store = createMemoryStore();
    expect(await store.list()).toEqual([]);
    expect(await store.get("anything")).toBeNull();
    expect(store.backend).toBe("memory");
  });

  it("accepts initial values", async () => {
    const store = createMemoryStore({ foo: "bar", baz: "qux" });
    expect(await store.get("foo")).toBe("bar");
    expect(await store.get("baz")).toBe("qux");
    expect(await store.list()).toEqual(["foo", "baz"]);
  });

  // ===========================================================================
  // CRUD
  // ===========================================================================

  it("set then get", async () => {
    const store = createMemoryStore();
    await store.set("key", "value");
    expect(await store.get("key")).toBe("value");
  });

  it("set overwrites existing", async () => {
    const store = createMemoryStore({ key: "old" });
    await store.set("key", "new");
    expect(await store.get("key")).toBe("new");
  });

  it("has returns true for existing keys", async () => {
    const store = createMemoryStore({ key: "value" });
    expect(await store.has("key")).toBe(true);
    expect(await store.has("missing")).toBe(false);
  });

  it("delete returns true for existing, false for missing", async () => {
    const store = createMemoryStore({ key: "value" });
    expect(await store.delete("key")).toBe(true);
    expect(await store.delete("key")).toBe(false);
    expect(await store.get("key")).toBeNull();
  });

  it("list reflects mutations", async () => {
    const store = createMemoryStore();
    await store.set("a", "1");
    await store.set("b", "2");
    expect(await store.list()).toEqual(["a", "b"]);
    await store.delete("a");
    expect(await store.list()).toEqual(["b"]);
  });

  // ===========================================================================
  // Adversarial
  // ===========================================================================

  it("handles empty string values", async () => {
    const store = createMemoryStore();
    await store.set("empty", "");
    expect(await store.get("empty")).toBe("");
    expect(await store.has("empty")).toBe(true);
  });

  it("handles keys with special characters", async () => {
    const store = createMemoryStore();
    await store.set("connectors.telegram.token", "abc");
    await store.set("a/b/c", "def");
    await store.set("key with spaces", "ghi");
    expect(await store.get("connectors.telegram.token")).toBe("abc");
    expect(await store.get("a/b/c")).toBe("def");
    expect(await store.get("key with spaces")).toBe("ghi");
  });

  it("handles values with special characters", async () => {
    const store = createMemoryStore();
    const nasty = "bot123:ABC-def_456/789+extra==\nnewline\ttab";
    await store.set("token", nasty);
    expect(await store.get("token")).toBe(nasty);
  });

  it("concurrent set/get doesn't corrupt", async () => {
    const store = createMemoryStore();
    const ops = Array.from({ length: 100 }, (_, i) => store.set(`key-${i}`, `value-${i}`));
    await Promise.all(ops);
    for (let i = 0; i < 100; i++) {
      expect(await store.get(`key-${i}`)).toBe(`value-${i}`);
    }
    expect(await store.list()).toHaveLength(100);
  });

  it("concurrent delete doesn't throw", async () => {
    const store = createMemoryStore({ key: "value" });
    const results = await Promise.all([
      store.delete("key"),
      store.delete("key"),
      store.delete("key"),
    ]);
    // Exactly one should return true
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("set then immediate delete then get returns null", async () => {
    const store = createMemoryStore();
    await store.set("ephemeral", "gone");
    await store.delete("ephemeral");
    expect(await store.get("ephemeral")).toBeNull();
    expect(await store.has("ephemeral")).toBe(false);
  });
});
