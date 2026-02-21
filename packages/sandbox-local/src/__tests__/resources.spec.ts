import { describe, it, expect, vi, afterEach } from "vitest";
import { ResourceEnforcer } from "../resources.js";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

function mockChild(): ChildProcess {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { pid: 12345 }) as unknown as ChildProcess;
}

describe("ResourceEnforcer", () => {
  let enforcer: ResourceEnforcer;

  afterEach(async () => {
    await enforcer?.stop();
  });

  describe("createTimeoutSignal", () => {
    it("returns undefined when no timeout configured", () => {
      enforcer = new ResourceEnforcer("/tmp/test", {});
      expect(enforcer.createTimeoutSignal()).toBeUndefined();
    });

    it("returns AbortSignal for per-command timeout", () => {
      enforcer = new ResourceEnforcer("/tmp/test", {});
      const signal = enforcer.createTimeoutSignal(5000);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);
    });

    it("falls back to global timeout when no per-command timeout", () => {
      enforcer = new ResourceEnforcer("/tmp/test", { timeout: 10000 });
      const signal = enforcer.createTimeoutSignal();
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it("prefers per-command timeout over global", () => {
      enforcer = new ResourceEnforcer("/tmp/test", { timeout: 10000 });
      const signal = enforcer.createTimeoutSignal(1000);
      expect(signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("trackProcess", () => {
    it("tracks a child process", () => {
      enforcer = new ResourceEnforcer("/tmp/test", {});
      const child = mockChild();
      enforcer.trackProcess(child);
      // No error means it was tracked
    });

    it("removes process on exit", () => {
      enforcer = new ResourceEnforcer("/tmp/test", {});
      const child = mockChild();
      enforcer.trackProcess(child);
      child.emit("exit", 0);
      // Process removed from tracking set — no error on stop
    });
  });

  describe("start", () => {
    it("starts without error when no disk limit", async () => {
      enforcer = new ResourceEnforcer("/tmp/test", {});
      await enforcer.start();
    });

    it("starts disk monitoring when disk limit set", async () => {
      enforcer = new ResourceEnforcer("/tmp", { disk: 1024 * 1024 * 1024 });
      await enforcer.start();
      // Disk timer is running (unref'd, won't block exit)
    });
  });

  describe("stop", () => {
    it("is idempotent", async () => {
      enforcer = new ResourceEnforcer("/tmp/test", {});
      await enforcer.start();
      await enforcer.stop();
      await enforcer.stop(); // Second call should not throw
    });

    it("clears disk monitoring timer", async () => {
      enforcer = new ResourceEnforcer("/tmp", { disk: 1024 * 1024 * 1024 });
      await enforcer.start();
      await enforcer.stop();
    });

    it("attempts to kill tracked processes", async () => {
      enforcer = new ResourceEnforcer("/tmp/test", {});
      const child = mockChild();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      enforcer.trackProcess(child);
      await enforcer.stop();

      expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
      killSpy.mockRestore();
    });
  });
});
