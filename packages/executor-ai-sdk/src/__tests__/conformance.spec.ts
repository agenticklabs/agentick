/**
 * Conformance suite invocation for `AISDKExecutor`.
 *
 * The factory builds a `MockLanguageModelV2` configured to return a
 * canned `doGenerate` response matching the suite's scripted
 * `LanguageModelExecutionResult`. The same protocol invariants the
 * mock + OpenAI executors satisfy must hold here too — proving the
 * bridge is a true `LanguageModelExecutor` and not a special case.
 */

import { describe } from "vitest";

import { MockLanguageModelV2 } from "ai/test";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { runExecutorConformance } from "@agentick/spec-conformance";
import type { LanguageModelExecutionResult } from "@agentick/spec";

import { AISDKExecutor } from "../ai-sdk-executor.js";

/**
 * Reverse-engineer a MockLanguageModelV2 from the scripted result so
 * the bridge normalizes back to an equivalent shape.
 */
function modelFor(scripted: LanguageModelExecutionResult | undefined): MockLanguageModelV2 {
  const text =
    scripted?.output
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("") ?? "hi";
  const toolBlocks = scripted?.output.filter(
    (b): b is {
      type: "tool_use";
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
    } => b.type === "tool_use",
  );
  const toolCalls = (toolBlocks ?? []).map((b) => ({
    type: "tool-call" as const,
    toolCallId: b.toolUseId,
    toolName: b.name,
    input: JSON.stringify(b.input),
  }));
  const finishReason =
    scripted?.stopReason === "tool_use"
      ? ("tool-calls" as const)
      : scripted?.stopReason === "max_tokens"
        ? ("length" as const)
        : ("stop" as const);

  return new MockLanguageModelV2({
    provider: "mock-aisdk",
    modelId: "mock-1",
    doGenerate: async () => ({
      content:
        toolCalls.length > 0
          ? toolCalls
          : ([{ type: "text", text }] as const),
      finishReason,
      usage: {
        inputTokens: scripted?.usage?.inputTokens ?? 0,
        outputTokens: scripted?.usage?.outputTokens ?? 0,
        totalTokens: scripted?.usage?.totalTokens ?? 0,
      },
      warnings: [],
    }),
  });
}

describe("AISDKExecutor — ExecutorProtocol conformance", () =>
  runExecutorConformance(async ({ harnessId, scripted }) => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const exec = new AISDKExecutor(harnessId, journal, bus, inbox, {
      model: modelFor(scripted),
    });
    await exec.ready;
    return exec;
  }));
