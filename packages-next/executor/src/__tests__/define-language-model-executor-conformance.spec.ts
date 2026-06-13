/**
 * Conformance suite invocation for `defineLanguageModelExecutor`.
 *
 * Runs the full 15-test executor protocol contract against the callback
 * wrapper to confirm it's equivalent to subclassing
 * `BaseLanguageModelExecutor` directly. The scripted
 * `LanguageModelExecutionResult` is treated as the raw response shape —
 * `openStream` yields synthetic chunks derived from it, `mapChunk`
 * translates them to AdapterDeltas, `reconstructRaw` returns the same
 * scripted result, and `normalizeRaw` is identity.
 *
 * If this suite passes, adopters using the callback wrapper get the
 * full conformance guarantees of the class-based path.
 */

import { describe } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type {
  AdapterDelta,
  ExecutionTarget,
  LanguageModelExecutionResult,
} from "@agentick/spec-next";
import { runExecutorConformance } from "@agentick/spec-conformance-next";

import { defineLanguageModelExecutor } from "../define-language-model-executor.js";
import type { StreamAccumulator } from "../stream-accumulator.js";

// ============================================================================
// Synthetic chunk shape
// ============================================================================

type SyntheticChunk =
  | { kind: "text"; blockIndex: number; text: string }
  | {
      kind: "toolCall";
      callId: string;
      name: string;
      input: Readonly<Record<string, unknown>>;
      blockIndex: number;
    }
  | { kind: "finish"; result: LanguageModelExecutionResult };

const DEFAULT_TARGET: ExecutionTarget = {
  kind: "language-model",
  provider: "callback-conformance",
  modelId: "v1",
  capabilities: { supportsTools: true, supportsStreaming: true },
};

const DEFAULT_SCRIPTED: LanguageModelExecutionResult = {
  specVersion: "2026-05-08",
  output: [{ type: "text", text: "default reply" }],
  stopReason: "end",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

function chunksForScripted(scripted: LanguageModelExecutionResult): readonly SyntheticChunk[] {
  const out: SyntheticChunk[] = [];
  let blockIndex = 0;
  for (const block of scripted.output) {
    if (block.type === "text") {
      out.push({ kind: "text", blockIndex, text: block.text });
      blockIndex++;
    } else if (block.type === "tool_use") {
      out.push({
        kind: "toolCall",
        callId: block.toolUseId,
        name: block.name,
        input: block.input as Readonly<Record<string, unknown>>,
        blockIndex,
      });
      blockIndex++;
    }
  }
  out.push({ kind: "finish", result: scripted });
  return out;
}

function factoryFor(scripted: LanguageModelExecutionResult | undefined) {
  const effective = scripted ?? DEFAULT_SCRIPTED;
  return defineLanguageModelExecutor<LanguageModelExecutionResult, SyntheticChunk>({
    target: DEFAULT_TARGET,
    streamByDefault: true,
    buildParams: () => ({}),
    callProvider: () => Promise.resolve(effective),
    openStream: async function* (): AsyncIterable<SyntheticChunk> {
      for (const chunk of chunksForScripted(effective)) yield chunk;
    },
    mapChunk(chunk: SyntheticChunk, _accum: StreamAccumulator): readonly AdapterDelta[] {
      switch (chunk.kind) {
        case "text":
          return [
            { type: "content-start", blockIndex: chunk.blockIndex, blockType: "text" },
            { type: "content-delta", blockIndex: chunk.blockIndex, delta: chunk.text },
            { type: "content-end", blockIndex: chunk.blockIndex },
            {
              type: "content",
              blockIndex: chunk.blockIndex,
              content: { type: "text", text: chunk.text },
            },
          ];
        case "toolCall":
          return [
            {
              type: "tool-call-start",
              callId: chunk.callId,
              name: chunk.name,
              blockIndex: chunk.blockIndex,
            },
            {
              type: "tool-call-delta",
              callId: chunk.callId,
              delta: JSON.stringify(chunk.input),
            },
            { type: "tool-call-end", callId: chunk.callId },
            {
              type: "tool-call",
              callId: chunk.callId,
              name: chunk.name,
              input: chunk.input,
            },
          ];
        case "finish":
          return [
            {
              type: "message-end",
              stopReason: chunk.result.stopReason,
              usage: chunk.result.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            },
          ];
      }
    },
    reconstructRaw: () => effective,
    normalizeRaw: (raw) => raw,
  });
}

describe("defineLanguageModelExecutor — ExecutorProtocol conformance", () => {
  runExecutorConformance(async ({ harnessId, scripted }) => {
    const journal = new MemoryJournal();
    const bus = new LocalEventBus();
    const inbox = new LocalInbox();
    const factory = factoryFor(scripted);
    const exec = factory({ scopeId: harnessId, journal, bus, inbox });
    await exec.ready;
    return { executor: exec, bus };
  });
});
