/**
 * What did the adapter throw away? Answered by differential projection — no adapter
 * cooperation, no network.
 *
 * The invariant: **no canonical input may be discarded or transformed silently.** Several
 * adapters take a third option — skip it and let the request succeed — and there are four
 * such drops in this repo, each filed as a `TODO` and none observable at runtime:
 * `responseFormat` on anthropic and ai-sdk, replayed reasoning on google and openai.
 *
 * `prepareRequest` is pure and does no I/O (every adapter's `createSourceInterner` lives in
 * `normalizeImpl`, on the output path), which makes this sound: **remove one canonical
 * input, re-project, deep-compare. Identical means that input contributed nothing.**
 *
 * It cannot see an input carried in a form the provider will REJECT — the request did
 * change, so nothing was dropped. That is what `capabilities.media` covers; the two are
 * complementary and police each other.
 *
 * `n + 1` local projections, so this is a failure-time and test-time audit — the sanitizer,
 * not the allocator.
 */

import type {
  ExecutionTarget,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelMessagePart,
} from "@agentick/spec";
import { isEqual } from "@agentick/utils";

/** The minimum of an adapter this audit needs: a pure canonical → native projection. */
export interface ProjectingAdapter {
  readonly provider: string;
  readonly target: ExecutionTarget;
  prepareRequest(input: { targetInput: LanguageModelInput; target: ExecutionTarget }): unknown;
}

/**
 * One message part that never reached the wire, positioned in the input it was found in
 * — the same coordinates {@link import("./provenance.js").MessageProvenance} uses, so
 * `originOf` turns it into the timeline entry that produced it.
 */
export interface DroppedPart {
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly partType: string;
}

export interface DroppedInputs {
  /** Message parts the adapter discarded. */
  readonly parts: readonly DroppedPart[];
  /**
   * Canonical generation parameters the adapter ignored — `responseFormat`,
   * `toolChoice`, `stopSequences` and friends. A silently dropped `responseFormat` means
   * an adopter asked for structured output and got prose, with no error anywhere.
   */
  readonly parameters: readonly string[];
  /**
   * Tool names that never reached the wire. A dropped tool is a capability the model was
   * told about and cannot call, or was never told about and is expected to use.
   */
  readonly tools: readonly string[];
}

/**
 * Audit an adapter's projection for silently discarded inputs.
 *
 * Deterministic and side-effect free: it calls `prepareRequest` and nothing else. Returns
 * empty lists for a faithful adapter, which is the answer worth getting on most inputs.
 */
export function detectDroppedInputs(
  adapter: ProjectingAdapter,
  input: LanguageModelInput,
): DroppedInputs {
  const target = adapter.target;
  const project = (targetInput: LanguageModelInput): unknown =>
    adapter.prepareRequest({ targetInput, target });
  const baseline = project(input);
  /** Did removing something leave the native request untouched? Then it never mattered. */
  const contributedNothing = (without: LanguageModelInput): boolean =>
    isEqual(project(without), baseline);

  return {
    parts: droppedParts(input, contributedNothing),
    parameters: droppedParameters(input, contributedNothing),
    tools: droppedTools(input, contributedNothing),
  };
}

function droppedParts(
  input: LanguageModelInput,
  contributedNothing: (without: LanguageModelInput) => boolean,
): readonly DroppedPart[] {
  const dropped: DroppedPart[] = [];
  input.messages.forEach((message, messageIndex) => {
    message.content.forEach((_part, partIndex) => {
      // Removing a SOLO part empties its message, which some adapters then drop
      // wholesale. That is not a confound: if the part had been dropped, the adapter
      // would produce the same request for "message with a dropped part" as for
      // "message with no parts" — so identical still means the part never mattered.
      // Only a carried part makes those two cases differ.
      if (contributedNothing(withoutPart(input, messageIndex, partIndex))) {
        dropped.push({
          messageIndex,
          partIndex,
          partType: message.content[partIndex]!.type,
        });
      }
    });
  });
  return dropped;
}

function droppedParameters(
  input: LanguageModelInput,
  contributedNothing: (without: LanguageModelInput) => boolean,
): readonly string[] {
  const parameters = input.parameters;
  if (parameters === undefined) return [];
  return Object.keys(parameters).filter((key) =>
    contributedNothing({
      ...input,
      parameters: Object.fromEntries(
        Object.entries(parameters).filter(([k]) => k !== key),
      ) as LanguageModelInput["parameters"],
    }),
  );
}

function droppedTools(
  input: LanguageModelInput,
  contributedNothing: (without: LanguageModelInput) => boolean,
): readonly string[] {
  const tools = input.tools;
  if (tools === undefined || tools.length === 0) return [];
  return tools
    .filter((_tool, i) => contributedNothing({ ...input, tools: tools.filter((_t, j) => j !== i) }))
    .map((tool) => tool.name);
}

function withoutPart(
  input: LanguageModelInput,
  messageIndex: number,
  partIndex: number,
): LanguageModelInput {
  return {
    ...input,
    messages: input.messages.map((message, i) =>
      i === messageIndex
        ? ({
            ...message,
            content: message.content.filter(
              (_p: LanguageModelMessagePart, j: number) => j !== partIndex,
            ),
          } as LanguageModelMessage)
        : message,
    ),
  };
}
