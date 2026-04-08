import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalSandbox } from "../local-sandbox.js";
import { SandboxAccessError } from "@agentick/sandbox";
import { BaseExecutor } from "../executor/base.js";
import { ResourceEnforcer } from "../resources.js";
import { mkdir, rm, realpath, writeFile, lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

describe("LocalSandbox", () => {
  let workspace: string;
  let sandbox: LocalSandbox;

  beforeEach(async () => {
    const raw = join(tmpdir(), `sandbox-unit-${randomBytes(4).toString("hex")}`);
    await mkdir(raw, { recursive: true });
    // Resolve symlinks (macOS: /var → /private/var)
    workspace = await realpath(raw);

    const resources = new ResourceEnforcer(workspace, {});
    await resources.start();

    sandbox = new LocalSandbox({
      id: "test-sandbox",
      workspacePath: workspace,
      executor: new BaseExecutor(),
      env: {
        HOME: workspace,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TERM: "dumb",
      },
      mounts: [],
      permissions: {
        readPaths: [workspace],
        writePaths: [workspace],
        network: false,
        childProcess: true,
      },
      resources,
      cleanupWorkspace: true,
      destroyWorkspace: () => rm(workspace, { recursive: true, force: true }),
    });
  });

  afterEach(async () => {
    await sandbox.destroy().catch(() => {});
  });

  it("has correct id and workspacePath", () => {
    expect(sandbox.id).toBe("test-sandbox");
    expect(sandbox.workspacePath).toBe(workspace);
  });

  it("executes basic commands", async () => {
    const result = await sandbox.exec("echo test");
    expect(result.stdout.trim()).toBe("test");
    expect(result.exitCode).toBe(0);
  });

  it("captures exit codes", async () => {
    const result = await sandbox.exec("exit 7");
    expect(result.exitCode).toBe(7);
  });

  it("reads and writes files", async () => {
    await sandbox.writeFile("hello.txt", "world");
    const content = await sandbox.readFile("hello.txt");
    expect(content).toBe("world");
  });

  it("creates parent directories for writes", async () => {
    await sandbox.writeFile("deep/nested/file.txt", "content");
    const content = await sandbox.readFile("deep/nested/file.txt");
    expect(content).toBe("content");
  });

  it("rejects reads outside workspace", async () => {
    await expect(sandbox.readFile("/etc/hosts")).rejects.toThrow("escapes sandbox");
  });

  it("rejects writes outside workspace", async () => {
    await expect(sandbox.writeFile("/tmp/bad.txt", "x")).rejects.toThrow("escapes sandbox");
  });

  it("edits files with surgical replacements", async () => {
    await sandbox.writeFile("code.ts", "const a = 1;\nconst b = 2;\n");
    const result = await sandbox.editFile("code.ts", [
      { old: "const a = 1;", new: "const a = 100;" },
    ]);
    expect(result.applied).toBe(1);

    const content = await sandbox.readFile("code.ts");
    expect(content).toContain("const a = 100;");
  });

  it("prevents use after destroy", async () => {
    await sandbox.destroy();
    await expect(sandbox.exec("echo hi")).rejects.toThrow("destroyed");
  });

  it("destroy is idempotent", async () => {
    await sandbox.destroy();
    await sandbox.destroy(); // Should not throw
  });

  it("handles command stderr", async () => {
    const result = await sandbox.exec("echo err >&2");
    expect(result.stderr.trim()).toBe("err");
  });

  it("respects per-command cwd", async () => {
    await mkdir(join(workspace, "subdir"), { recursive: true });
    const result = await sandbox.exec("pwd", { cwd: "subdir" });
    expect(result.stdout.trim()).toBe(join(workspace, "subdir"));
  });

  it("respects per-command env", async () => {
    const result = await sandbox.exec("echo $FOO", { env: { FOO: "bar" } });
    expect(result.stdout.trim()).toBe("bar");
  });

  describe("addMount consolidation", () => {
    let mountRoot: string;

    beforeEach(async () => {
      const raw = join(tmpdir(), `mount-test-${randomBytes(4).toString("hex")}`);
      await mkdir(join(raw, "foo", "bar"), { recursive: true });
      await mkdir(join(raw, "foo", "a"), { recursive: true });
      await mkdir(join(raw, "foo", "b"), { recursive: true });
      await mkdir(join(raw, "foo", "c"), { recursive: true });
      mountRoot = await realpath(raw);
    });

    afterEach(async () => {
      await rm(mountRoot, { recursive: true, force: true });
    });

    const fooPath = () => join(mountRoot, "foo");
    const barPath = () => join(mountRoot, "foo", "bar");
    const aPath = () => join(mountRoot, "foo", "a");
    const bPath = () => join(mountRoot, "foo", "b");
    const cPath = () => join(mountRoot, "foo", "c");

    it("rw parent consumes ro child", async () => {
      await sandbox.addMount({ host: barPath(), sandbox: barPath(), mode: "ro" });
      expect(sandbox.listMounts()).toHaveLength(1);

      await sandbox.addMount({ host: fooPath(), sandbox: fooPath(), mode: "rw" });
      const mounts = sandbox.listMounts();
      expect(mounts).toHaveLength(1);
      expect(mounts[0]!.host).toBe(fooPath());
      expect(mounts[0]!.mode).toBe("rw");
    });

    it("rw parent consumes rw child", async () => {
      await sandbox.addMount({ host: barPath(), sandbox: barPath(), mode: "rw" });
      await sandbox.addMount({ host: fooPath(), sandbox: fooPath(), mode: "rw" });
      const mounts = sandbox.listMounts();
      expect(mounts).toHaveLength(1);
      expect(mounts[0]!.host).toBe(fooPath());
    });

    it("ro parent does NOT consume rw child", async () => {
      await sandbox.addMount({ host: barPath(), sandbox: barPath(), mode: "rw" });
      await sandbox.addMount({ host: fooPath(), sandbox: fooPath(), mode: "ro" });
      const mounts = sandbox.listMounts();
      expect(mounts).toHaveLength(2);
      expect(mounts.some((m) => m.host === barPath() && m.mode === "rw")).toBe(true);
      expect(mounts.some((m) => m.host === fooPath() && m.mode === "ro")).toBe(true);
    });

    it("ro parent consumes ro child", async () => {
      await sandbox.addMount({ host: barPath(), sandbox: barPath(), mode: "ro" });
      await sandbox.addMount({ host: fooPath(), sandbox: fooPath(), mode: "ro" });
      const mounts = sandbox.listMounts();
      expect(mounts).toHaveLength(1);
      expect(mounts[0]!.host).toBe(fooPath());
      expect(mounts[0]!.mode).toBe("ro");
    });

    it("skips redundant child when rw parent exists", async () => {
      await sandbox.addMount({ host: fooPath(), sandbox: fooPath(), mode: "rw" });
      await sandbox.addMount({ host: barPath(), sandbox: barPath(), mode: "rw" });
      const mounts = sandbox.listMounts();
      expect(mounts).toHaveLength(1);
      expect(mounts[0]!.host).toBe(fooPath());
    });

    it("allows rw child under ro parent", async () => {
      await sandbox.addMount({ host: fooPath(), sandbox: fooPath(), mode: "ro" });
      await sandbox.addMount({ host: barPath(), sandbox: barPath(), mode: "rw" });
      const mounts = sandbox.listMounts();
      expect(mounts).toHaveLength(2);
    });

    it("promotes mode on exact match (ro → rw)", async () => {
      await sandbox.addMount({ host: fooPath(), sandbox: fooPath(), mode: "ro" });
      await sandbox.addMount({ host: fooPath(), sandbox: fooPath(), mode: "rw" });
      const mounts = sandbox.listMounts();
      expect(mounts).toHaveLength(1);
      expect(mounts[0]!.mode).toBe("rw");
    });

    it("no-op on exact match same mode", async () => {
      await sandbox.addMount({ host: fooPath(), sandbox: fooPath(), mode: "rw" });
      await sandbox.addMount({ host: fooPath(), sandbox: fooPath(), mode: "rw" });
      const mounts = sandbox.listMounts();
      expect(mounts).toHaveLength(1);
    });

    it("rw parent consumes multiple children at once", async () => {
      await sandbox.addMount({ host: aPath(), sandbox: aPath(), mode: "rw" });
      await sandbox.addMount({ host: bPath(), sandbox: bPath(), mode: "ro" });
      await sandbox.addMount({ host: cPath(), sandbox: cPath(), mode: "rw" });
      expect(sandbox.listMounts()).toHaveLength(3);

      await sandbox.addMount({ host: fooPath(), sandbox: fooPath(), mode: "rw" });
      const mounts = sandbox.listMounts();
      expect(mounts).toHaveLength(1);
      expect(mounts[0]!.host).toBe(fooPath());
    });

    it("ro parent consumes only ro children, keeps rw children", async () => {
      await sandbox.addMount({ host: aPath(), sandbox: aPath(), mode: "rw" });
      await sandbox.addMount({ host: bPath(), sandbox: bPath(), mode: "ro" });
      await sandbox.addMount({ host: cPath(), sandbox: cPath(), mode: "rw" });
      expect(sandbox.listMounts()).toHaveLength(3);

      await sandbox.addMount({ host: fooPath(), sandbox: fooPath(), mode: "ro" });
      const mounts = sandbox.listMounts();
      // /foo/a (rw) and /foo/c (rw) survive, /foo/b (ro) consumed, /foo (ro) added
      expect(mounts).toHaveLength(3);
      expect(mounts.some((m) => m.host === aPath() && m.mode === "rw")).toBe(true);
      expect(mounts.some((m) => m.host === cPath() && m.mode === "rw")).toBe(true);
      expect(mounts.some((m) => m.host === fooPath() && m.mode === "ro")).toBe(true);
      // /foo/b was consumed
      expect(mounts.some((m) => m.host === bPath())).toBe(false);
    });
  });

  describe("addMount symlink creation", () => {
    it("creates symlink when sandbox path differs from host path", async () => {
      // Create a real directory to mount
      const hostDir = join(tmpdir(), `mount-symlink-${randomBytes(4).toString("hex")}`);
      await mkdir(hostDir, { recursive: true });
      await writeFile(join(hostDir, "test.txt"), "hello");
      const realHostDir = await realpath(hostDir);

      // addMount with a relative sandbox path
      await sandbox.addMount({ host: realHostDir, sandbox: "my-data", mode: "rw" });

      // Symlink should exist in workspace
      const linkPath = join(sandbox.workspacePath, "my-data");
      const stat = await lstat(linkPath);
      expect(stat.isSymbolicLink()).toBe(true);

      // Symlink should point to the host dir
      const target = await readlink(linkPath);
      expect(target).toBe(realHostDir);

      // Agent should be able to read through it
      const result = await sandbox.exec("cat my-data/test.txt");
      expect(result.stdout.trim()).toBe("hello");

      await rm(hostDir, { recursive: true, force: true });
    });

    it("does NOT create symlink when sandbox path equals host path", async () => {
      const hostDir = join(tmpdir(), `mount-nosymlink-${randomBytes(4).toString("hex")}`);
      await mkdir(hostDir, { recursive: true });
      const realHostDir = await realpath(hostDir);

      // Same host and sandbox path — no symlink needed
      await sandbox.addMount({ host: realHostDir, sandbox: realHostDir, mode: "rw" });

      // No symlink in workspace (the mount is accessed via its real path)
      const linkPath = join(sandbox.workspacePath, realHostDir.split("/").pop()!);
      const stat = await lstat(linkPath).catch(() => null);
      expect(stat).toBeNull();

      await rm(hostDir, { recursive: true, force: true });
    });

    it("handles nested sandbox path", async () => {
      const hostDir = join(tmpdir(), `mount-nested-${randomBytes(4).toString("hex")}`);
      await mkdir(hostDir, { recursive: true });
      await writeFile(join(hostDir, "file.md"), "content");
      const realHostDir = await realpath(hostDir);

      await sandbox.addMount({ host: realHostDir, sandbox: "workspace/deep/mount", mode: "rw" });

      const linkPath = join(sandbox.workspacePath, "workspace", "deep", "mount");
      const stat = await lstat(linkPath);
      expect(stat.isSymbolicLink()).toBe(true);

      const result = await sandbox.exec("cat workspace/deep/mount/file.md");
      expect(result.stdout.trim()).toBe("content");

      await rm(hostDir, { recursive: true, force: true });
    });
  });

  describe("sandbox access recovery", () => {
    let outsideDir: string;
    let outsideFile: string;

    beforeEach(async () => {
      const raw = join(tmpdir(), `sandbox-outside-${randomBytes(4).toString("hex")}`);
      await mkdir(raw, { recursive: true });
      outsideDir = await realpath(raw);
      outsideFile = join(outsideDir, "secret.txt");
      await writeFile(outsideFile, "secret content");
    });

    afterEach(async () => {
      await rm(outsideDir, { recursive: true, force: true });
    });

    it("throws SandboxAccessError with recover function for out-of-bounds read", async () => {
      try {
        await sandbox.readFile(outsideFile);
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SandboxAccessError);
        const sae = err as SandboxAccessError;
        expect(sae.requestedPath).toBe(outsideFile);
        expect(sae.mode).toBe("read");
        expect(typeof sae.recover).toBe("function");
      }
    });

    it("throws SandboxAccessError with recover function for out-of-bounds write", async () => {
      const target = join(outsideDir, "new.txt");
      try {
        await sandbox.writeFile(target, "data");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SandboxAccessError);
        const sae = err as SandboxAccessError;
        expect(sae.mode).toBe("write");
        expect(typeof sae.recover).toBe("function");
      }
    });

    it("recover(always=true) adds permanent mount, retry succeeds", async () => {
      // First attempt fails
      let error: SandboxAccessError | undefined;
      try {
        await sandbox.readFile(outsideFile);
      } catch (err) {
        error = err as SandboxAccessError;
      }
      expect(error).toBeDefined();

      // Recover with always=true (permanent mount)
      await error!.recover!(true);

      // Second attempt succeeds — mount is permanent
      const content = await sandbox.readFile(outsideFile);
      expect(content).toBe("secret content");

      // Third attempt also succeeds (mount persists)
      const again = await sandbox.readFile(outsideFile);
      expect(again).toBe("secret content");

      // Verify the mount was added
      const mounts = sandbox.listMounts();
      expect(mounts.some((m) => outsideFile.startsWith(m.host))).toBe(true);
    });

    it("recover(always=false) allows single retry, consumed on use", async () => {
      // First attempt fails
      let error: SandboxAccessError | undefined;
      try {
        await sandbox.readFile(outsideFile);
      } catch (err) {
        error = err as SandboxAccessError;
      }
      expect(error).toBeDefined();

      // Recover with always=false (one-time allow)
      const cleanup = await error!.recover!(false);
      expect(typeof cleanup).toBe("function");

      // Retry succeeds (one-time allow consumed)
      const content = await sandbox.readFile(outsideFile);
      expect(content).toBe("secret content");

      // Third attempt fails again (allow was consumed)
      await expect(sandbox.readFile(outsideFile)).rejects.toBeInstanceOf(SandboxAccessError);

      // No mount was added
      const mounts = sandbox.listMounts();
      expect(mounts.some((m) => outsideFile.startsWith(m.host))).toBe(false);
    });

    it("cleanup function removes unconsumed one-time allow", async () => {
      let error: SandboxAccessError | undefined;
      try {
        await sandbox.readFile(outsideFile);
      } catch (err) {
        error = err as SandboxAccessError;
      }

      // Recover but then immediately clean up without retrying
      const cleanup = await error!.recover!(false);
      cleanup!();

      // Retry fails because cleanup removed the one-time allow
      await expect(sandbox.readFile(outsideFile)).rejects.toBeInstanceOf(SandboxAccessError);
    });

    it("permanent mount uses correct mode for writes", async () => {
      const target = join(outsideDir, "writable.txt");
      let error: SandboxAccessError | undefined;
      try {
        await sandbox.writeFile(target, "data");
      } catch (err) {
        error = err as SandboxAccessError;
      }

      // Recover with always=true for write access
      await error!.recover!(true);

      // Write succeeds
      await sandbox.writeFile(target, "written!");
      const content = await sandbox.readFile(target);
      expect(content).toBe("written!");

      // Verify mount has rw mode
      const mounts = sandbox.listMounts();
      const mount = mounts.find((m) => target.startsWith(m.host));
      expect(mount?.mode).toBe("rw");
    });
  });
});
