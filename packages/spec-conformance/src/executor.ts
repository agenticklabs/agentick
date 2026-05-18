/**
 * Conformance suite for `LanguageModelExecutor` implementations.
 *
 * Validates the invariants in `docs/proposals/v2/blueprint/06-executor-harness.md`.
 *
 * Run from any vitest test file:
 *
 * ```ts
 * import { describe } from "vitest";
 * import { runExecutorConformance } from "@agentick/spec-conformance";
 * import { MockLanguageModelExecutor } from "@agentick/executor";
 *
 * describe("MockLanguageModelExecutor", () =>
 *   runExecutorConformance(({ harnessId }) =>
 *     new MockLanguageModelExecutor(harnessId, ...)
 *   )
 * );
 * ```
 */

import { describe, expect, it } from "vitest";

import type {
  LanguageModelExecutionResult,
  LanguageModelExecutor,
  LanguageModelTarget,
  RenderedTree,
  SectionEntry,
} from "@agentick/spec";

// ============================================================================
// Factory contract
// ============================================================================

export interface ExecutorConformanceFactoryInput {
  readonly harnessId: string;
  readonly scripted?: LanguageModelExecutionResult;
}

export type ExecutorConformanceFactory =
  (input: ExecutorConformanceFactoryInput) => Promise<LanguageModelExecutor>;

// ============================================================================
// Fixtures
// ============================================================================

const SPEC_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function mkRenderedTree(): RenderedTree {
  const section: SectionEntry = {
    kind: "section",
    id: "system",
    content: [{ type: "text", text: "You are a helpful assistant." }],
  };
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [
        section,
        {
          kind: "message",
          id: "m_1",
          role: "user",
          content: [{ type: "text", text: "Say hi." }],
        },
      ],
    },
  };
}

function mkTarget(): LanguageModelTarget {
  return {
    kind: "language-model",
    provider: "mock",
    modelId: "mock-v1",
    capabilities: {
      supportsTools: true,
      supportsStreaming: true,
      contextWindow: 8192,
      maxOutputTokens: 1024,
    },
  };
}

function mkScripted(text = "hi"): LanguageModelExecutionResult {
  return {
    specVersion: "2026-05-08",
    output: [{ type: "text", text }],
    stopReason: "end",
    usage: { inputTokens: 8, outputTokens: 1, totalTokens: 9 },
  };
}

// ============================================================================
// Suite
// ============================================================================

export function runExecutorConformance(
  factory: ExecutorConformanceFactory,
): void {
  describe("ExecutorProtocol — project phase", () => {
    it("projects a RenderedTree into a target-shaped input", async () => {
      const executor = await factory({ harnessId: "ex-project-1" });
      const input = await executor.project({
        compiled: mkRenderedTree(),
        target: mkTarget(),
      });
      expect(input).toBeDefined();
      const messages = (input as { messages?: ReadonlyArray<unknown> }).messages;
      expect(Array.isArray(messages)).toBe(true);
      expect((messages as ReadonlyArray<unknown>).length).toBeGreaterThan(0);
    });

    it("project is deterministic for the same inputs", async () => {
      const executor = await factory({ harnessId: "ex-project-2" });
      const tree = mkRenderedTree();
      const target = mkTarget();
      const a = await executor.project({ compiled: tree, target });
      const b = await executor.project({ compiled: tree, target });
      expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    });
  });

  describe("ExecutorProtocol — run convenience", () => {
    it("returns ExecutorTerminal{outcome: 'succeeded'} on the happy path", async () => {
      const scripted = mkScripted("hello");
      const executor = await factory({ harnessId: "ex-run-1", scripted });
      const terminal = await executor.run({
        compiled: mkRenderedTree(),
        target: mkTarget(),
      });
      expect(terminal.outcome).toBe("succeeded");
      if (terminal.outcome === "succeeded") {
        expect(terminal.result.specVersion).toMatch(SPEC_VERSION_PATTERN);
        expect(terminal.result.output).toBeDefined();
        expect(terminal.result.stopReason).toBeDefined();
      }
    });

    it("succeeded result.output is an array of content blocks", async () => {
      const executor = await factory({ harnessId: "ex-run-2", scripted: mkScripted() });
      const terminal = await executor.run({
        compiled: mkRenderedTree(),
        target: mkTarget(),
      });
      if (terminal.outcome !== "succeeded") throw new Error("expected success");
      expect(Array.isArray(terminal.result.output)).toBe(true);
      for (const block of terminal.result.output) {
        expect(typeof block.type).toBe("string");
      }
    });
  });

  describe("ExecutorProtocol — abort", () => {
    it("abort with an unknown executionId is a no-op", async () => {
      const executor = await factory({ harnessId: "ex-abort-1" });
      await expect(
        executor.abort({ executionId: "no-such-execution" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("ExecutorProtocol — phase isolation", () => {
    it("normalize on prior-execute output produces the same ExecutionResult as run", async () => {
      const scripted = mkScripted("phase-iso");
      const executor = await factory({ harnessId: "ex-iso-1", scripted });
      const tree = mkRenderedTree();
      const target = mkTarget();

      const projected = await executor.project({ compiled: tree, target });
      const executed = await executor.execute({ targetInput: projected, target });
      const normalized = await executor.normalize({ targetOutput: executed, target });

      const terminal = await executor.run({ compiled: tree, target });
      if (terminal.outcome !== "succeeded") throw new Error("expected success");

      const phaseText = normalized.output
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      const runText = terminal.result.output
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      expect(phaseText).toEqual(runText);
    });
  });
}
