/**
 * The reflection pass — one more turn of this session, with an extra
 * instruction at the end.
 *
 * Compaction, episodic memory, thread titling and post-mortem critique are the
 * same operation under different instructions: render the context the next tick
 * would send, append what you want thought about, and ask the session's own
 * model. Appending at the END is the whole trick — the prefix stays
 * byte-identical to the next tick's, so the provider reads it from cache
 * instead of charging for it again.
 *
 * That also makes the pass as rich as a real turn rather than a stripped
 * transcript: the model sees the system prompt, the grounding and the whole
 * conversation, because it IS the turn it would otherwise have taken. What it
 * does NOT see is the agent's tools — a reflection wants an answer, and a model
 * handed a tool reaches for it instead. The one exception is the terminal tool
 * a structured reflection delivers through.
 */

import type {
  ContentBlock,
  ExecutionTarget,
  ExecutorStream,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelParameters,
  OutputSpec,
  ResponseFormat,
  StandardSchemaV1,
  StructuredOutputCapture,
  ToolDeclaration,
  UsageStats,
} from "@agentick/spec";
import {
  DEFAULT_TERMINAL_TOOL_NAME,
  StructuredOutputIncomplete,
  resolveAutoStrategy,
  terminalToolDeclaration,
  toJsonSchema,
  validateStructuredOutput,
} from "@agentick/spec";
import { estimateTokens } from "@agentick/model";
import { omitUndefined } from "@agentick/utils";

export interface ReflectInput<T = unknown> {
  /** What to think about. Appended after everything the next tick would send. */
  readonly instructions: string | readonly ContentBlock[];
  /** Ceiling on the reply. Also the denominator of any progress a caller reports. */
  readonly maxOutputTokens?: number;
  readonly onDelta?: (d: { readonly text: string; readonly outputTokens: number }) => void;
  readonly signal?: AbortSignal;
  /**
   * Structured answer — declarative form, the same field
   * {@link import("@agentick/spec").SendInput.responseFormat} carries. A
   * generation-time provider directive only: nothing parses or validates it,
   * and providers that drop `response_format` (Anthropic) ignore it. For a
   * validated value use {@link output}.
   */
  readonly responseFormat?: ResponseFormat;
  /**
   * Structured answer — LIVE-schema sugar, the same field
   * {@link import("@agentick/spec").SendInput.output} carries. The reflection
   * delivers through the synthetic terminal tool when the target cannot decode
   * a schema natively, and the validated value lands on
   * {@link ReflectResult.data}. A schema that was asked for and not met throws
   * `ResponseValidationError` — the same semantics `send` has, not a second
   * set.
   */
  readonly output?: StandardSchemaV1<unknown, T>;
}

export interface ReflectResult<T = unknown> {
  readonly text: string;
  /** What the call cost. Absent when the provider reports none. */
  readonly usage?: UsageStats;
  /** The cap was hit — the text stops mid-thought and should not be persisted. */
  readonly truncated: boolean;
  /**
   * The validated structured answer. Present only when {@link ReflectInput.output}
   * was supplied — mirrors `SendResult.data`. Under the terminal-tool strategy
   * the answer IS the tool's arguments, so `text` is routinely empty.
   */
  readonly data?: T;
}

const asBlocks = (instructions: string | readonly ContentBlock[]): readonly ContentBlock[] =>
  typeof instructions === "string" ? [{ type: "text", text: instructions }] : instructions;

/**
 * Append the instruction as a final user turn, overlaying any generation
 * parameters the pass asked for. A model answers an instruction in the
 * generation seat; the same text in a system position competes with the
 * agent's own standing rules for authority.
 *
 * The tool list is NOT touched here — what a reflection advertises is decided
 * in {@link reflectionRequest}, so one place says which tools a reflection
 * carries.
 */
export function withInstruction(
  input: LanguageModelInput,
  instructions: string | readonly ContentBlock[],
  parameters?: Partial<LanguageModelParameters>,
): LanguageModelInput {
  const turn = { role: "user", content: asBlocks(instructions) } as LanguageModelMessage;
  const overlay = omitUndefined(parameters ?? {});
  return {
    ...input,
    messages: [...input.messages, turn],
    ...(Object.keys(overlay).length > 0 ? { parameters: { ...input.parameters, ...overlay } } : {}),
  };
}

/**
 * Everything a structured reflection decides BEFORE the call: the resolved
 * output directive, what the model is shown, and the generation overlay.
 *
 * A reflection advertises no tools, so the strategy turns purely on whether the
 * target decodes a schema natively — `resolveAutoStrategy(0, …)`, the same
 * call the loop makes for a tick with nothing mounted. Under the terminal-tool
 * strategy the tool IS what the model is shown, and the choice is forced from
 * the start: the loop can spend a second tick on a wrap-up, a reflection has
 * only the one shot.
 */
export function reflectionRequest(
  input: Pick<ReflectInput, "maxOutputTokens" | "output" | "responseFormat">,
  target: ExecutionTarget,
): {
  readonly spec?: OutputSpec;
  readonly tools: readonly ToolDeclaration[];
  readonly parameters: Partial<LanguageModelParameters>;
} {
  const spec: OutputSpec | undefined =
    input.output === undefined
      ? undefined
      : {
          toolName: DEFAULT_TERMINAL_TOOL_NAME,
          schema: input.output,
          strategy: resolveAutoStrategy(0, target.capabilities),
        };
  return {
    ...(spec !== undefined ? { spec } : {}),
    tools: spec?.strategy === "tool" ? [terminalToolDeclaration(spec)] : [],
    parameters: omitUndefined({
      maxOutputTokens: input.maxOutputTokens,
      responseFormat:
        spec?.strategy === "responseFormat"
          ? { type: "json_schema" as const, name: spec.toolName, schema: toJsonSchema(spec.schema) }
          : input.responseFormat,
      toolChoice: spec?.strategy === "tool" ? ({ tool: spec.toolName } as const) : undefined,
    }),
  };
}

/**
 * The validated answer. Under the terminal strategy a reply that never called
 * the tool is the honest failure the loop names the same way — one forced shot
 * was the whole budget — and a reply that called it with the wrong shape raises
 * the same `ResponseValidationError` a structured `send` raises.
 */
export async function reflectionData(
  spec: OutputSpec,
  result: LanguageModelExecutionResult,
): Promise<unknown> {
  let capture: StructuredOutputCapture;
  if (spec.strategy === "tool") {
    const call = result.toolCalls?.find((c) => c.name === spec.toolName);
    if (call === undefined) {
      throw new StructuredOutputIncomplete({ toolName: spec.toolName, reason: "no_terminal_call" });
    }
    capture = { strategy: "tool", input: call.input };
  } else {
    capture = { strategy: "responseFormat", text: textOf(result.output) };
  }
  const validated = await validateStructuredOutput(spec.schema, capture);
  if ("error" in validated) throw validated.error;
  return validated.value;
}

export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

/**
 * Forward the stream to `onDelta` and return what `execute` would have.
 *
 * Most providers report `outputTokens` only when the message ends, so until one
 * arrives the count is estimated from the text — a bar that only moves at the
 * end is a spinner with extra steps.
 */
export async function forwardDeltas<T>(
  stream: ExecutorStream<T>,
  onDelta: NonNullable<ReflectInput["onDelta"]>,
): Promise<T> {
  let text = "";
  let reported: number | undefined;
  for await (const delta of stream) {
    if (delta.type === "content-delta") text += delta.delta;
    else if (delta.type === "usage" || delta.type === "message-end" || delta.type === "message") {
      reported = delta.usage.outputTokens;
    } else continue;
    onDelta({ text, outputTokens: reported ?? estimateTokens(text) });
  }
  return stream.result;
}
