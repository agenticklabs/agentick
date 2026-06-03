/**
 * Conformance suite invocation for `GoogleExecutor`.
 *
 * Drives the universal `runExecutorConformance` from
 * `@agentick/spec-conformance`. The stub supplies both non-streaming
 * and streaming canned responses derived from the suite's scripted
 * `LanguageModelExecutionResult`.
 */

import { describe } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { runExecutorConformance } from "@agentick/spec-conformance";
import type { LanguageModelExecutionResult } from "@agentick/spec";
import type { GenerateContentResponse } from "@google/genai";

import { GoogleExecutor } from "../google-executor.js";
import {
  StubGoogleClient,
  asClient,
  mkResponse,
} from "./stub-google-client.js";

function responseFor(
  scripted: LanguageModelExecutionResult | undefined,
): GenerateContentResponse {
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

  // Map normalized stop reasons to Google finishReason strings.
  const finishReason =
    scripted?.stopReason === "max_tokens"
      ? "MAX_TOKENS"
      : scripted?.stopReason === "stop_sequence"
        ? "STOP"
        : scripted?.stopReason === "content_filter"
          ? "SAFETY"
          : "STOP";

  return mkResponse({
    text: text.length > 0 ? text : undefined,
    toolCalls: toolBlocks.map((b) => ({
      id: b.toolUseId,
      name: b.name,
      args: b.input,
    })),
    finishReason,
    usage: {
      promptTokenCount: scripted?.usage?.inputTokens ?? 0,
      candidatesTokenCount: scripted?.usage?.outputTokens ?? 0,
    },
  });
}

function streamingChunksFor(
  scripted: LanguageModelExecutionResult | undefined,
): ReadonlyArray<GenerateContentResponse> {
  const response = responseFor(scripted);
  // Google's streaming can deliver everything in one chunk — the parts
  // array is just the full response's parts arriving together. Splitting
  // is realistic but not required by the protocol.
  return [response];
}

describe("GoogleExecutor — ExecutorProtocol conformance", () =>
  runExecutorConformance(async ({ harnessId, scripted }) => {
    const stub = new StubGoogleClient([
      { kind: "non-streaming", response: responseFor(scripted) },
      { kind: "streaming", chunks: streamingChunksFor(scripted) },
    ]);
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const exec = new GoogleExecutor(harnessId, journal, bus, inbox, {
      client: asClient(stub),
      model: "gemini-2.5-flash",
    });
    await exec.ready;
    return { executor: exec, bus };
  }));
