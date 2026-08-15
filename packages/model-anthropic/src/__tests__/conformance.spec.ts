/**
 * Conformance suite invocation for `LanguageModelExecutor` + the
 * `anthropic()` adapter.
 *
 * Drives the universal `runExecutorConformance` from
 * `@agentick/spec-conformance`. The stub supplies BOTH non-streaming
 * and streaming canned responses derived from the suite's scripted
 * `LanguageModelExecutionResult` so the suite exercises both
 * `execute()` and `executeStream()` interchangeably.
 */

import { describe } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { runExecutorConformance } from "@agentick/spec-conformance";
import type { LanguageModelExecutionResult } from "@agentick/spec";
import type {
  Message as AnthropicMessage,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";

import { LanguageModelExecutor } from "@agentick/model-executor";

import { APIConnectionError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";

import { anthropic } from "../anthropic-adapter.js";
import { StubAnthropicClient, asClient, throwingClient } from "./stub-anthropic-client.js";

function messageFor(scripted: LanguageModelExecutionResult | undefined): AnthropicMessage {
  const text =
    scripted?.output
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("") ?? "hi";
  const toolBlocks =
    scripted?.output.filter(
      (
        b,
      ): b is {
        type: "tool_use";
        toolUseId: string;
        name: string;
        input: Record<string, unknown>;
      } => b.type === "tool_use",
    ) ?? [];
  const content: AnthropicMessage["content"] = [];
  if (text.length > 0) {
    content.push({ type: "text", text, citations: null } as AnthropicMessage["content"][number]);
  }
  for (const tb of toolBlocks) {
    content.push({
      type: "tool_use",
      id: tb.toolUseId,
      name: tb.name,
      input: tb.input,
    } as AnthropicMessage["content"][number]);
  }
  const stopReason: AnthropicMessage["stop_reason"] =
    scripted?.stopReason === "tool_use"
      ? "tool_use"
      : scripted?.stopReason === "max_tokens"
        ? "max_tokens"
        : scripted?.stopReason === "stop_sequence"
          ? "stop_sequence"
          : "end_turn";
  return {
    id: "msg_conformance",
    type: "message",
    role: "assistant",
    model: "claude-3-5-sonnet-latest",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: scripted?.usage?.inputTokens ?? 0,
      output_tokens: scripted?.usage?.outputTokens ?? 0,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    },
  } as AnthropicMessage;
}

function streamingEventsFor(
  scripted: LanguageModelExecutionResult | undefined,
): ReadonlyArray<RawMessageStreamEvent> {
  const text =
    scripted?.output
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("") ?? "hi";
  const stopReason: AnthropicMessage["stop_reason"] =
    scripted?.stopReason === "tool_use"
      ? "tool_use"
      : scripted?.stopReason === "max_tokens"
        ? "max_tokens"
        : "end_turn";
  return [
    {
      type: "message_start",
      message: {
        id: "msg_conformance_stream",
        type: "message",
        role: "assistant",
        model: "claude-3-5-sonnet-latest",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: scripted?.usage?.inputTokens ?? 0,
          output_tokens: 0,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      },
    } as RawMessageStreamEvent,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    } as RawMessageStreamEvent,
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    } as RawMessageStreamEvent,
    { type: "content_block_stop", index: 0 } as RawMessageStreamEvent,
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: scripted?.usage?.outputTokens ?? 0 },
    } as RawMessageStreamEvent,
    { type: "message_stop" } as RawMessageStreamEvent,
  ];
}

describe("anthropic() adapter — ExecutorProtocol conformance", () => {
  runExecutorConformance(
    async ({ harnessId, scripted, throws }) => {
      const stub = new StubAnthropicClient([
        { kind: "non-streaming", message: messageFor(scripted) },
        { kind: "streaming", events: streamingEventsFor(scripted) },
      ]);
      const journal = new MemoryJournal();
      const bus = new LocalEventBus();
      const inbox = new LocalInbox();
      const exec = new LanguageModelExecutor(harnessId, journal, bus, inbox, {
        adapter: anthropic("claude-3-5-sonnet-latest", {
          client: throws !== undefined ? throwingClient(throws) : asClient(stub),
        }),
      });
      await exec.ready;
      return { executor: exec, bus };
    },
    {
      ProviderRejected: [
        new APIError(
          429,
          { type: "error", error: { type: "rate_limit_error", message: "rate limited" } },
          undefined,
          undefined,
        ),
        new APIError(
          400,
          { type: "error", error: { type: "invalid_request_error", message: "bad request" } },
          undefined,
          undefined,
        ),
      ],
      ProviderAborted: [new APIUserAbortError()],
      StreamFailed: [new APIConnectionError({ message: "Connection error." })],
      // Anthropic publishes no error class or stop reason that positively names
      // malformed model output; its one occurrence, an unparseable
      // `input_json_delta` run, is caught generically at stream finalize.
      MalformedModelOutput: "not-applicable",
      // `APIConnectionTimeoutError` exists, but nothing classifies it yet —
      // TODO(provider-timeout): teach `defaultMapProviderError` to name it.
      ProviderTimeout: "not-applicable",
    },
  );
});
