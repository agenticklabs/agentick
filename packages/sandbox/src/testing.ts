/**
 * Sandbox Testing Utilities
 *
 * Mock implementations for testing sandbox consumers and provider adapters.
 */

import { vi } from "vitest";
import type { Sandbox, SandboxProvider, ExecResult } from "./types";
import type { EditResult } from "./edit";

/**
 * Create a mock Sandbox with vi.fn() stubs and sensible defaults.
 *
 * @example
 * ```typescript
 * const sandbox = createMockSandbox({
 *   exec: vi.fn().mockResolvedValue({ stdout: "hello", stderr: "", exitCode: 0 }),
 * });
 * ```
 */
export function createMockSandbox(overrides?: Partial<Sandbox>): Sandbox {
  const defaultExecResult: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
  const defaultEditResult: EditResult = { content: "", applied: 0, changes: [] };

  return {
    id: "mock-sandbox-1",
    workspacePath: "/tmp/mock-sandbox",
    exec: vi.fn().mockResolvedValue(defaultExecResult),
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined),
    editFile: vi.fn().mockResolvedValue(defaultEditResult),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Create a mock SandboxProvider whose create() returns a mock sandbox.
 *
 * @example
 * ```typescript
 * const provider = createMockProvider();
 * const sandbox = await provider.create({});
 * expect(sandbox.id).toBe("mock-sandbox-1");
 * ```
 */
export function createMockProvider(overrides?: Partial<SandboxProvider>): SandboxProvider {
  const mockSandbox = createMockSandbox();

  return {
    name: "mock",
    create: vi.fn().mockResolvedValue(mockSandbox),
    ...overrides,
  };
}
