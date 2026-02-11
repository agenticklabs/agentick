import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalSandbox } from "../local-sandbox";
import { BaseExecutor } from "../executor/base";
import { ResourceEnforcer } from "../resources";
import { mkdir, rm, realpath } from "node:fs/promises";
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
});
