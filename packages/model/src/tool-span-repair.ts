/**
 * The last stop before the wire: a span still missing an end here is a request
 * the provider will refuse, and nothing downstream can fix it.
 *
 * Reachable today on a single model with no provider metadata in the picture —
 * a `<Timeline>` `filter` that drops the assistant turn but keeps the tool
 * message, or a custom `CompactionFunction` that cuts between a call and its
 * result. `@agentick/timeline` avoids both at the source; this is the net under
 * it, and the only site that sees the messages actually being sent.
 *
 * Pruning is the whole repair, because pruning is all that is left. Earlier
 * sites can choose a different cut or evict the partner; here the message list
 * IS the request. Turning an unpaired call into something the model can still
 * read is a question about MEANING and belongs to the tree — see
 * `docs/proposals/v2/provider-round-trip.md`.
 */

import type { LanguageModelMessage, LanguageModelMessagePart } from "@agentick/spec";
import { danglingToolIds, isDangling, isIntact, toolSpanEnd } from "@agentick/spec";

/**
 * The surviving half of a broken span, positioned in the projection it was
 * pruned from. The coordinates are the ones
 * {@link import("./provenance.js").MessageProvenance} uses, so `originOf` turns
 * a prune into the durable timeline entry behind it.
 */
export interface DanglingToolPart {
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly end: "open" | "close";
  readonly toolUseId: string;
}

/** What {@link repairToolSpans} returns: the wire messages, and what it pruned. */
export interface ToolSpanRepair {
  /**
   * The messages to send. Dangling ends are removed, and a message this pass
   * empties is dropped — an empty message is itself a provider error.
   */
  readonly messages: readonly LanguageModelMessage[];
  /** Empty for every well-formed projection, which is the common case. */
  readonly pruned: readonly DanglingToolPart[];
}

const NOTHING_PRUNED: readonly DanglingToolPart[] = [];

/**
 * Prune tool parts whose other end is absent.
 *
 * Returns the input array by reference when nothing is pruned, so the path every
 * well-formed request takes costs one scan and no allocation.
 */
export function repairToolSpans(messages: readonly LanguageModelMessage[]): ToolSpanRepair {
  const dangling = danglingToolIds(messages.map((m) => m.content));
  if (isIntact(dangling)) return { messages, pruned: NOTHING_PRUNED };

  const pruned: DanglingToolPart[] = [];
  const kept: LanguageModelMessage[] = [];

  for (const [messageIndex, message] of messages.entries()) {
    const content: LanguageModelMessagePart[] = [];
    for (const [partIndex, part] of message.content.entries()) {
      const span = toolSpanEnd(part);
      if (span === undefined || !isDangling(span, dangling)) {
        content.push(part);
        continue;
      }
      pruned.push({ messageIndex, partIndex, end: span.end, toolUseId: span.toolUseId });
    }
    if (content.length === message.content.length) kept.push(message);
    else if (content.length > 0) kept.push({ ...message, content });
  }

  return { messages: kept, pruned };
}
