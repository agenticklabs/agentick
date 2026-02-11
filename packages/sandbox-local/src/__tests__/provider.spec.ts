import { describe, it, expect, afterEach } from "vitest";
import { localProvider } from "../provider";
import type { SandboxHandle as Sandbox } from "@agentick/sandbox";

describe("localProvider", () => {
  const sandboxes: Sandbox[] = [];

  afterEach(async () => {
    for (const sb of sandboxes) {
      await sb.destroy().catch(() => {});
    }
    sandboxes.length = 0;
  });

  it("creates a sandbox with strategy none", async () => {
    const provider = localProvider({ strategy: "none" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    expect(sandbox.id).toBeTruthy();
    expect(sandbox.workspacePath).toBeTruthy();
  });

  it("executes a command", async () => {
    const provider = localProvider({ strategy: "none" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    const result = await sandbox.exec("echo hello");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr", async () => {
    const provider = localProvider({ strategy: "none" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    const result = await sandbox.exec("echo error >&2");
    expect(result.stderr.trim()).toBe("error");
  });

  it("returns non-zero exit codes", async () => {
    const provider = localProvider({ strategy: "none" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    const result = await sandbox.exec("exit 42");
    expect(result.exitCode).toBe(42);
  });

  it("writes and reads files", async () => {
    const provider = localProvider({ strategy: "none" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    await sandbox.writeFile("test.txt", "hello world");
    const content = await sandbox.readFile("test.txt");
    expect(content).toBe("hello world");
  });

  it("edits files", async () => {
    const provider = localProvider({ strategy: "none" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    await sandbox.writeFile("code.js", "const x = 1;\nconst y = 2;\n");
    const result = await sandbox.editFile("code.js", [
      { old: "const x = 1;", new: "const x = 42;" },
    ]);
    expect(result.applied).toBe(1);

    const content = await sandbox.readFile("code.js");
    expect(content).toContain("const x = 42;");
    expect(content).toContain("const y = 2;");
  });

  it("rejects file access outside workspace", async () => {
    const provider = localProvider({ strategy: "none" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    await expect(sandbox.readFile("/etc/passwd")).rejects.toThrow("escapes sandbox");
  });

  it("rejects write outside workspace", async () => {
    const provider = localProvider({ strategy: "none" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    await expect(sandbox.writeFile("/tmp/escape.txt", "bad")).rejects.toThrow("escapes sandbox");
  });

  it("enforces command timeout", async () => {
    const provider = localProvider({ strategy: "none" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    const result = await sandbox.exec("sleep 60", { timeout: 500 });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("timed out");
  }, 10000);

  it("streams output via onOutput callback", async () => {
    const provider = localProvider({ strategy: "none" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    const chunks: { stream: string; data: string }[] = [];
    const result = await sandbox.exec("echo chunk1 && echo chunk2 >&2", {
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(result.stdout).toContain("chunk1");
    expect(result.stderr).toContain("chunk2");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.stream === "stdout")).toBe(true);
    expect(chunks.some((c) => c.stream === "stderr")).toBe(true);
  });

  it("cleans up workspace on destroy", async () => {
    const provider = localProvider({ strategy: "none", cleanupWorkspace: true });
    const sandbox = await provider.create({ workspace: true });
    const path = sandbox.workspacePath;

    await sandbox.writeFile("test.txt", "data");
    await sandbox.destroy();

    // Workspace should be gone
    const { access } = await import("node:fs/promises");
    await expect(access(path)).rejects.toThrow("ENOENT");
  });

  it("rejects operations after destroy", async () => {
    const provider = localProvider({ strategy: "none" });
    const sandbox = await provider.create({ workspace: true });
    await sandbox.destroy();

    await expect(sandbox.exec("echo hi")).rejects.toThrow("destroyed");
    await expect(sandbox.readFile("test.txt")).rejects.toThrow("destroyed");
    await expect(sandbox.writeFile("test.txt", "data")).rejects.toThrow("destroyed");
  });

  it("uses custom environment variables", async () => {
    const provider = localProvider({ strategy: "none" });
    const sandbox = await provider.create({
      workspace: true,
      env: { MY_VAR: "hello" },
    });
    sandboxes.push(sandbox);

    const result = await sandbox.exec("echo $MY_VAR");
    expect(result.stdout.trim()).toBe("hello");
  });

  it("respects per-command env overrides", async () => {
    const provider = localProvider({ strategy: "none" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    const result = await sandbox.exec("echo $TEST_VAR", {
      env: { TEST_VAR: "override" },
    });
    expect(result.stdout.trim()).toBe("override");
  });

  it("creates nested directories when writing files", async () => {
    const provider = localProvider({ strategy: "none" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    await sandbox.writeFile("a/b/c/deep.txt", "deep content");
    const content = await sandbox.readFile("a/b/c/deep.txt");
    expect(content).toBe("deep content");
  });

  it("restores a sandbox from snapshot", async () => {
    const provider = localProvider({ strategy: "none" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    await sandbox.writeFile("data.txt", "persistent");

    const restored = await provider.restore!({
      provider: "local",
      id: sandbox.id,
      workspacePath: sandbox.workspacePath,
    });
    sandboxes.push(restored);

    const content = await restored.readFile("data.txt");
    expect(content).toBe("persistent");
  });
});
