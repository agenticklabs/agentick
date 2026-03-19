import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { secureExecProvider } from "../provider.js";
import type { SandboxHandle } from "@agentick/sandbox";

// isolated-vm crashes on Node.js 25 (segfault in Isolate constructor).
// Skip these tests on incompatible Node versions.
const nodeVersion = parseInt(process.versions.node.split(".")[0]!, 10);
const isCompatible = nodeVersion < 25;

describe.skipIf(!isCompatible)("secureExecProvider", () => {
  // ── Provider name (no sandbox needed) ──────────────────────────────

  it("provider has correct name", () => {
    const provider = secureExecProvider();
    expect(provider.name).toBe("secure-exec");
  });

  // ── Shared sandbox for most tests ──────────────────────────────────

  describe("sandbox operations", () => {
    let sandbox: SandboxHandle;

    beforeAll(async () => {
      const provider = secureExecProvider({ timingMitigation: "off" });
      sandbox = await provider.create({});
    });

    afterAll(async () => {
      await sandbox?.destroy();
    });

    it("creates a sandbox with unique id", () => {
      expect(sandbox.id).toBeTruthy();
      expect(sandbox.id).toHaveLength(16);
    });

    it("has default workspace path", () => {
      expect(sandbox.workspacePath).toBe("/workspace");
    });

    it("executes JavaScript and captures stdout", async () => {
      const result = await sandbox.exec("console.log('hello world')");
      expect(result.stdout).toContain("hello world");
      expect(result.exitCode).toBe(0);
    });

    it("captures stderr", async () => {
      const result = await sandbox.exec("console.error('oops')");
      expect(result.stderr).toContain("oops");
    });

    it("returns non-zero exit code on error", async () => {
      const result = await sandbox.exec("process.exit(42)");
      expect(result.exitCode).toBe(42);
    });

    it("persists files across exec calls (state via VFS)", async () => {
      await sandbox.exec("require('fs').writeFileSync('/workspace/counter.txt', '1')");
      const result = await sandbox.exec(
        "console.log(require('fs').readFileSync('/workspace/counter.txt', 'utf8'))",
      );
      expect(result.stdout).toContain("1");
    });

    it("writes and reads files through VFS", async () => {
      await sandbox.writeFile("/workspace/test.txt", "hello");
      const content = await sandbox.readFile("/workspace/test.txt");
      expect(content).toBe("hello");
    });

    it("reads relative paths", async () => {
      await sandbox.writeFile("rel.txt", "relative");
      const content = await sandbox.readFile("rel.txt");
      expect(content).toBe("relative");
    });

    it("throws ENOENT for missing files", async () => {
      try {
        await sandbox.readFile("/workspace/nope.txt");
        expect.unreachable();
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
      }
    });

    it("edits files with applyEdits", async () => {
      await sandbox.writeFile("/workspace/edit.txt", "foo bar baz");
      const result = await sandbox.editFile("/workspace/edit.txt", [{ old: "bar", new: "qux" }]);
      expect(result.applied).toBe(1);
      const content = await sandbox.readFile("/workspace/edit.txt");
      expect(content).toBe("foo qux baz");
    });

    it("provides access to Node.js fs module in isolate", async () => {
      await sandbox.writeFile("/workspace/node-test.txt", "node api works");
      const result = await sandbox.exec(`
        const fs = require('fs');
        const content = fs.readFileSync('/workspace/node-test.txt', 'utf-8');
        console.log(content);
      `);
      expect(result.stdout).toContain("node api works");
    });

    it("streams output via onOutput callback", async () => {
      const chunks: Array<{ stream: string; data: string }> = [];
      const result = await sandbox.exec("console.log('streamed')", {
        onOutput: (chunk) => chunks.push(chunk),
      });
      expect(result.stdout).toContain("streamed");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some((c) => c.data.includes("streamed"))).toBe(true);
    });

    it("manages mounts", async () => {
      expect(sandbox.listMounts()).toEqual([]);
      await sandbox.addMount({ host: "/tmp", sandbox: "/mnt/tmp" });
      expect(sandbox.listMounts()).toHaveLength(1);
      sandbox.removeMount("/tmp");
      expect(sandbox.listMounts()).toEqual([]);
    });
  });

  // ── Tests requiring custom config ──────────────────────────────────

  describe("custom workspace", () => {
    let sandbox: SandboxHandle;

    afterAll(async () => {
      await sandbox?.destroy();
    });

    it("uses custom workspace path", async () => {
      const provider = secureExecProvider({ workspacePath: "/ws" });
      sandbox = await provider.create({});
      expect(sandbox.workspacePath).toBe("/ws");
    });
  });

  describe("environment variables", () => {
    let sandbox: SandboxHandle;

    afterAll(async () => {
      await sandbox?.destroy();
    });

    it("passes environment variables to the runtime", async () => {
      const provider = secureExecProvider({ timingMitigation: "off" });
      sandbox = await provider.create({ env: { MY_VAR: "test_value" } });
      const result = await sandbox.exec("console.log(process.env.MY_VAR)");
      expect(result.stdout).toContain("test_value");
    });
  });

  // ── Lifecycle (needs own sandbox) ──────────────────────────────────

  describe("lifecycle", () => {
    it("destroy is idempotent", async () => {
      const provider = secureExecProvider();
      const sandbox = await provider.create({});
      await sandbox.destroy();
      await sandbox.destroy();
    });

    it("rejects operations after destroy", async () => {
      const provider = secureExecProvider();
      const sandbox = await provider.create({});
      await sandbox.destroy();
      await expect(sandbox.exec("1+1")).rejects.toThrow("destroyed");
      await expect(sandbox.readFile("/workspace/x")).rejects.toThrow("destroyed");
      await expect(sandbox.writeFile("/workspace/x", "y")).rejects.toThrow("destroyed");
    });
  });
});
