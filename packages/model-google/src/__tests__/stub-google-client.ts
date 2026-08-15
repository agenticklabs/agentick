/**
 * Test-only stub for `GoogleGenAI` client.
 *
 * The `google()` adapter consumes only `client.models.generateContent()` and
 * `client.models.generateContentStream()`. The stub records every call
 * (params) and pulls the next matching canned response from its
 * sequence — `non-streaming` matches `generateContent`, `streaming`
 * matches `generateContentStream`.
 */

import { omitUndefined } from "@agentick/utils";

import type {
  GoogleGenAI,
  GenerateContentParameters,
  GenerateContentResponse,
} from "@google/genai";
import type {
  ExecutionTarget,
  LanguageModelTarget,
  ProviderOptions,
  RenderedTree,
} from "@agentick/spec";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { LanguageModelExecutor } from "@agentick/model-executor";

import { google } from "../google-adapter.js";

export type CannedResponse =
  | { readonly kind: "non-streaming"; readonly response: GenerateContentResponse }
  | {
      readonly kind: "streaming";
      readonly chunks: ReadonlyArray<GenerateContentResponse>;
    };

export interface RecordedCall {
  readonly params: GenerateContentParameters;
  readonly streaming: boolean;
}

export class StubGoogleClient {
  readonly calls: RecordedCall[] = [];
  private readonly consumed = new Set<number>();

  constructor(private readonly sequence: ReadonlyArray<CannedResponse>) {}

  readonly models = {
    generateContent: (params: GenerateContentParameters): Promise<GenerateContentResponse> => {
      this.calls.push({ params, streaming: false });
      const picked = this.pick(false);
      if (picked.kind !== "non-streaming") {
        return Promise.reject(new Error("StubGoogleClient: expected non-streaming response"));
      }
      return Promise.resolve(picked.response);
    },
    generateContentStream: (
      params: GenerateContentParameters,
    ): Promise<AsyncIterable<GenerateContentResponse>> => {
      this.calls.push({ params, streaming: true });
      const picked = this.pick(true);
      if (picked.kind !== "streaming") {
        return Promise.reject(new Error("StubGoogleClient: expected streaming response"));
      }
      return Promise.resolve(iterableFrom(picked.chunks));
    },
  };

  private pick(wantStream: boolean): CannedResponse {
    let firstMatch = -1;
    for (let i = 0; i < this.sequence.length; i++) {
      const entry = this.sequence[i]!;
      const matches =
        (wantStream && entry.kind === "streaming") ||
        (!wantStream && entry.kind === "non-streaming");
      if (!matches) continue;
      if (firstMatch < 0) firstMatch = i;
      if (!this.consumed.has(i)) {
        this.consumed.add(i);
        return entry;
      }
    }
    if (firstMatch < 0) {
      throw new Error("StubGoogleClient: no canned response of requested shape");
    }
    return this.sequence[firstMatch]!;
  }
}

function iterableFrom<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<T>> {
          if (i >= items.length) return { value: undefined as never, done: true };
          const v = items[i++]!;
          return { value: v, done: false };
        },
      };
    },
  };
}

export function asClient(stub: StubGoogleClient): GoogleGenAI {
  return stub as unknown as GoogleGenAI;
}

/** A client whose every call rejects with `cause` — the provider-error path. */
export function throwingClient(cause: unknown): GoogleGenAI {
  const raise = (): Promise<never> => Promise.reject(cause);
  return {
    models: { generateContent: raise, generateContentStream: raise },
  } as unknown as GoogleGenAI;
}

// ============================================================================
// Helpers for building canned responses
// ============================================================================

export interface MkResponseOpts {
  readonly text?: string;
  readonly thought?: string;
  readonly toolCalls?: ReadonlyArray<{
    readonly id?: string;
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly thoughtSignature?: string;
  }>;
  readonly finishReason?: string;
  readonly model?: string;
  readonly usage?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
    readonly totalTokenCount?: number;
    readonly thoughtsTokenCount?: number;
    readonly cachedContentTokenCount?: number;
  };
}

export function mkResponse(opts: MkResponseOpts): GenerateContentResponse {
  const parts: Array<Record<string, unknown>> = [];
  if (opts.thought) parts.push({ text: opts.thought, thought: true });
  if (opts.text !== undefined) parts.push({ text: opts.text });
  if (opts.toolCalls) {
    for (const tc of opts.toolCalls) {
      const part: Record<string, unknown> = {
        functionCall: {
          ...omitUndefined({ id: tc.id }),
          name: tc.name,
          args: tc.args,
        },
      };
      if (tc.thoughtSignature !== undefined) part.thoughtSignature = tc.thoughtSignature;
      parts.push(part);
    }
  }
  const u = opts.usage ?? {};
  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: opts.finishReason ?? "STOP",
        index: 0,
      },
    ],
    modelVersion: opts.model ?? "gemini-2.5-flash",
    usageMetadata: {
      promptTokenCount: u.promptTokenCount ?? 4,
      candidatesTokenCount: u.candidatesTokenCount ?? 2,
      totalTokenCount:
        u.totalTokenCount ?? (u.promptTokenCount ?? 4) + (u.candidatesTokenCount ?? 2),
      ...omitUndefined({
        thoughtsTokenCount: u.thoughtsTokenCount,
        cachedContentTokenCount: u.cachedContentTokenCount,
      }),
    },
  } as unknown as GenerateContentResponse;
}

export function mkTextChunk(text: string, model?: string): GenerateContentResponse {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        index: 0,
      },
    ],
    modelVersion: model ?? "gemini-2.5-flash",
  } as unknown as GenerateContentResponse;
}

export function mkThoughtChunk(text: string): GenerateContentResponse {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text, thought: true }] },
        index: 0,
      },
    ],
    modelVersion: "gemini-2.5-flash",
  } as unknown as GenerateContentResponse;
}

export function mkFunctionCallChunk(opts: {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
}): GenerateContentResponse {
  const part: Record<string, unknown> = {
    functionCall: {
      ...omitUndefined({ id: opts.id }),
      name: opts.name,
      args: opts.args,
    },
  };
  if (opts.thoughtSignature !== undefined) part.thoughtSignature = opts.thoughtSignature;
  return {
    candidates: [
      {
        content: { role: "model", parts: [part] },
        index: 0,
      },
    ],
    modelVersion: "gemini-2.5-flash",
  } as unknown as GenerateContentResponse;
}

export function mkFinishChunk(opts: {
  finishReason?: string;
  usage?: MkResponseOpts["usage"];
}): GenerateContentResponse {
  const u = opts.usage ?? {};
  return {
    candidates: [
      {
        content: { role: "model", parts: [] },
        finishReason: opts.finishReason ?? "STOP",
        index: 0,
      },
    ],
    modelVersion: "gemini-2.5-flash",
    usageMetadata: {
      promptTokenCount: u.promptTokenCount ?? 4,
      candidatesTokenCount: u.candidatesTokenCount ?? 2,
      totalTokenCount:
        u.totalTokenCount ?? (u.promptTokenCount ?? 4) + (u.candidatesTokenCount ?? 2),
      ...omitUndefined({
        thoughtsTokenCount: u.thoughtsTokenCount,
        cachedContentTokenCount: u.cachedContentTokenCount,
      }),
    },
  } as unknown as GenerateContentResponse;
}

// ============================================================================
// Executor harness
// ============================================================================
// A `google()` adapter wired into a real `LanguageModelExecutor` over the stub
// above. Lives here rather than in one spec file because every Google spec needs
// the same three pieces to say anything at all, and a second copy is a second
// place for the wiring to drift from the adapter it is testing.

/** A one-user-message tree — the minimum a target will accept. */
export function emptyTree(): RenderedTree {
  return {
    specVersion: "2026-05-08",
    context: {
      entries: [
        { kind: "message", id: "m_1", role: "user", content: [{ type: "text", text: "hi" }] },
      ],
    },
  };
}

export function mkTarget(overrides?: Partial<LanguageModelTarget>): LanguageModelTarget {
  return {
    kind: "language-model",
    provider: "google",
    modelId: "gemini-2.5-flash",
    ...(overrides ?? {}),
  };
}

export async function makeExecutor(
  stub: StubGoogleClient,
  opts: {
    stream?: boolean;
    model?: string;
    parseThinkTags?: boolean;
    customBlocks?: Record<string, { tag?: string; onContent?: (c: string) => void }>;
    providerOptions?: ProviderOptions;
    target?: ExecutionTarget;
  } = {},
) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();
  const exec = new LanguageModelExecutor("exec-google-test", journal, bus, inbox, {
    adapter: google(opts.model ?? "gemini-2.5-flash", {
      client: asClient(stub),
      ...omitUndefined({
        stream: opts.stream,
        providerOptions: opts.providerOptions,
        target: opts.target,
      }),
      ...(opts.parseThinkTags ? { parseThinkTags: true } : {}),
      ...(opts.customBlocks ? { customBlocks: opts.customBlocks } : {}),
    }),
  });
  await exec.ready;
  return { exec, journal, bus, inbox };
}
