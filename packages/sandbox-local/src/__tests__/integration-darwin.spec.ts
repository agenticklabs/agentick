/**
 * macOS Seatbelt Integration Tests
 *
 * These tests verify that sandbox-exec actually enforces write and network
 * restrictions. They only run on macOS.
 */

import { describe, it, expect, afterEach } from "vitest";
import { localProvider } from "../provider";
import { isDarwin } from "../testing";
import type { SandboxHandle } from "@agentick/sandbox";

describe.skipIf(!isDarwin)("seatbelt enforcement", () => {
  const sandboxes: SandboxHandle[] = [];

  afterEach(async () => {
    for (const sb of sandboxes) {
      await sb.destroy().catch(() => {});
    }
    sandboxes.length = 0;
  });

  it("runs basic commands under seatbelt", async () => {
    const provider = localProvider({ strategy: "seatbelt" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    const result = await sandbox.exec("echo seatbelt-works");
    expect(result.stdout.trim()).toBe("seatbelt-works");
    expect(result.exitCode).toBe(0);
  });

  it("allows reading and writing within workspace", async () => {
    const provider = localProvider({ strategy: "seatbelt" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    const result = await sandbox.exec("echo hello > test.txt && cat test.txt");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("denies writing files outside workspace", async () => {
    const provider = localProvider({ strategy: "seatbelt" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    // sandbox-exec should deny writing to /usr/local (outside workspace)
    const result = await sandbox.exec("touch /usr/local/sandbox-test-should-not-exist 2>&1");
    expect(result.exitCode).not.toBe(0);
  });

  it("denies reading files under /Users", async () => {
    const provider = localProvider({ strategy: "seatbelt" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    // Attempt to list /Users — should be denied by seatbelt
    const result = await sandbox.exec("ls /Users 2>&1");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Operation not permitted");
  });

  it("denies reading files under /Volumes", async () => {
    const provider = localProvider({ strategy: "seatbelt" });
    const sandbox = await provider.create({ workspace: true });
    sandboxes.push(sandbox);

    const result = await sandbox.exec("ls /Volumes 2>&1");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Operation not permitted");
  });

  it("denies network access when net is false", async () => {
    const provider = localProvider({ strategy: "seatbelt" });
    const sandbox = await provider.create({
      workspace: true,
      permissions: { net: false },
    });
    sandboxes.push(sandbox);

    // curl should fail under network deny
    const result = await sandbox.exec("curl -s --max-time 2 http://example.com 2>&1");
    expect(result.exitCode).not.toBe(0);
  });
});
