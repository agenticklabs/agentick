import { describe, it, expect } from "vitest";
import { SandboxAccessError } from "@agentick/sandbox";
import { resolveContainerPath, shellQuote } from "../docker-sandbox.js";
import type { MountInfo } from "../docker-sandbox.js";

// ── Path Resolution (pure function, no Docker needed) ────────────────────────

describe("resolveContainerPath", () => {
  const workspace = "/workspace";

  it("resolves relative paths against workspace", () => {
    expect(resolveContainerPath("file.txt", workspace, "read")).toBe("/workspace/file.txt");
  });

  it("resolves nested relative paths", () => {
    expect(resolveContainerPath("a/b/c.txt", workspace, "read")).toBe("/workspace/a/b/c.txt");
  });

  it("resolves absolute paths within workspace", () => {
    expect(resolveContainerPath("/workspace/file.txt", workspace, "read")).toBe(
      "/workspace/file.txt",
    );
  });

  it("normalizes .. components within workspace", () => {
    expect(resolveContainerPath("a/../b/file.txt", workspace, "read")).toBe(
      "/workspace/b/file.txt",
    );
  });

  it("rejects paths that escape workspace", () => {
    expect(() => resolveContainerPath("/etc/passwd", workspace, "read")).toThrow(
      SandboxAccessError,
    );
  });

  it("rejects traversal via ..", () => {
    expect(() => resolveContainerPath("../../etc/passwd", workspace, "read")).toThrow(
      SandboxAccessError,
    );
  });

  it("rejects paths with null bytes", () => {
    expect(() => resolveContainerPath("file\0.txt", workspace, "read")).toThrow("null bytes");
  });

  it("allows workspace root exactly", () => {
    expect(resolveContainerPath("/workspace", workspace, "read")).toBe("/workspace");
  });

  it("rejects write to read-only mount", () => {
    const mounts: MountInfo[] = [{ hostPath: "/host/data", containerPath: "/data", mode: "ro" }];
    expect(() => resolveContainerPath("/data/file.txt", workspace, "write", mounts)).toThrow(
      "Write denied",
    );
  });

  it("allows read from read-only mount", () => {
    const mounts: MountInfo[] = [{ hostPath: "/host/data", containerPath: "/data", mode: "ro" }];
    expect(resolveContainerPath("/data/file.txt", workspace, "read", mounts)).toBe(
      "/data/file.txt",
    );
  });

  it("allows write to read-write mount", () => {
    const mounts: MountInfo[] = [{ hostPath: "/host/data", containerPath: "/data", mode: "rw" }];
    expect(resolveContainerPath("/data/file.txt", workspace, "write", mounts)).toBe(
      "/data/file.txt",
    );
  });

  it("allows mount root path exactly", () => {
    const mounts: MountInfo[] = [{ hostPath: "/host/data", containerPath: "/data", mode: "rw" }];
    expect(resolveContainerPath("/data", workspace, "read", mounts)).toBe("/data");
  });

  it("rejects /workspace-other (prefix collision)", () => {
    expect(() => resolveContainerPath("/workspace-other/file.txt", workspace, "read")).toThrow(
      SandboxAccessError,
    );
  });

  it("rejects /tmp outside workspace", () => {
    expect(() => resolveContainerPath("/tmp/escape.txt", workspace, "write")).toThrow(
      SandboxAccessError,
    );
  });

  it("accepts trailing slashes (within workspace)", () => {
    expect(resolveContainerPath("/workspace/dir/", workspace, "read")).toBe("/workspace/dir/");
  });

  it("handles deeply nested traversal", () => {
    expect(() => resolveContainerPath("a/b/c/../../../../etc/shadow", workspace, "read")).toThrow(
      SandboxAccessError,
    );
  });
});

// ── Shell Quoting ────────────────────────────────────────────────────────────

describe("shellQuote", () => {
  it("wraps in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("escapes single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("preserves special characters", () => {
    expect(shellQuote("$HOME")).toBe("'$HOME'");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote('"quoted"')).toBe("'\"quoted\"'");
  });

  it("handles empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("handles multiple single quotes", () => {
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });
});
