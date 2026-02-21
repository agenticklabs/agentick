import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalSandbox } from "../local-sandbox.js";
import { SandboxAccessError } from "@agentick/sandbox";
import { BaseExecutor } from "../executor/base.js";
import { ResourceEnforcer } from "../resources.js";
import { mkdir, rm, realpath, writeFile } from "node:fs/promises";
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
