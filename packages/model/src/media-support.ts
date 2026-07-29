/**
 * Screen media parts against what the target declares it can carry — the one site where
 * "this attachment cannot go on the wire" is decided.
 *
 * It used to be decided four times, once per adapter, inside a `switch` returning `null`,
 * and both consequences were unfixable by adapter discipline. **The verdict was discarded**
 * — an unprojectable part was skipped and the request SUCCEEDED, so the model never saw the
 * user's attachment and nothing recorded it. And **some verdicts were never reached**:
 * Anthropic's projection has no `audio` or `video` arm, so those parts fall off the end with
 * no `null` for any reporting convention to observe.
 *
 * Declaring support moves the decision to one framework-owned site, so an adapter cannot
 * forget to report a decline it never makes.
 *
 * `PartDeclined` uses the same coordinates as `buildMessageProvenance`, so a decline joins
 * to the durable timeline entry that produced it.
 */

import type {
  ExecutionTarget,
  LanguageModelMessage,
  LanguageModelMessagePart,
  MediaSourceKind,
} from "@agentick/spec";
import { DEFAULT_URL_SCHEMES } from "@agentick/spec";

/** The modality part types this screen governs. */
const MEDIA_TYPES = ["image", "document", "audio", "video"] as const;

type MediaPartType = (typeof MEDIA_TYPES)[number];

/** Every media part shares `source` + `mediaType`; this is that subset. */
type MediaPart = Extract<LanguageModelMessagePart, { type: MediaPartType }>;

/**
 * One part the target cannot carry, positioned in the projection it was screened
 * from.
 *
 * `messageIndex` / `partIndex` index the messages passed to
 * {@link applyMediaSupport} — deliberately the same coordinates
 * {@link import("./provenance.js").MessageProvenance} uses, so `originOf` turns a
 * decline into the durable timeline entry id that produced it.
 */
export interface PartDeclined {
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly partType: MediaPartType;
  readonly sourceType: MediaSourceKind;
  /** Why, in terms of the declaration — safe to show a user or write to a log. */
  readonly reason: string;
}

/** What {@link applyMediaSupport} returns: the wire messages, and the verdicts. */
export interface MediaSupportResult {
  /**
   * The messages to send. Declined parts are removed, and a message left with no
   * parts at all is dropped — a rule that previously lived, inconsistently, in
   * each adapter.
   */
  readonly messages: readonly LanguageModelMessage[];
  /** Empty when everything is carried, which is the overwhelmingly common case. */
  readonly declined: readonly PartDeclined[];
}

/**
 * Screen `messages` against `target.capabilities.media`.
 *
 * With no declaration, nothing is screened and the input is returned as-is —
 * absence means *undeclared*, never *carries nothing*, or every target that has
 * not opted in would start dropping media. With a declaration, it is treated as
 * complete: a modality with no entry carries nothing.
 *
 * Pure and cheap. Call it again later for the `declined` list rather than
 * threading it anywhere.
 */
export function applyMediaSupport(
  messages: readonly LanguageModelMessage[],
  target: ExecutionTarget,
): MediaSupportResult {
  const support = target.capabilities?.media;
  if (support === undefined) return { messages, declined: [] };

  const schemes = support.urlSchemes ?? DEFAULT_URL_SCHEMES;
  const declined: PartDeclined[] = [];
  const kept = filterMessageParts(messages, (part, messageIndex, partIndex) => {
    if (!isMediaPart(part)) return true;
    const allowed = support[part.type] ?? [];
    const sourceType = part.source.type;
    const reason = !allowed.includes(sourceType)
      ? declineReason(target, part.type, sourceType, allowed)
      : // A `url` is not one thing. `gs://` reaches Vertex natively and is inert to
        // Anthropic, so the SCHEME is the fact that decides it — and checking it here is
        // what let `s3` / `gcs` leave `MediaSource` without re-opening the hole those
        // variants were closing.
        sourceType === "url" && !schemes.includes(schemeOf(part.source.url))
        ? `${target.provider ?? target.kind} cannot fetch a '${schemeOf(part.source.url)}:' URI ` +
          `(fetches: ${schemes.join(", ")})`
        : undefined;
    if (reason === undefined) return true;
    declined.push({ messageIndex, partIndex, partType: part.type, sourceType, reason });
    return false;
  });

  return { messages: kept, declined };
}

/**
 * The scheme of a URI, lowercased and without the `:` — `""` for a bare or relative
 * string, which no target declares and so is declined.
 */
function schemeOf(url: string): string {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
  return match?.[1]?.toLowerCase() ?? "";
}

/**
 * Rebuild `messages` keeping only the parts `keep` accepts. Two rules that are easy to get
 * subtly wrong: a message emptied BY the removal is dropped (an empty `content` is a request
 * most providers reject), while one that was ALREADY empty is left alone. And a removed part
 * never takes its neighbours — one unprojectable attachment silently truncating the user's
 * question would be worse than the bug being fixed.
 *
 * Untouched messages come back by reference, and so does the array when nothing was removed.
 */
function filterMessageParts(
  messages: readonly LanguageModelMessage[],
  keep: (part: LanguageModelMessagePart, messageIndex: number, partIndex: number) => boolean,
): readonly LanguageModelMessage[] {
  const out: LanguageModelMessage[] = [];
  let changed = false;
  messages.forEach((message, messageIndex) => {
    let removed = false;
    const kept = message.content.filter((part, partIndex) => {
      if (keep(part, messageIndex, partIndex)) return true;
      removed = true;
      return false;
    });
    if (!removed) {
      out.push(message);
      return;
    }
    changed = true;
    if (kept.length > 0) out.push({ ...message, content: kept });
  });
  return changed ? out : messages;
}

function isMediaPart(part: LanguageModelMessagePart): part is MediaPart {
  return (MEDIA_TYPES as readonly string[]).includes(part.type);
}

/**
 * The two distinguishable cases, worded so a log line or a UI notice explains
 * itself: the modality is not carried at all, or it is carried but not from this
 * kind of source.
 */
function declineReason(
  target: ExecutionTarget,
  partType: MediaPartType,
  sourceType: MediaSourceKind,
  allowed: readonly MediaSourceKind[],
): string {
  const who = target.provider ?? target.kind;
  return allowed.length === 0
    ? `${who} carries no ${partType} parts`
    : `${who} cannot carry a ${partType} from a '${sourceType}' source (carries: ${allowed.join(", ")})`;
}
