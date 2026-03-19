/**
 * MountAwareVFS
 *
 * Wraps a secure-exec InMemoryFileSystem with host mount pass-through.
 * Paths within configured mounts delegate to host `node:fs`.
 * All other paths delegate to the in-memory VFS.
 */

import * as nodeFs from "node:fs/promises";
import * as path from "node:path/posix";
import type { VirtualFileSystem } from "secure-exec";

/** Extract the stat return type from VirtualFileSystem.stat */
type VirtualStat = Awaited<ReturnType<VirtualFileSystem["stat"]>>;
import type { Mount } from "@agentick/sandbox";
import { SandboxAccessError } from "@agentick/sandbox";

interface MountEntry {
  hostPath: string;
  sandboxPath: string;
  mode: "ro" | "rw";
}

export class MountAwareVFS implements VirtualFileSystem {
  private mounts: MountEntry[] = [];

  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly workspacePath: string,
  ) {}

  // ── Mount management ─────────────────────────────────────────────────

  addMount(mount: Mount): void {
    const existing = this.mounts.findIndex((m) => m.sandboxPath === mount.sandbox);
    if (existing !== -1) {
      this.mounts[existing] = {
        hostPath: mount.host,
        sandboxPath: mount.sandbox,
        mode: mount.mode ?? "rw",
      };
    } else {
      this.mounts.push({
        hostPath: mount.host,
        sandboxPath: mount.sandbox,
        mode: mount.mode ?? "rw",
      });
    }
  }

  removeMount(hostPath: string): void {
    this.mounts = this.mounts.filter((m) => m.hostPath !== hostPath);
  }

  listMounts(): Mount[] {
    return this.mounts.map((m) => ({
      host: m.hostPath,
      sandbox: m.sandboxPath,
      mode: m.mode,
    }));
  }

  // ── Path resolution ──────────────────────────────────────────────────

  /**
   * Resolve a sandbox path, validating it stays within workspace or mounts.
   * Returns { type: "vfs" } for in-memory paths or { type: "host", hostPath } for mounted paths.
   */
  resolvePath(
    inputPath: string,
    mode: "read" | "write" = "read",
  ): { type: "vfs"; resolved: string } | { type: "host"; hostPath: string; mount: MountEntry } {
    validatePath(inputPath);

    // Normalize to absolute POSIX path
    const resolved = inputPath.startsWith("/")
      ? path.normalize(inputPath)
      : path.normalize(path.join(this.workspacePath, inputPath));

    // Check mounts first (more specific paths first)
    const sortedMounts = [...this.mounts].sort(
      (a, b) => b.sandboxPath.length - a.sandboxPath.length,
    );

    for (const mount of sortedMounts) {
      if (resolved === mount.sandboxPath || resolved.startsWith(mount.sandboxPath + "/")) {
        if (mode === "write" && mount.mode === "ro") {
          throw new SandboxAccessError(inputPath, resolved, mode);
        }
        const relative =
          resolved === mount.sandboxPath ? "" : resolved.slice(mount.sandboxPath.length);
        const hostPath = path.join(mount.hostPath, relative);
        return { type: "host", hostPath, mount };
      }
    }

    // Check workspace boundary
    if (resolved !== this.workspacePath && !resolved.startsWith(this.workspacePath + "/")) {
      throw new SandboxAccessError(inputPath, resolved, mode);
    }

    return { type: "vfs", resolved };
  }

  // ── VirtualFileSystem interface ──────────────────────────────────────

  async readFile(filePath: string): Promise<Uint8Array> {
    const loc = this.resolvePath(filePath, "read");
    if (loc.type === "host") {
      return new Uint8Array(await nodeFs.readFile(loc.hostPath));
    }
    return this.vfs.readFile(loc.resolved);
  }

  async readTextFile(filePath: string): Promise<string> {
    const loc = this.resolvePath(filePath, "read");
    if (loc.type === "host") {
      return nodeFs.readFile(loc.hostPath, "utf-8");
    }
    return this.vfs.readTextFile(loc.resolved);
  }

  async readDir(dirPath: string): Promise<string[]> {
    const loc = this.resolvePath(dirPath, "read");
    if (loc.type === "host") {
      return nodeFs.readdir(loc.hostPath);
    }
    return this.vfs.readDir(loc.resolved);
  }

  async readDirWithTypes(dirPath: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
    const loc = this.resolvePath(dirPath, "read");
    if (loc.type === "host") {
      const entries = await nodeFs.readdir(loc.hostPath, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    }
    return this.vfs.readDirWithTypes(loc.resolved);
  }

  async writeFile(filePath: string, content: Uint8Array | string): Promise<void> {
    const loc = this.resolvePath(filePath, "write");
    if (loc.type === "host") {
      await nodeFs.mkdir(path.dirname(loc.hostPath), { recursive: true });
      await nodeFs.writeFile(loc.hostPath, content);
      return;
    }
    // Ensure parent directories exist in VFS
    const dir = path.dirname(loc.resolved);
    if (dir !== loc.resolved) {
      try {
        await this.vfs.mkdir(dir);
      } catch {
        // Directory may already exist
      }
    }
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await this.vfs.writeFile(loc.resolved, data);
  }

  async createDir(dirPath: string): Promise<void> {
    const loc = this.resolvePath(dirPath, "write");
    if (loc.type === "host") {
      await nodeFs.mkdir(loc.hostPath, { recursive: true });
      return;
    }
    return this.vfs.createDir(loc.resolved);
  }

  async mkdir(dirPath: string): Promise<void> {
    const loc = this.resolvePath(dirPath, "write");
    if (loc.type === "host") {
      await nodeFs.mkdir(loc.hostPath, { recursive: true });
      return;
    }
    return this.vfs.mkdir(loc.resolved);
  }

  async exists(filePath: string): Promise<boolean> {
    const loc = this.resolvePath(filePath, "read");
    if (loc.type === "host") {
      try {
        await nodeFs.access(loc.hostPath);
        return true;
      } catch {
        return false;
      }
    }
    return this.vfs.exists(loc.resolved);
  }

  async stat(filePath: string): Promise<VirtualStat> {
    const loc = this.resolvePath(filePath, "read");
    if (loc.type === "host") {
      const s = await nodeFs.stat(loc.hostPath);
      return hostStatToVirtual(s);
    }
    return this.vfs.stat(loc.resolved);
  }

  async removeFile(filePath: string): Promise<void> {
    const loc = this.resolvePath(filePath, "write");
    if (loc.type === "host") {
      await nodeFs.unlink(loc.hostPath);
      return;
    }
    return this.vfs.removeFile(loc.resolved);
  }

  async removeDir(dirPath: string): Promise<void> {
    const loc = this.resolvePath(dirPath, "write");
    if (loc.type === "host") {
      await nodeFs.rm(loc.hostPath, { recursive: true });
      return;
    }
    return this.vfs.removeDir(loc.resolved);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldLoc = this.resolvePath(oldPath, "write");
    const newLoc = this.resolvePath(newPath, "write");

    if (oldLoc.type === "host" && newLoc.type === "host") {
      await nodeFs.rename(oldLoc.hostPath, newLoc.hostPath);
      return;
    }
    if (oldLoc.type === "vfs" && newLoc.type === "vfs") {
      return this.vfs.rename(oldLoc.resolved, newLoc.resolved);
    }

    // Cross-domain: copy + delete
    const content = await this.readFile(oldPath);
    await this.writeFile(newPath, content);
    await this.removeFile(oldPath);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const loc = this.resolvePath(linkPath, "write");
    if (loc.type === "host") {
      await nodeFs.symlink(target, loc.hostPath);
      return;
    }
    return this.vfs.symlink(target, loc.resolved);
  }

  async readlink(filePath: string): Promise<string> {
    const loc = this.resolvePath(filePath, "read");
    if (loc.type === "host") {
      return nodeFs.readlink(loc.hostPath);
    }
    return this.vfs.readlink(loc.resolved);
  }

  async lstat(filePath: string): Promise<VirtualStat> {
    const loc = this.resolvePath(filePath, "read");
    if (loc.type === "host") {
      const s = await nodeFs.lstat(loc.hostPath);
      return {
        ...hostStatToVirtual(s),
        isSymbolicLink: s.isSymbolicLink(),
      };
    }
    return this.vfs.lstat(loc.resolved);
  }

  async link(oldPath: string, newPath: string): Promise<void> {
    const oldLoc = this.resolvePath(oldPath, "read");
    const newLoc = this.resolvePath(newPath, "write");
    if (oldLoc.type === "host" && newLoc.type === "host") {
      await nodeFs.link(oldLoc.hostPath, newLoc.hostPath);
      return;
    }
    if (oldLoc.type === "vfs" && newLoc.type === "vfs") {
      return this.vfs.link(oldLoc.resolved, newLoc.resolved);
    }
    throw new Error("Cannot create hard link across VFS and host filesystem");
  }

  async chmod(filePath: string, mode: number): Promise<void> {
    const loc = this.resolvePath(filePath, "write");
    if (loc.type === "host") {
      await nodeFs.chmod(loc.hostPath, mode);
      return;
    }
    return this.vfs.chmod(loc.resolved, mode);
  }

  async chown(filePath: string, uid: number, gid: number): Promise<void> {
    const loc = this.resolvePath(filePath, "write");
    if (loc.type === "host") {
      await nodeFs.chown(loc.hostPath, uid, gid);
      return;
    }
    return this.vfs.chown(loc.resolved, uid, gid);
  }

  async utimes(filePath: string, atime: number, mtime: number): Promise<void> {
    const loc = this.resolvePath(filePath, "write");
    if (loc.type === "host") {
      await nodeFs.utimes(loc.hostPath, atime / 1000, mtime / 1000);
      return;
    }
    return this.vfs.utimes(loc.resolved, atime, mtime);
  }

  async truncate(filePath: string, length: number): Promise<void> {
    const loc = this.resolvePath(filePath, "write");
    if (loc.type === "host") {
      await nodeFs.truncate(loc.hostPath, length);
      return;
    }
    return this.vfs.truncate(loc.resolved, length);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function validatePath(inputPath: string): void {
  if (inputPath.includes("\0")) {
    throw new Error("Path contains null bytes");
  }
}

function hostStatToVirtual(s: Awaited<ReturnType<typeof nodeFs.stat>>): VirtualStat {
  return {
    mode: Number(s.mode),
    size: Number(s.size),
    isDirectory: s.isDirectory(),
    atimeMs: Number(s.atimeMs),
    mtimeMs: Number(s.mtimeMs),
    ctimeMs: Number(s.ctimeMs),
    birthtimeMs: Number(s.birthtimeMs),
  };
}
