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
 * transcript: the model sees the system prompt, the tools, the grounding and
 * the whole conversation, because it IS the turn it would otherwise have taken.
 */

import type { ContentBlock, LanguageModelInput, LanguageModelMessage } from "@agentick/spec";

export interface ReflectInput {
  /** What to think about. Appended after everything the next tick would send. */
  readonly instructions: string | readonly ContentBlock[];
  /** Ceiling on the reply. Also the denominator of any progress a caller reports. */
  readonly maxOutputTokens?: number;
  readonly onDelta?: (d: { readonly text: string; readonly outputTokens: number }) => void;
  readonly signal?: AbortSignal;
}

export interface ReflectResult {
  readonly text: string;
  readonly outputTokens: number;
  /** The cap was hit — the text stops mid-thought and should not be persisted. */
  readonly truncated: boolean;
}

const asBlocks = (instructions: string | readonly ContentBlock[]): readonly ContentBlock[] =>
  typeof instructions === "string" ? [{ type: "text", text: instructions }] : instructions;

/**
 * Append the instruction as a final user turn. A model answers an instruction in
 * the generation seat; the same text in a system position competes with the
 * agent's own standing rules for authority.
 */
export function withInstruction(
  input: LanguageModelInput,
  instructions: string | readonly ContentBlock[],
  maxOutputTokens?: number,
): LanguageModelInput {
  const turn = { role: "user", content: asBlocks(instructions) } as LanguageModelMessage;
  return {
    ...input,
    messages: [...input.messages, turn],
    // Tools are withheld: a reflection asks for prose, and a model handed tools
    // will reach for one instead of answering.
    tools: [],
    ...(maxOutputTokens !== undefined
      ? { parameters: { ...input.parameters, maxOutputTokens } }
      : {}),
  };
}

export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}
