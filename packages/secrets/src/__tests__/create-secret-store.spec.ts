import { describe, it, expect } from "vitest";
import { createSecretStore } from "../create-secret-store.js";

describe("createSecretStore", () => {
  it("creates memory store explicitly", async () => {
    const store = await createSecretStore({ backend: "memory" });
    expect(store.backend).toBe("memory");
    await store.set("key", "value");
    expect(await store.get("key")).toBe("value");
  });

  it("creates env store explicitly", async () => {
    const store = await createSecretStore({ backend: "env", envPrefix: "CSTEST" });
    expect(store.backend).toBe("env");
  });

  it("auto-detect picks a real backend", async () => {
    const store = await createSecretStore();
    expect(["keychain", "libsecret", "env"]).toContain(store.backend);
  });

  it("auto is equivalent to omitting backend", async () => {
    const auto = await createSecretStore({ backend: "auto" });
    const omitted = await createSecretStore();
    expect(auto.backend).toBe(omitted.backend);
  });

  it("throws for unknown backend", async () => {
    await expect(createSecretStore({ backend: "nonsense" as any })).rejects.toThrow(
      "Unknown secret store backend",
    );
  });

  // ===========================================================================
  // Full round-trip through auto-detected store
  // ===========================================================================

  it("full CRUD round-trip on auto-detected backend", async () => {
    const store = await createSecretStore();

    await store.set("roundtrip-test", "hello");
    expect(await store.get("roundtrip-test")).toBe("hello");
    expect(await store.has("roundtrip-test")).toBe(true);

    const keys = await store.list();
    expect(keys).toContain("roundtrip-test");

    await store.delete("roundtrip-test");
    expect(await store.get("roundtrip-test")).toBeNull();
  });
});
