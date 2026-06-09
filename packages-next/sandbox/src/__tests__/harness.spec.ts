/**
 * SandboxHarness — smoke tests.
 *
 * Uses a fake `SandboxHandle` to exercise the harness's command
 * surface, ACL flow, and bridge registration. Provider integration
 * tests live in each provider package.
 */

import { describe, expect, it, vi } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import type {
  SandboxHandle,
  SandboxACL,
  SandboxExecOptions,
  SandboxExecResult,
} from "@agentick/spec-next";

import { SandboxHarness } from "../harness.js";
import { inMemorySandboxBridge } from "../bridge.js";

function makeHandle(opts: { execMap?: Record<string, string> } = {}): SandboxHandle {
  const files = new Map<string, string>();
  return {
    id: "h",
    workspacePath: "/tmp/h",
    async exec(command: string, _o?: SandboxExecOptions): Promise<SandboxExecResult> {
      const stdout = opts.execMap?.[command] ?? "";
      return {
        stdout,
        stderr: "",
        exitCode: stdout.length > 0 ? 0 : 1,
        signaled: false,
        durationMs: 1,
      };
    },
    async readFile(path: string): Promise<string> {
      const v = files.get(path);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, content);
    },
    async destroy(): Promise<void> {},
  };
}

function makeHarness(acl?: SandboxACL, handle = makeHandle()): SandboxHarness {
  return new SandboxHarness(new MemoryJournal(), new LocalEventBus(), new LocalInbox(), {
    sandboxId: "test-sb",
    handle,
    providerName: "test",
    ...(acl !== undefined ? { acl } : {}),
    permissionTimeoutDecision: "deny",
    permissionTimeoutMs: 10, // fast timeout for tests
  });
}

describe("SandboxHarness — static ACL", () => {
  it("allows reads matching the static allow list", async () => {
    const handle = makeHandle();
    await handle.writeFile("/workspace/note.md", "hi");
    const h = makeHarness({ read: ["/workspace/*"] }, handle);
    await h.ready;
    const out = await h.readFile({ path: "/workspace/note.md" });
    expect(out).toBe("hi");
  });

  it("denies reads outside the static allow list (no policy)", async () => {
    const handle = makeHandle();
    await handle.writeFile("/etc/passwd", "root:x:0:0");
    const h = makeHarness({ read: ["/workspace/*"] }, handle);
    await h.ready;
    await expect(h.readFile({ path: "/etc/passwd" })).rejects.toMatchObject({
      _tag: "SandboxPermissionDeniedError",
      kind: "read",
      target: "/etc/passwd",
    });
  });

  it("allows exec commands matching the static allow.exec.allow", async () => {
    const handle = makeHandle({ execMap: { "ls -l": "drwxr-xr-x" } });
    const h = makeHarness({ exec: { allow: ["ls *"] } }, handle);
    await h.ready;
    const result = await h.exec({ command: "ls -l" });
    expect(result.stdout).toBe("drwxr-xr-x");
  });

  it("denies exec commands not on the allow list", async () => {
    const h = makeHarness({ exec: { allow: ["ls *"] } });
    await h.ready;
    await expect(h.exec({ command: "rm -rf /" })).rejects.toMatchObject({
      _tag: "SandboxPermissionDeniedError",
      kind: "exec",
    });
  });

  it("denies regardless of allow when static exec.deny matches", async () => {
    const h = makeHarness({
      exec: { allow: ["*"], deny: ["rm *"] },
    });
    await h.ready;
    await expect(h.exec({ command: "rm /tmp/foo" })).rejects.toMatchObject({
      _tag: "SandboxPermissionDeniedError",
    });
  });
});

describe("SandboxHarness — session-learned ACL via snapshot import", () => {
  it("respects imported session allows", async () => {
    const handle = makeHandle();
    await handle.writeFile("/etc/passwd", "root:x:0:0");
    const h = makeHarness(undefined, handle);
    await h.ready;
    h.importACLSnapshot({
      readAllows: ["/etc/passwd"],
      writeAllows: [],
      execAllows: [],
      readDenies: [],
      writeDenies: [],
      execDenies: [],
    });
    const out = await h.readFile({ path: "/etc/passwd" });
    expect(out).toBe("root:x:0:0");
  });

  it("export/import round-trip", () => {
    const h = makeHarness();
    h.importACLSnapshot({
      readAllows: ["/foo/*"],
      writeAllows: ["/tmp/*"],
      execAllows: ["git *"],
      readDenies: ["/secret/*"],
      writeDenies: [],
      execDenies: ["rm *"],
    });
    const snap = h.exportACLSnapshot();
    expect(snap).toEqual({
      readAllows: ["/foo/*"],
      writeAllows: ["/tmp/*"],
      execAllows: ["git *"],
      readDenies: ["/secret/*"],
      writeDenies: [],
      execDenies: ["rm *"],
    });
  });
});

describe("SandboxHarness — write + edit", () => {
  it("writeFile + readFile round-trip", async () => {
    const h = makeHarness({ read: ["/tmp/*"], write: ["/tmp/*"] });
    await h.ready;
    await h.writeFile({ path: "/tmp/x.txt", content: "hello" });
    const out = await h.readFile({ path: "/tmp/x.txt" });
    expect(out).toBe("hello");
  });

  it("editFile applies replace + reports counts", async () => {
    const h = makeHarness({ read: ["/tmp/*"], write: ["/tmp/*"] });
    await h.ready;
    await h.writeFile({ path: "/tmp/log.txt", content: "alpha\nbeta\ngamma" });
    const result = await h.editFile({
      path: "/tmp/log.txt",
      edits: [{ old: "beta", new: "BETA" }],
    });
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.content).toBe("alpha\nBETA\ngamma");
    expect(await h.readFile({ path: "/tmp/log.txt" })).toBe("alpha\nBETA\ngamma");
  });
});

describe("inMemorySandboxBridge", () => {
  it("registers and lists by id", async () => {
    const bridge = inMemorySandboxBridge();
    const h = makeHarness();
    await h.ready;
    bridge.register(h);
    expect(bridge.get("test-sb")).toBe(h);
    expect(bridge.list()).toEqual([{ id: "test-sb", workspacePath: "/tmp/h", status: "ready" }]);
  });

  it("subscribe fires on register/unregister", async () => {
    const bridge = inMemorySandboxBridge();
    const h = makeHarness();
    await h.ready;
    const listener = vi.fn();
    bridge.subscribe(listener);
    const unsub = bridge.register(h);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
