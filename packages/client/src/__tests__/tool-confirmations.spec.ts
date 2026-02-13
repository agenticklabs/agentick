import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolConfirmations } from "../tool-confirmations";
import { createMockClient } from "../testing";

describe("ToolConfirmations", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  describe("initial state", () => {
    it("starts with no pending confirmation", () => {
      const tc = new ToolConfirmations(client, { sessionId: "s1" });
      expect(tc.pending).toBeNull();
      tc.destroy();
    });
  });

  describe("handling confirmations", () => {
    it("surfaces a confirmation when policy returns prompt", () => {
      const tc = new ToolConfirmations(client, { sessionId: "s1" });

      client._emitToolConfirmation("s1", {
        toolUseId: "tu-1",
        name: "write_file",
        arguments: { path: "/test.ts" },
      });

      expect(tc.pending).not.toBeNull();
      expect(tc.pending!.request.name).toBe("write_file");
      tc.destroy();
    });

    it("auto-approves when policy returns approve", () => {
      const respondFn = vi.fn();
      const tc = new ToolConfirmations(client, {
        sessionId: "s1",
        policy: () => ({ action: "approve" }),
      });

      client._emitToolConfirmation(
        "s1",
        { toolUseId: "tu-1", name: "read_file", arguments: { path: "/a.ts" } },
        respondFn,
      );

      expect(respondFn).toHaveBeenCalledWith({ approved: true });
      expect(tc.pending).toBeNull();
      tc.destroy();
    });

    it("auto-denies when policy returns deny", () => {
      const respondFn = vi.fn();
      const tc = new ToolConfirmations(client, {
        sessionId: "s1",
        policy: () => ({ action: "deny", reason: "forbidden" }),
      });

      client._emitToolConfirmation(
        "s1",
        { toolUseId: "tu-1", name: "shell", arguments: { cmd: "rm -rf /" } },
        respondFn,
      );

      expect(respondFn).toHaveBeenCalledWith({ approved: false, reason: "forbidden" });
      expect(tc.pending).toBeNull();
      tc.destroy();
    });

    it("selective policy: approve reads, prompt writes", () => {
      const tc = new ToolConfirmations(client, {
        sessionId: "s1",
        policy: (req) =>
          ["read_file", "glob", "grep"].includes(req.name)
            ? { action: "approve" }
            : { action: "prompt" },
      });

      const respondRead = vi.fn();
      client._emitToolConfirmation(
        "s1",
        { toolUseId: "tu-1", name: "read_file", arguments: {} },
        respondRead,
      );
      expect(respondRead).toHaveBeenCalledWith({ approved: true });
      expect(tc.pending).toBeNull();

      client._emitToolConfirmation("s1", {
        toolUseId: "tu-2",
        name: "write_file",
        arguments: {},
      });
      expect(tc.pending).not.toBeNull();
      expect(tc.pending!.request.name).toBe("write_file");

      tc.destroy();
    });

    it("auto-denies stale pending when a new confirmation arrives", () => {
      const tc = new ToolConfirmations(client, { sessionId: "s1" });
      const respondFn1 = vi.fn();
      const respondFn2 = vi.fn();

      client._emitToolConfirmation(
        "s1",
        { toolUseId: "tu-1", name: "write_file", arguments: {} },
        respondFn1,
      );
      expect(tc.pending!.request.toolUseId).toBe("tu-1");

      // Second confirmation arrives before first is resolved
      client._emitToolConfirmation(
        "s1",
        { toolUseId: "tu-2", name: "shell", arguments: {} },
        respondFn2,
      );

      // First was auto-denied
      expect(respondFn1).toHaveBeenCalledWith({
        approved: false,
        reason: "Superseded by new confirmation",
      });

      // Second is now pending
      expect(tc.pending!.request.toolUseId).toBe("tu-2");
      expect(respondFn2).not.toHaveBeenCalled();

      tc.destroy();
    });
  });

  describe("respond", () => {
    it("calls the respond function and clears pending", () => {
      const respondFn = vi.fn();
      const tc = new ToolConfirmations(client, { sessionId: "s1" });

      client._emitToolConfirmation(
        "s1",
        { toolUseId: "tu-1", name: "shell", arguments: { cmd: "ls" } },
        respondFn,
      );
      expect(tc.pending).not.toBeNull();

      tc.respond({ approved: true });

      expect(respondFn).toHaveBeenCalledWith({ approved: true });
      expect(tc.pending).toBeNull();
      tc.destroy();
    });

    it("is a no-op without pending confirmation", () => {
      const tc = new ToolConfirmations(client, { sessionId: "s1" });
      const listener = vi.fn();
      tc.onStateChange(listener);

      tc.respond({ approved: true });

      expect(listener).not.toHaveBeenCalled();
      tc.destroy();
    });
  });

  describe("subscribe: false (externally driven)", () => {
    it("does not self-subscribe", () => {
      const tc = new ToolConfirmations(client, { sessionId: "s1", subscribe: false });

      client._emitToolConfirmation("s1", {
        toolUseId: "tu-1",
        name: "shell",
        arguments: {},
      });

      expect(tc.pending).toBeNull();
      tc.destroy();
    });

    it("processes via handleConfirmation() when externally driven", () => {
      const tc = new ToolConfirmations(client, { sessionId: "s1", subscribe: false });
      const respondFn = vi.fn();

      tc.handleConfirmation({ toolUseId: "tu-1", name: "shell", arguments: {} }, respondFn);

      expect(tc.pending).not.toBeNull();
      expect(tc.pending!.request.name).toBe("shell");
      tc.destroy();
    });
  });

  describe("snapshot / subscription", () => {
    it("notifies listeners on state change", () => {
      const tc = new ToolConfirmations(client, { sessionId: "s1" });
      const listener = vi.fn();
      tc.onStateChange(listener);

      client._emitToolConfirmation("s1", {
        toolUseId: "tu-1",
        name: "shell",
        arguments: {},
      });

      expect(listener).toHaveBeenCalledTimes(1);
      tc.destroy();
    });

    it("unsubscribe stops notifications", () => {
      const tc = new ToolConfirmations(client, { sessionId: "s1" });
      const listener = vi.fn();
      const unsub = tc.onStateChange(listener);

      unsub();

      client._emitToolConfirmation("s1", {
        toolUseId: "tu-1",
        name: "shell",
        arguments: {},
      });

      expect(listener).not.toHaveBeenCalled();
      tc.destroy();
    });
  });

  describe("destroy", () => {
    it("cleans up subscriptions", () => {
      const tc = new ToolConfirmations(client, { sessionId: "s1" });
      const listener = vi.fn();
      tc.onStateChange(listener);

      tc.destroy();

      client._emitToolConfirmation("s1", {
        toolUseId: "tu-1",
        name: "shell",
        arguments: {},
      });

      expect(listener).not.toHaveBeenCalled();
    });

    it("double destroy is safe", () => {
      const tc = new ToolConfirmations(client, { sessionId: "s1" });
      tc.destroy();
      expect(() => tc.destroy()).not.toThrow();
    });
  });
});
