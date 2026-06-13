/**
 * Test-only stub for `Anthropic.messages.create()`.
 *
 * `AnthropicExecutor` consumes only `client.messages.create()` —
 * dispatching by the request's `stream` flag for both non-streaming
 * (Promise<Message>) and streaming (AsyncIterable<RawMessageStreamEvent>)
 * paths. The stub records every call (params + abort signal) and pulls
 * the next matching canned response from its sequence.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type {
  Message as AnthropicMessage,
  MessageCreateParams,
  RawMessageStreamEvent,
  Usage,
} from "@anthropic-ai/sdk/resources/messages";

export type CannedResponse =
  | { readonly kind: "non-streaming"; readonly message: AnthropicMessage }
  | {
      readonly kind: "streaming";
      readonly events: ReadonlyArray<RawMessageStreamEvent>;
    };

export interface RecordedCall {
  readonly params: MessageCreateParams;
  readonly signal: AbortSignal | undefined;
}

export class StubAnthropicClient {
  readonly calls: RecordedCall[] = [];
  private readonly consumed = new Set<number>();

  constructor(private readonly sequence: ReadonlyArray<CannedResponse>) {}

  readonly messages = {
    create: (
      params: MessageCreateParams,
      options?: { signal?: AbortSignal },
    ): Promise<AnthropicMessage | AsyncIterable<RawMessageStreamEvent>> => {
      this.calls.push({ params, signal: options?.signal });
      const wantStream = params.stream === true;
      const matchIdx = this.findMatchingIdx(wantStream);
      const picked =
        matchIdx >= 0 ? this.sequence[matchIdx]! : this.sequence[this.sequence.length - 1]!;
      if (matchIdx >= 0) this.consumed.add(matchIdx);
      if (!picked) throw new Error("StubAnthropicClient: no canned response");
      if (picked.kind === "non-streaming") {
        return Promise.resolve(picked.message);
      }
      return Promise.resolve(iterableFrom(picked.events));
    },
  };

  private findMatchingIdx(wantStream: boolean): number {
    let firstMatch = -1;
    for (let i = 0; i < this.sequence.length; i++) {
      const entry = this.sequence[i]!;
      const matches =
        (wantStream && entry.kind === "streaming") ||
        (!wantStream && entry.kind === "non-streaming");
      if (!matches) continue;
      if (firstMatch < 0) firstMatch = i;
      if (!this.consumed.has(i)) return i;
    }
    return firstMatch;
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

export function asClient(stub: StubAnthropicClient): Anthropic {
  return stub as unknown as Anthropic;
}

// ============================================================================
// Helpers for building canned responses
// ============================================================================

export function mkMessage(opts: {
  text?: string;
  thinking?: string;
  toolCalls?: ReadonlyArray<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason?: AnthropicMessage["stop_reason"];
  model?: string;
  usage?: Partial<Usage>;
}): AnthropicMessage {
  const content: AnthropicMessage["content"] = [];
  if (opts.thinking) {
    content.push({
      type: "thinking",
      thinking: opts.thinking,
      signature: "",
    } as unknown as AnthropicMessage["content"][number]);
  }
  if (opts.text !== undefined) {
    content.push({
      type: "text",
      text: opts.text,
      citations: null,
    } as unknown as AnthropicMessage["content"][number]);
  }
  if (opts.toolCalls) {
    for (const tc of opts.toolCalls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: tc.input,
      } as unknown as AnthropicMessage["content"][number]);
    }
  }
  const u = opts.usage ?? {};
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model: opts.model ?? "claude-3-5-sonnet-latest",
    content,
    stop_reason:
      opts.stopReason ?? (opts.toolCalls && opts.toolCalls.length > 0 ? "tool_use" : "end_turn"),
    stop_sequence: null,
    usage: {
      input_tokens: u.input_tokens ?? 8,
      output_tokens: u.output_tokens ?? 4,
      cache_read_input_tokens: u.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
    },
  } as AnthropicMessage;
}

export function mkMessageStartEvent(opts: {
  model?: string;
  inputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
}): RawMessageStreamEvent {
  return {
    type: "message_start",
    message: {
      id: "msg_stub",
      type: "message",
      role: "assistant",
      model: opts.model ?? "claude-3-5-sonnet-latest",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: opts.inputTokens ?? 4,
        output_tokens: 0,
        cache_read_input_tokens: opts.cacheRead ?? null,
        cache_creation_input_tokens: opts.cacheCreation ?? null,
      },
    },
  } as RawMessageStreamEvent;
}

export function mkContentBlockStartText(index: number): RawMessageStreamEvent {
  return {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "", citations: null },
  } as RawMessageStreamEvent;
}

export function mkContentBlockStartThinking(index: number): RawMessageStreamEvent {
  return {
    type: "content_block_start",
    index,
    content_block: { type: "thinking", thinking: "", signature: "" },
  } as RawMessageStreamEvent;
}

export function mkContentBlockStartToolUse(
  index: number,
  id: string,
  name: string,
): RawMessageStreamEvent {
  return {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name, input: {} },
  } as RawMessageStreamEvent;
}

export function mkTextDelta(index: number, text: string): RawMessageStreamEvent {
  return {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  } as RawMessageStreamEvent;
}

export function mkThinkingDelta(index: number, thinking: string): RawMessageStreamEvent {
  return {
    type: "content_block_delta",
    index,
    delta: { type: "thinking_delta", thinking },
  } as RawMessageStreamEvent;
}

export function mkInputJsonDelta(index: number, partial_json: string): RawMessageStreamEvent {
  return {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json },
  } as RawMessageStreamEvent;
}

export function mkContentBlockStop(index: number): RawMessageStreamEvent {
  return { type: "content_block_stop", index } as RawMessageStreamEvent;
}

export function mkMessageDelta(
  stopReason: AnthropicMessage["stop_reason"],
  outputTokens: number,
): RawMessageStreamEvent {
  return {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  } as RawMessageStreamEvent;
}

export function mkMessageStop(): RawMessageStreamEvent {
  return { type: "message_stop" } as RawMessageStreamEvent;
}
