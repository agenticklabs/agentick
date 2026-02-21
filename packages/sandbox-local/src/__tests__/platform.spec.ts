import { describe, it, expect, afterEach } from "vitest";
import { detectCapabilities, resetCapabilitiesCache, selectStrategy } from "../platform/detect.js";
import { createMockCapabilities } from "../testing.js";

describe("detectCapabilities", () => {
  afterEach(() => {
    resetCapabilitiesCache();
  });

  it("detects current platform", async () => {
    const caps = await detectCapabilities();
    expect(caps.platform).toBe(
      process.platform === "darwin"
        ? "darwin"
        : process.platform === "linux"
          ? "linux"
          : expect.any(String),
    );
    expect(caps.arch).toBe(process.arch);
    expect(typeof caps.uid).toBe("number");
  });

  it("returns cached result on second call", async () => {
    const first = await detectCapabilities();
    const second = await detectCapabilities();
    expect(first).toBe(second); // Same reference
  });

  it("recommends seatbelt on macOS with sandbox-exec", async () => {
    if (process.platform !== "darwin") return;
    const caps = await detectCapabilities();
    if (caps.hasSandboxExec) {
      expect(caps.recommended).toBe("seatbelt");
    }
  });
});

describe("selectStrategy", () => {
  it("returns recommended when auto", () => {
    const caps = createMockCapabilities({ recommended: "seatbelt" });
    expect(selectStrategy(caps, "auto")).toBe("seatbelt");
  });

  it("returns recommended when undefined", () => {
    const caps = createMockCapabilities({ recommended: "bwrap" });
    expect(selectStrategy(caps)).toBe("bwrap");
  });

  it("allows none override", () => {
    const caps = createMockCapabilities({ recommended: "seatbelt" });
    expect(selectStrategy(caps, "none")).toBe("none");
  });

  it("validates seatbelt availability", () => {
    const caps = createMockCapabilities({ hasSandboxExec: false });
    expect(() => selectStrategy(caps, "seatbelt")).toThrow("not available");
  });

  it("validates bwrap availability", () => {
    const caps = createMockCapabilities({ hasBwrap: false });
    expect(() => selectStrategy(caps, "bwrap")).toThrow("not found");
  });

  it("validates unshare + user namespaces", () => {
    const caps = createMockCapabilities({ hasUnshare: true, userNamespaces: false });
    expect(() => selectStrategy(caps, "unshare")).toThrow("user namespaces");
  });

  it("allows seatbelt when available", () => {
    const caps = createMockCapabilities({ hasSandboxExec: true });
    expect(selectStrategy(caps, "seatbelt")).toBe("seatbelt");
  });
});
