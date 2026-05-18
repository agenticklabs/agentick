/**
 * Conformance suite invocation for `OpenAIExecutor`.
 *
 * The factory installs a stubbed OpenAI client that returns canned
 * ChatCompletion payloads matching the scripted
 * `LanguageModelExecutionResult` the suite expects. The same protocol
 * checks pass against `MockLanguageModelExecutor` (in `@agentick/executor`).
 */

import { describe } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { runExecutorConformance } from "@agentick/spec-conformance";
import type { LanguageModelExecutionResult } from "@agentick/spec";
import type { ChatCompletion } from "openai/resources/chat/completions";

import { OpenAIExecutor } from "../openai-executor.js";
import { StubOpenAIClient, asClient } from "./stub-openai-client.js";

/**
 * Reverse-engineer a `ChatCompletion` from the scripted
 * `LanguageModelExecutionResult` so the stub client's canned response
 * normalizes back to an equivalent result.
 */
function completionFor(
  scripted: LanguageModelExecutionResult | undefined,
): ChatCompletion {
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
  const toolCalls = toolBlocks?.map((b) => ({
    id: b.toolUseId,
    type: "function" as const,
    function: { name: b.name, arguments: JSON.stringify(b.input) },
  }));
  const finishReason =
    scripted?.stopReason === "tool_use"
      ? ("tool_calls" as const)
      : scripted?.stopReason === "max_tokens"
        ? ("length" as const)
        : ("stop" as const);
  return {
    id: "chatcmpl-conformance",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text.length > 0 ? text : null,
          refusal: null,
          ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: scripted?.usage?.inputTokens ?? 0,
      completion_tokens: scripted?.usage?.outputTokens ?? 0,
      total_tokens: scripted?.usage?.totalTokens ?? 0,
    },
  } as ChatCompletion;
}

describe("OpenAIExecutor — ExecutorProtocol conformance", () =>
  runExecutorConformance(async ({ harnessId, scripted }) => {
    const completion = completionFor(scripted);
    // The suite calls project/run/normalize/abort in some order — provide
    // enough canned responses for the full sequence. The stub clamps to
    // the last entry, so a single repeating completion is sufficient.
    const stub = new StubOpenAIClient([
      { kind: "non-streaming", completion },
    ]);
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const exec = new OpenAIExecutor(harnessId, journal, bus, inbox, {
      client: asClient(stub),
      model: "gpt-4o-mini",
    });
    await exec.ready;
    return exec;
  }));
