import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveSafePath, filterEnv } from "../paths.js";
import { SandboxAccessError } from "@agentick/sandbox";
import { mkdir, rm, symlink, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

describe("resolveSafePath", () => {
  let workspace: string;
  let realWorkspace: string;

  beforeEach(async () => {
    workspace = join(tmpdir(), `sandbox-test-${randomBytes(4).toString("hex")}`);
    await mkdir(workspace, { recursive: true });
    // Resolve symlinks (macOS: /var → /private/var)
    realWorkspace = await realpath(workspace);
    await mkdir(join(realWorkspace, "subdir"), { recursive: true });
    await writeFile(join(realWorkspace, "file.txt"), "test");
  });

  afterEach(async () => {
    await rm(realWorkspace, { recursive: true, force: true });
  });

  it("resolves relative paths within workspace", async () => {
    const resolved = await resolveSafePath("file.txt", realWorkspace, "read");
    expect(resolved).toBe(join(realWorkspace, "file.txt"));
  });

  it("resolves subdirectory paths", async () => {
    await writeFile(join(realWorkspace, "subdir", "nested.txt"), "test");
    const resolved = await resolveSafePath("subdir/nested.txt", realWorkspace, "read");
    expect(resolved).toBe(join(realWorkspace, "subdir", "nested.txt"));
  });

  it("resolves absolute paths within workspace", async () => {
    const resolved = await resolveSafePath(join(realWorkspace, "file.txt"), realWorkspace, "read");
    expect(resolved).toBe(join(realWorkspace, "file.txt"));
  });

  it("rejects null bytes", async () => {
    await expect(resolveSafePath("file\0.txt", realWorkspace, "read")).rejects.toThrow(
      "null bytes",
    );
  });

  it("rejects path traversal", async () => {
    await expect(resolveSafePath("../../../etc/passwd", realWorkspace, "read")).rejects.toThrow(
      "escapes sandbox",
    );
  });

  it("rejects absolute paths outside workspace", async () => {
    await expect(resolveSafePath("/etc/passwd", realWorkspace, "read")).rejects.toThrow(
      "escapes sandbox",
    );
  });

  it("throws SandboxAccessError with metadata for path traversal", async () => {
    try {
      await resolveSafePath("../../../etc/passwd", realWorkspace, "read");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxAccessError);
      const sae = err as SandboxAccessError;
      expect(sae.name).toBe("SandboxAccessError");
      expect(sae.requestedPath).toBe("../../../etc/passwd");
      expect(sae.mode).toBe("read");
      expect(sae.resolvedPath).toMatch(/\/etc\/passwd$/);
    }
  });

  it("throws SandboxAccessError with metadata for absolute escape", async () => {
    try {
      await resolveSafePath("/etc/hosts", realWorkspace, "read");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxAccessError);
      const sae = err as SandboxAccessError;
      expect(sae.requestedPath).toBe("/etc/hosts");
      expect(sae.mode).toBe("read");
    }
  });

  it("throws SandboxAccessError for write mode escapes", async () => {
    try {
      await resolveSafePath("/tmp/outside.txt", realWorkspace, "write");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxAccessError);
      const sae = err as SandboxAccessError;
      expect(sae.mode).toBe("write");
    }
  });

  it("allows write to non-existent file in existing parent", async () => {
    const resolved = await resolveSafePath("new-file.txt", realWorkspace, "write");
    expect(resolved).toBe(join(realWorkspace, "new-file.txt"));
  });

  it("allows write to deeply nested non-existent path", async () => {
    // Parent dirs don't exist yet — should still resolve within workspace
    const resolved = await resolveSafePath("a/b/c/deep.txt", realWorkspace, "write");
    expect(resolved).toBe(join(realWorkspace, "a/b/c/deep.txt"));
  });

  it("follows symlinks and rejects escape via symlink", async () => {
    const escapePath = join(realWorkspace, "escape-link");
    await symlink("/etc", escapePath);

    await expect(resolveSafePath("escape-link/passwd", realWorkspace, "read")).rejects.toThrow(
      "escapes sandbox",
    );
  });

  it("allows access to read-only mounts", async () => {
    const mountDir = join(tmpdir(), `sandbox-mount-${randomBytes(4).toString("hex")}`);
    await mkdir(mountDir, { recursive: true });
    const realMountDir = await realpath(mountDir);
    await writeFile(join(realMountDir, "data.txt"), "mount data");

    try {
      const resolved = await resolveSafePath(
        join(realMountDir, "data.txt"),
        realWorkspace,
        "read",
        [{ hostPath: realMountDir, sandboxPath: "/mnt/data", mode: "ro" }],
      );
      expect(resolved).toBe(join(realMountDir, "data.txt"));
    } finally {
      await rm(realMountDir, { recursive: true, force: true });
    }
  });

  it("rejects write to read-only mount", async () => {
    const mountDir = join(tmpdir(), `sandbox-mount-${randomBytes(4).toString("hex")}`);
    await mkdir(mountDir, { recursive: true });
    const realMountDir = await realpath(mountDir);
    await writeFile(join(realMountDir, "data.txt"), "mount data");

    try {
      await expect(
        resolveSafePath(join(realMountDir, "data.txt"), realWorkspace, "write", [
          { hostPath: realMountDir, sandboxPath: "/mnt/data", mode: "ro" },
        ]),
      ).rejects.toThrow("read-only mount");
    } finally {
      await rm(realMountDir, { recursive: true, force: true });
    }
  });
});

describe("filterEnv", () => {
  it("removes dangerous variables", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      LD_PRELOAD: "/evil.so",
      DYLD_INSERT_LIBRARIES: "/evil.dylib",
      SAFE_VAR: "value",
    };
    const filtered = filterEnv(env);
    expect(filtered.PATH).toBe("/usr/bin");
    expect(filtered.HOME).toBe("/home/user");
    expect(filtered.SAFE_VAR).toBe("value");
    expect(filtered.LD_PRELOAD).toBeUndefined();
    expect(filtered.DYLD_INSERT_LIBRARIES).toBeUndefined();
  });

  it("preserves non-blocked variables", () => {
    const env = { FOO: "bar", BAZ: "qux" };
    const filtered = filterEnv(env);
    expect(filtered).toEqual(env);
  });
});
