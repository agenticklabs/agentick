/**
 * Test-only stub for the `openai` SDK's `Chat.Completions.create()`.
 *
 * The real adapter is dependency-injected via `OpenAIExecutorOptions.client`,
 * so unit tests don't need the network or `undici.MockAgent`. The stub
 * implements only the shape `OpenAIExecutor` consumes: `chat.completions.create`.
 *
 * Each invocation pulls the next "canned response" from the configured
 * sequence. Responses can be:
 *   - `{ kind: "non-streaming"; completion }` — returns the ChatCompletion
 *     directly (mirrors `stream: false` call shape).
 *   - `{ kind: "streaming"; chunks }` — returns an AsyncIterable of the
 *     provided chunks (mirrors `stream: true` call shape).
 *
 * The stub records every call's params + abort signal so tests can assert
 * the request shape and the abort plumbing.
 */

import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
} from "openai/resources/chat/completions";

import type OpenAI from "openai";

export type CannedResponse =
  | { readonly kind: "non-streaming"; readonly completion: ChatCompletion }
  | {
      readonly kind: "streaming";
      readonly chunks: ReadonlyArray<ChatCompletionChunk>;
    };

export interface RecordedCall {
  readonly params: ChatCompletionCreateParams;
  readonly signal: AbortSignal | undefined;
}

export class StubOpenAIClient {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly sequence: ReadonlyArray<CannedResponse>) {}

  private index = 0;

  private next(): CannedResponse {
    const i = Math.min(this.index, this.sequence.length - 1);
    this.index++;
    const next = this.sequence[i];
    if (!next) throw new Error("StubOpenAIClient: no canned response");
    return next;
  }

  readonly chat = {
    completions: {
      create: (
        params: ChatCompletionCreateParams,
        options?: { signal?: AbortSignal },
      ): Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>> => {
        this.calls.push({ params, signal: options?.signal });
        const next = this.next();
        if (next.kind === "non-streaming") {
          return Promise.resolve(next.completion);
        }
        // Mirror the real SDK: streaming returns a Promise wrapping an
        // AsyncIterable (the SDK awaits headers + a Stream wrapper).
        return Promise.resolve(iterableFrom(next.chunks));
      },
    },
  };
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

/**
 * Coerce the stub into the `OpenAI` type. The runtime shape is
 * intentionally minimal — `OpenAIExecutor` only touches
 * `client.chat.completions.create`, so a structural cast is sound for
 * tests.
 */
export function asClient(stub: StubOpenAIClient): OpenAI {
  return stub as unknown as OpenAI;
}

// ============================================================================
// Helpers for building canned responses
// ============================================================================

export function mkCompletion(opts: {
  text?: string;
  toolCalls?: ReadonlyArray<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  finishReason?: ChatCompletion["choices"][0]["finish_reason"];
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}): ChatCompletion {
  const toolCalls = opts.toolCalls?.map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
  }));
  return {
    id: `chatcmpl-test-${Math.random().toString(36).slice(2)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts.model ?? "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: opts.text ?? null,
          refusal: null,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason:
          opts.finishReason ??
          (toolCalls && toolCalls.length > 0 ? "tool_calls" : "stop"),
        logprobs: null,
      },
    ],
    usage: opts.usage ?? {
      prompt_tokens: 8,
      completion_tokens: 4,
      total_tokens: 12,
    },
  } as ChatCompletion;
}

export function mkContentChunk(opts: {
  delta: string;
  model?: string;
  id?: string;
}): ChatCompletionChunk {
  return {
    id: opts.id ?? "chatcmpl-stream-1",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: opts.model ?? "gpt-4o-mini",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: opts.delta },
        finish_reason: null,
        logprobs: null,
      },
    ],
  } as ChatCompletionChunk;
}

export function mkFinishChunk(opts: {
  finishReason?: ChatCompletionChunk["choices"][0]["finish_reason"];
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}): ChatCompletionChunk {
  return {
    id: "chatcmpl-stream-1",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: opts.model ?? "gpt-4o-mini",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: opts.finishReason ?? "stop",
        logprobs: null,
      },
    ],
    ...(opts.usage ? { usage: opts.usage } : {}),
  } as ChatCompletionChunk;
}
