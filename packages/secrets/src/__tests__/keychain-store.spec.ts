import { describe, it, expect } from "vitest";
import { createKeychainStore } from "../keychain-store.js";

// These tests hit the real macOS Keychain. Skip on non-macOS.
const isMacOS = process.platform === "darwin";
const describeKeychain = isMacOS ? describe : describe.skip;

describeKeychain("createKeychainStore (integration)", () => {
  const SERVICE = "agentick-test";
  const store = createKeychainStore({ service: SERVICE });

  async function cleanup(key: string) {
    try {
      await store.delete(key);
    } catch {
      // ignore
    }
  }

  // ===========================================================================
  // Basic CRUD
  // ===========================================================================

  it("set then get", async () => {
    await cleanup("test-key");
    await store.set("test-key", "test-value");
    expect(await store.get("test-key")).toBe("test-value");
    await cleanup("test-key");
  });

  it("get returns null for missing key", async () => {
    expect(await store.get("definitely-does-not-exist-xyz")).toBeNull();
  });

  it("has returns true for existing, false for missing", async () => {
    await cleanup("has-test");
    await store.set("has-test", "exists");
    expect(await store.has("has-test")).toBe(true);
    expect(await store.has("nope-not-here")).toBe(false);
    await cleanup("has-test");
  });

  it("delete returns true for existing, false for missing", async () => {
    await store.set("delete-me", "gone");
    expect(await store.delete("delete-me")).toBe(true);
    expect(await store.delete("delete-me")).toBe(false);
  });

  it("overwrite existing key", async () => {
    await cleanup("overwrite-test");
    await store.set("overwrite-test", "old");
    await store.set("overwrite-test", "new");
    expect(await store.get("overwrite-test")).toBe("new");
    await cleanup("overwrite-test");
  });

  // ===========================================================================
  // Manifest (list)
  // ===========================================================================

  it("list tracks set and delete", async () => {
    await cleanup("list-a");
    await cleanup("list-b");

    await store.set("list-a", "1");
    await store.set("list-b", "2");
    const keys = await store.list();
    expect(keys).toContain("list-a");
    expect(keys).toContain("list-b");

    await store.delete("list-a");
    const after = await store.list();
    expect(after).not.toContain("list-a");
    expect(after).toContain("list-b");

    await cleanup("list-b");
  });

  // ===========================================================================
  // Adversarial
  // ===========================================================================

  it("handles values with special characters", async () => {
    await cleanup("special");
    const value = "bot123:ABC-def_456/789+extra==";
    await store.set("special", value);
    expect(await store.get("special")).toBe(value);
    await cleanup("special");
  });

  it("handles dot-path keys", async () => {
    await cleanup("connectors.telegram.token");
    await store.set("connectors.telegram.token", "bot-token");
    expect(await store.get("connectors.telegram.token")).toBe("bot-token");
    await cleanup("connectors.telegram.token");
  });

  it("reports backend", () => {
    expect(store.backend).toBe("keychain");
  });
});
