/**
 * Conformance suite invocation for `LanguageModelExecutor` + the
 * `google()` adapter.
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

import { LanguageModelExecutor } from "@agentick/model-executor";

import { google } from "../google-adapter.js";
import { StubGoogleClient, asClient, mkResponse, throwingClient } from "../testing/index.js";

function responseFor(scripted: LanguageModelExecutionResult | undefined): GenerateContentResponse {
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

/** Verbatim from a live Vertex 400 — doubly serialized, exactly as the SDK hands it over. */
const NESTED_400 =
  '{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 400,\\n    \\"message\\": ' +
  '\\"Request contains an invalid argument.\\",\\n    \\"status\\": \\"INVALID_ARGUMENT\\"\\n  }\\n}\\n",' +
  '"code":400,"status":"Bad Request"}}';

describe("google() adapter — ExecutorProtocol conformance", () => {
  runExecutorConformance(
    async ({ harnessId, scripted, throws }) => {
      const stub = new StubGoogleClient([
        { kind: "non-streaming", response: responseFor(scripted) },
        { kind: "streaming", chunks: streamingChunksFor(scripted) },
      ]);
      const journal = new MemoryJournal();
      const bus = new LocalEventBus();
      const inbox = new LocalInbox();
      const exec = new LanguageModelExecutor(harnessId, journal, bus, inbox, {
        adapter: google("gemini-2.5-flash", {
          client: throws !== undefined ? throwingClient(throws) : asClient(stub),
        }),
      });
      await exec.ready;
      return { executor: exec, bus };
    },
    {
      ProviderRejected: [new Error(NESTED_400)],
      // `@google/genai` calls `fetch`, which rejects an aborted request with
      // exactly this DOMException.
      ProviderAborted: [new DOMException("This operation was aborted", "AbortError")],
      StreamFailed: [new Error("socket hang up")],
      // Gemini reports malformed tool calls as a FINISH REASON on an otherwise
      // successful response, so no thrown fixture can express it — see
      // `malformed-tool-call.spec.ts`.
      MalformedModelOutput: "not-applicable",
      ProviderTimeout: "not-applicable",
    },
  );
});
