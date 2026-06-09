/**
 * Conformance suite invocation for `OpenAIExecutor`.
 *
 * The factory installs a stubbed OpenAI client that returns canned
 * ChatCompletion payloads matching the scripted
 * `LanguageModelExecutionResult` the suite expects. The same protocol
 * checks pass against `MockLanguageModelExecutor` (in `@agentick/executor-next`).
 */

import { describe } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import { runExecutorConformance } from "@agentick/spec-conformance-next";
import type { LanguageModelExecutionResult } from "@agentick/spec-next";
import type {
  ChatCompletion,
  ChatCompletionChunk,
} from "openai/resources/chat/completions";

import { OpenAIExecutor } from "../openai-executor.js";
import { StubOpenAIClient, asClient } from "./stub-openai-client.js";

/**
 * Reverse-engineer a `ChatCompletion` from the scripted
 * `LanguageModelExecutionResult` so the stub client's canned response
 * normalizes back to an equivalent result.
 */
function completionFor(scripted: LanguageModelExecutionResult | undefined): ChatCompletion {
  const text =
    scripted?.output
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("") ?? "hi";
  const toolBlocks = scripted?.output.filter(
    (
      b,
    ): b is {
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

/**
 * Translate a scripted result into a sequence of `ChatCompletionChunk`s
 * for the executeStream conformance tests. Drives content via a single
 * delta chunk + finish chunk; the parity suite only asserts SHAPE +
 * RESULT EQUIVALENCE, not chunk-level timing.
 */
function streamingChunksFor(
  scripted: LanguageModelExecutionResult | undefined,
): ReadonlyArray<ChatCompletionChunk> {
  const text =
    scripted?.output
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("") ?? "hi";
  return [
    {
      id: "chatcmpl-stream-1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
          logprobs: null,
        },
      ],
    } as ChatCompletionChunk,
    {
      id: "chatcmpl-stream-1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: scripted?.usage?.inputTokens ?? 0,
        completion_tokens: scripted?.usage?.outputTokens ?? 0,
        total_tokens: scripted?.usage?.totalTokens ?? 0,
      },
    } as ChatCompletionChunk,
  ];
}

describe("OpenAIExecutor — ExecutorProtocol conformance", () =>
  runExecutorConformance(async ({ harnessId, scripted }) => {
    const completion = completionFor(scripted);
    const chunks = streamingChunksFor(scripted);
    // Stub clamps to the last entry — supplying both shapes lets the
    // suite exercise execute() (non-streaming) and executeStream()
    // (streaming) interchangeably across tests.
    const stub = new StubOpenAIClient([
      { kind: "non-streaming", completion },
      { kind: "streaming", chunks },
    ]);
    // Round-robin via a small extension — each call picks the matching
    // shape. The existing stub returns clamped-to-last; emit a custom
    // wrapper that returns the appropriate canned response by stream
    // param.
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const exec = new OpenAIExecutor(harnessId, journal, bus, inbox, {
      client: asClient(stub),
      model: "gpt-4o-mini",
    });
    await exec.ready;
    return { executor: exec, bus };
  }));
