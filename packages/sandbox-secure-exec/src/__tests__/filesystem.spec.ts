import { describe, it, expect, beforeEach } from "vitest";
import { createInMemoryFileSystem } from "secure-exec";
import { MountAwareVFS } from "../filesystem.js";
import { SandboxAccessError } from "@agentick/sandbox";

describe("MountAwareVFS", () => {
  let vfs: MountAwareVFS;

  beforeEach(async () => {
    const memFs = createInMemoryFileSystem();
    vfs = new MountAwareVFS(memFs, "/workspace");
    await memFs.mkdir("/workspace");
  });

  // ── Path resolution ─────────────────────────────────────────────────

  describe("resolvePath", () => {
    it("resolves relative paths within workspace", () => {
      const result = vfs.resolvePath("foo/bar.txt");
      expect(result).toEqual({ type: "vfs", resolved: "/workspace/foo/bar.txt" });
    });

    it("resolves absolute workspace paths", () => {
      const result = vfs.resolvePath("/workspace/file.js");
      expect(result).toEqual({ type: "vfs", resolved: "/workspace/file.js" });
    });

    it("resolves workspace root itself", () => {
      const result = vfs.resolvePath("/workspace");
      expect(result).toEqual({ type: "vfs", resolved: "/workspace" });
    });

    it("normalizes .. within workspace", () => {
      const result = vfs.resolvePath("/workspace/a/../b/file.txt");
      expect(result).toEqual({ type: "vfs", resolved: "/workspace/b/file.txt" });
    });

    it("throws SandboxAccessError for paths escaping workspace", () => {
      expect(() => vfs.resolvePath("/etc/passwd")).toThrow(SandboxAccessError);
    });

    it("throws SandboxAccessError for traversal escapes", () => {
      expect(() => vfs.resolvePath("/workspace/../../etc/passwd")).toThrow(SandboxAccessError);
    });

    it("throws for null bytes", () => {
      expect(() => vfs.resolvePath("/workspace/\0evil")).toThrow("null bytes");
    });

    it("prevents prefix collision (/workspace2 is not /workspace)", () => {
      expect(() => vfs.resolvePath("/workspace2/file.txt")).toThrow(SandboxAccessError);
    });
  });

  // ── Mount handling ──────────────────────────────────────────────────

  describe("mounts", () => {
    it("resolves paths within a mount", () => {
      vfs.addMount({ host: "/host/data", sandbox: "/mnt/data" });
      const result = vfs.resolvePath("/mnt/data/file.txt");
      expect(result.type).toBe("host");
      if (result.type === "host") {
        expect(result.hostPath).toBe("/host/data/file.txt");
      }
    });

    it("resolves mount root", () => {
      vfs.addMount({ host: "/host/data", sandbox: "/mnt/data" });
      const result = vfs.resolvePath("/mnt/data");
      expect(result.type).toBe("host");
      if (result.type === "host") {
        expect(result.hostPath).toBe("/host/data");
      }
    });

    it("rejects writes to read-only mounts", () => {
      vfs.addMount({ host: "/host/data", sandbox: "/mnt/data", mode: "ro" });
      expect(() => vfs.resolvePath("/mnt/data/file.txt", "write")).toThrow(SandboxAccessError);
    });

    it("allows reads from read-only mounts", () => {
      vfs.addMount({ host: "/host/data", sandbox: "/mnt/data", mode: "ro" });
      const result = vfs.resolvePath("/mnt/data/file.txt", "read");
      expect(result.type).toBe("host");
    });

    it("more specific mount wins", () => {
      vfs.addMount({ host: "/host/a", sandbox: "/mnt" });
      vfs.addMount({ host: "/host/b", sandbox: "/mnt/nested" });
      const result = vfs.resolvePath("/mnt/nested/file.txt");
      expect(result.type).toBe("host");
      if (result.type === "host") {
        expect(result.hostPath).toBe("/host/b/file.txt");
      }
    });

    it("removeMount removes by host path", () => {
      vfs.addMount({ host: "/host/data", sandbox: "/mnt/data" });
      vfs.removeMount("/host/data");
      expect(vfs.listMounts()).toEqual([]);
      // Now /mnt/data should fail (not in workspace or any mount)
      expect(() => vfs.resolvePath("/mnt/data/file.txt")).toThrow(SandboxAccessError);
    });

    it("listMounts returns current mounts", () => {
      vfs.addMount({ host: "/a", sandbox: "/mnt/a", mode: "ro" });
      vfs.addMount({ host: "/b", sandbox: "/mnt/b" });
      expect(vfs.listMounts()).toEqual([
        { host: "/a", sandbox: "/mnt/a", mode: "ro" },
        { host: "/b", sandbox: "/mnt/b", mode: "rw" },
      ]);
    });

    it("addMount updates existing mount with same sandbox path", () => {
      vfs.addMount({ host: "/old", sandbox: "/mnt/data" });
      vfs.addMount({ host: "/new", sandbox: "/mnt/data" });
      expect(vfs.listMounts()).toHaveLength(1);
      expect(vfs.listMounts()[0]!.host).toBe("/new");
    });
  });

  // ── VFS file operations ─────────────────────────────────────────────

  describe("file operations", () => {
    it("writes and reads a file", async () => {
      await vfs.writeFile("/workspace/test.txt", "hello world");
      const content = await vfs.readTextFile("/workspace/test.txt");
      expect(content).toBe("hello world");
    });

    it("writes binary and reads back", async () => {
      const data = new Uint8Array([1, 2, 3, 4]);
      await vfs.writeFile("/workspace/bin", data);
      const read = await vfs.readFile("/workspace/bin");
      expect(read).toEqual(data);
    });

    it("checks file existence", async () => {
      expect(await vfs.exists("/workspace/nope.txt")).toBe(false);
      await vfs.writeFile("/workspace/yes.txt", "yes");
      expect(await vfs.exists("/workspace/yes.txt")).toBe(true);
    });

    it("creates and lists directories", async () => {
      await vfs.mkdir("/workspace/subdir");
      await vfs.writeFile("/workspace/subdir/a.txt", "a");
      await vfs.writeFile("/workspace/subdir/b.txt", "b");
      const entries = await vfs.readDir("/workspace/subdir");
      expect(entries.sort()).toEqual(["a.txt", "b.txt"]);
    });

    it("removes a file", async () => {
      await vfs.writeFile("/workspace/rm-me.txt", "gone");
      await vfs.removeFile("/workspace/rm-me.txt");
      expect(await vfs.exists("/workspace/rm-me.txt")).toBe(false);
    });

    it("renames a file within VFS", async () => {
      await vfs.writeFile("/workspace/old.txt", "content");
      await vfs.rename("/workspace/old.txt", "/workspace/new.txt");
      expect(await vfs.exists("/workspace/old.txt")).toBe(false);
      expect(await vfs.readTextFile("/workspace/new.txt")).toBe("content");
    });

    it("stat returns file metadata", async () => {
      await vfs.writeFile("/workspace/stat-me.txt", "data");
      const s = await vfs.stat("/workspace/stat-me.txt");
      expect(s.isDirectory).toBe(false);
      expect(s.size).toBeGreaterThan(0);
    });

    it("rejects writes outside workspace", async () => {
      await expect(vfs.writeFile("/etc/evil", "hack")).rejects.toThrow(
        "Path escapes sandbox: /etc/evil → /etc/evil",
      );
    });

    it("rejects reads outside workspace", async () => {
      await expect(vfs.readTextFile("/etc/passwd")).rejects.toThrow(
        "Path escapes sandbox: /etc/passwd → /etc/passwd",
      );
    });
  });
});
