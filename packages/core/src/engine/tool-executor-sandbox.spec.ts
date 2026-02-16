/**
 * ToolExecutor — Sandbox Access Recovery Integration Tests
 *
 * Tests the full flow: tool throws SandboxAccessError → confirmation prompt →
 * user approves/denies → recover → retry → cleanup.
 */

import { describe, it, expect, vi } from "vitest";
import { ToolExecutor } from "./tool-executor";
import type { ExecutableTool, ToolCall } from "../tool/tool";
import { ToolExecutionType } from "../tool/tool";
import type { COM } from "../com/object-model";
import { createEngineProcedure } from "../procedure";
import type { ContentBlock } from "@agentick/shared";

/**
 * Duck-typed SandboxAccessError for testing.
 * Core detects sandbox errors via error.name === "SandboxAccessError",
 * not via instanceof. This mirrors the real class shape without importing sandbox.
 */
class SandboxAccessError extends Error {
  readonly name = "SandboxAccessError";
  recover?: (always: boolean) => Promise<(() => void) | void>;

  constructor(
    readonly requestedPath: string,
    readonly resolvedPath: string,
    readonly mode: "read" | "write",
  ) {
    super(`Path escapes sandbox: ${requestedPath} → ${resolvedPath}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeToolCall(name: string, input: Record<string, unknown> = {}): ToolCall {
  return {
    id: `call_${Math.random().toString(36).slice(2, 8)}`,
    name,
    input,
  };
}

function makeExecutableTool(
  name: string,
  handler: (input: any) => ContentBlock[] | Promise<ContentBlock[]>,
): ExecutableTool {
  const run = createEngineProcedure(handler, {
    type: "tool",
    id: name,
    operation: "run",
  });

  return {
    metadata: {
      name,
      description: `Test tool: ${name}`,
      input: { type: "object" },
      type: ToolExecutionType.SERVER,
    },
    run,
  } as ExecutableTool;
}

function makeMockCom(tools: Map<string, ExecutableTool>): COM {
  return {
    getTool: (name: string) => tools.get(name),
  } as COM;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ToolExecutor sandbox access recovery", () => {
  it("prompts confirmation on SandboxAccessError and retries on approval", async () => {
    let callCount = 0;
    const tool = makeExecutableTool("read_file", async () => {
      callCount++;
      if (callCount === 1) {
        const err = new SandboxAccessError("/secret/file.txt", "/real/secret/file.txt", "read");
        err.recover = vi.fn().mockResolvedValue(undefined);
        throw err;
      }
      return [{ type: "text", text: "file content" }];
    });

    const ctx = makeMockCom(new Map([["read_file", tool]]));
    const executor = new ToolExecutor();
    const call = makeToolCall("read_file", { path: "/secret/file.txt" });

    const onConfirmationRequired = vi.fn();
    const onConfirmationResult = vi.fn();

    // Resolve the sandbox-access confirmation asynchronously
    const resultPromise = executor.processToolWithConfirmation(call, ctx, [], {
      onConfirmationRequired,
      onConfirmationResult,
    });

    // Wait a tick for the confirmation to be registered
    await new Promise((r) => setTimeout(r, 10));

    // Verify confirmation was requested
    expect(onConfirmationRequired).toHaveBeenCalledOnce();
    const [, message, metadata] = onConfirmationRequired.mock.calls[0]!;
    expect(message).toContain("read_file");
    expect(message).toContain("/secret/file.txt");
    expect(message).toContain("outside sandbox");
    expect(metadata).toMatchObject({
      type: "sandbox_access",
      requestedPath: "/secret/file.txt",
      resolvedPath: "/real/secret/file.txt",
      mode: "read",
    });

    // Approve the confirmation
    const coordinator = executor.getConfirmationCoordinator();
    coordinator.resolveConfirmation(call.id, true, false);

    const { result } = await resultPromise;

    // Tool was retried and succeeded
    expect(result.success).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "file content" }]);
    expect(callCount).toBe(2);
    expect(onConfirmationResult).toHaveBeenCalledOnce();
  });

  it("returns denial result when user rejects sandbox access", async () => {
    const tool = makeExecutableTool("read_file", async () => {
      const err = new SandboxAccessError("/etc/passwd", "/etc/passwd", "read");
      err.recover = vi.fn();
      throw err;
    });

    const ctx = makeMockCom(new Map([["read_file", tool]]));
    const executor = new ToolExecutor();
    const call = makeToolCall("read_file", { path: "/etc/passwd" });

    const resultPromise = executor.processToolWithConfirmation(call, ctx, [], {
      onConfirmationRequired: vi.fn(),
    });

    await new Promise((r) => setTimeout(r, 10));

    // Deny the confirmation
    const coordinator = executor.getConfirmationCoordinator();
    coordinator.resolveConfirmation(call.id, false, false);

    const { result } = await resultPromise;

    // Got denial, not error
    expect(result.success).toBe(false);
    expect(result.error).toContain("denied");
  });

  it("calls recover(always=true) when user selects Always Allow", async () => {
    const recoverFn = vi.fn().mockResolvedValue(undefined);
    let callCount = 0;

    const tool = makeExecutableTool("read_file", async () => {
      callCount++;
      if (callCount === 1) {
        const err = new SandboxAccessError("/data/file.txt", "/real/data/file.txt", "read");
        err.recover = recoverFn;
        throw err;
      }
      return [{ type: "text", text: "data" }];
    });

    const ctx = makeMockCom(new Map([["read_file", tool]]));
    const executor = new ToolExecutor();
    const call = makeToolCall("read_file");

    const resultPromise = executor.processToolWithConfirmation(call, ctx, [], {
      onConfirmationRequired: vi.fn(),
    });

    await new Promise((r) => setTimeout(r, 10));

    // Always allow
    executor.getConfirmationCoordinator().resolveConfirmation(
      call.id,
      true,
      true, // always
    );

    const { result } = await resultPromise;

    expect(result.success).toBe(true);
    expect(recoverFn).toHaveBeenCalledWith(true);
  });

  it("calls recover(always=false) and cleanup on one-time approval", async () => {
    const cleanupFn = vi.fn();
    const recoverFn = vi.fn().mockResolvedValue(cleanupFn);
    let callCount = 0;

    const tool = makeExecutableTool("read_file", async () => {
      callCount++;
      if (callCount === 1) {
        const err = new SandboxAccessError("/tmp/file.txt", "/private/tmp/file.txt", "read");
        err.recover = recoverFn;
        throw err;
      }
      return [{ type: "text", text: "ok" }];
    });

    const ctx = makeMockCom(new Map([["read_file", tool]]));
    const executor = new ToolExecutor();
    const call = makeToolCall("read_file");

    const resultPromise = executor.processToolWithConfirmation(call, ctx, [], {
      onConfirmationRequired: vi.fn(),
    });

    await new Promise((r) => setTimeout(r, 10));

    // One-time approval (always=false)
    executor.getConfirmationCoordinator().resolveConfirmation(call.id, true, false);

    const { result } = await resultPromise;

    expect(result.success).toBe(true);
    expect(recoverFn).toHaveBeenCalledWith(false);
    // Cleanup was called after retry
    expect(cleanupFn).toHaveBeenCalledOnce();
  });

  it("cleanup runs even when retry fails", async () => {
    const cleanupFn = vi.fn();
    const recoverFn = vi.fn().mockResolvedValue(cleanupFn);

    const tool = makeExecutableTool("write_file", async () => {
      const err = new SandboxAccessError("/root/file", "/root/file", "write");
      err.recover = recoverFn;
      throw err;
    });

    const ctx = makeMockCom(new Map([["write_file", tool]]));
    const executor = new ToolExecutor();
    const call = makeToolCall("write_file");

    const resultPromise = executor.processToolWithConfirmation(call, ctx, [], {
      onConfirmationRequired: vi.fn(),
    });

    await new Promise((r) => setTimeout(r, 10));

    executor.getConfirmationCoordinator().resolveConfirmation(call.id, true, false);

    const { result } = await resultPromise;

    // Retry also threw SandboxAccessError — but this time processToolWithConfirmation
    // catches it in the retry error handler (not the sandbox recovery path)
    expect(result.success).toBe(false);
    // Cleanup still ran
    expect(cleanupFn).toHaveBeenCalledOnce();
  });

  it("does not trigger recovery for non-SandboxAccessError", async () => {
    const tool = makeExecutableTool("bad_tool", async () => {
      throw new Error("something else broke");
    });

    const ctx = makeMockCom(new Map([["bad_tool", tool]]));
    const executor = new ToolExecutor();
    const call = makeToolCall("bad_tool");

    const onConfirmationRequired = vi.fn();

    const { result } = await executor.processToolWithConfirmation(call, ctx, [], {
      onConfirmationRequired,
    });

    // No confirmation was requested
    expect(onConfirmationRequired).not.toHaveBeenCalled();
    // Got regular error result
    expect(result.success).toBe(false);
    expect(result.error).toContain("something else broke");
  });

  it("does not trigger recovery if recover function is missing", async () => {
    const tool = makeExecutableTool("read_file", async () => {
      // SandboxAccessError without recover function (shouldn't happen in practice,
      // but test defensive behavior)
      throw new SandboxAccessError("/etc/passwd", "/etc/passwd", "read");
    });

    const ctx = makeMockCom(new Map([["read_file", tool]]));
    const executor = new ToolExecutor();
    const call = makeToolCall("read_file");

    const onConfirmationRequired = vi.fn();

    const { result } = await executor.processToolWithConfirmation(call, ctx, [], {
      onConfirmationRequired,
    });

    // No confirmation — treated as regular error
    expect(onConfirmationRequired).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("sandbox recovery works after pre-execution confirmation approval", async () => {
    let callCount = 0;
    const tool = makeExecutableTool("write_file", async () => {
      callCount++;
      if (callCount === 1) {
        const err = new SandboxAccessError("/outside/file.txt", "/real/outside/file.txt", "write");
        err.recover = vi.fn().mockResolvedValue(undefined);
        throw err;
      }
      return [{ type: "text", text: "written" }];
    });

    // Tool requires pre-execution confirmation
    (tool.metadata as any).requiresConfirmation = true;
    (tool.metadata as any).confirmationMessage = "Allow write?";

    const ctx = makeMockCom(new Map([["write_file", tool]]));
    const executor = new ToolExecutor();
    const call = makeToolCall("write_file");

    const confirmations: string[] = [];
    const resultPromise = executor.processToolWithConfirmation(call, ctx, [], {
      onConfirmationRequired: vi.fn((_call, msg) => {
        confirmations.push(msg);
      }),
    });

    await new Promise((r) => setTimeout(r, 10));

    // First confirmation: pre-execution
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toBe("Allow write?");

    // Approve pre-execution confirmation
    executor.getConfirmationCoordinator().resolveConfirmation(call.id, true, false);

    await new Promise((r) => setTimeout(r, 10));

    // Second confirmation: sandbox access
    expect(confirmations).toHaveLength(2);
    expect(confirmations[1]).toContain("outside sandbox");

    // Approve sandbox access
    executor.getConfirmationCoordinator().resolveConfirmation(call.id, true, false);

    const { result } = await resultPromise;

    expect(result.success).toBe(true);
    expect(callCount).toBe(2);
  });

  it("AbortSignal cancels pending sandbox confirmation (end-to-end abort)", async () => {
    const tool = makeExecutableTool("read_file", async () => {
      const err = new SandboxAccessError("/secret/file.txt", "/real/secret/file.txt", "read");
      err.recover = vi.fn().mockResolvedValue(undefined);
      throw err;
    });

    const ctx = makeMockCom(new Map([["read_file", tool]]));
    const executor = new ToolExecutor();
    const call = makeToolCall("read_file");

    // Wire abort signal → cancelAll, mirroring session.ts executeTools
    const abortController = new AbortController();
    const coordinator = executor.getConfirmationCoordinator();
    abortController.signal.addEventListener("abort", () => coordinator.cancelAll());

    const resultPromise = executor.processToolWithConfirmation(call, ctx, [], {
      onConfirmationRequired: vi.fn(),
    });

    await new Promise((r) => setTimeout(r, 10));

    // Fire abort (simulates Ctrl+C / Esc)
    abortController.abort("user cancelled");

    // Should reject (not hang forever)
    await expect(resultPromise).rejects.toThrow("cancelled");
  });

  it("AbortSignal cancels pending pre-execution confirmation (end-to-end abort)", async () => {
    const tool = makeExecutableTool("write_file", async () => {
      return [{ type: "text", text: "written" }];
    });

    (tool.metadata as any).requiresConfirmation = true;
    (tool.metadata as any).confirmationMessage = "Allow write?";

    const ctx = makeMockCom(new Map([["write_file", tool]]));
    const executor = new ToolExecutor();
    const call = makeToolCall("write_file");

    // Wire abort signal → cancelAll, mirroring session.ts executeTools
    const abortController = new AbortController();
    const coordinator = executor.getConfirmationCoordinator();
    abortController.signal.addEventListener("abort", () => coordinator.cancelAll());

    const resultPromise = executor.processToolWithConfirmation(call, ctx, [], {
      onConfirmationRequired: vi.fn(),
    });

    await new Promise((r) => setTimeout(r, 10));

    // Fire abort (simulates Ctrl+C / Esc)
    abortController.abort("user cancelled");

    // Should reject (not hang forever)
    await expect(resultPromise).rejects.toThrow("cancelled");
  });
});
