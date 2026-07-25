/**
 * Bounded tool-output client projection (ROADMAP A3 / Pi-post lesson).
 *
 * A tool can return a multi-megabyte result — a whole file read, a
 * verbose command dump, an inline base64 image. That full payload MUST
 * reach the model (it may need it) and MUST land in the durable timeline
 * store (the source of truth). It must NOT be pushed verbatim to a
 * browser: the wire is the expensive, latency-sensitive edge, and a UI
 * transcript has no use for 5 MB of raw text.
 *
 * This module is the PURE, platform-independent core of the projection:
 * given a {@link ContentBlock}, produce a BOUNDED copy whose oversized
 * inline payload is replaced by a truncated preview plus an HONEST
 * {@link BoundedContentMarker} (`{ truncated: true, originalBytes, … }`).
 * It touches ONLY the block it is handed — it never reaches into the
 * store or the model path. The wire-shape-aware frame projection that
 * decides WHICH blocks to bound (the four client-facing frame shapes)
 * lives at the transport dispatch boundary
 * (`@agentick/transport` `server/client-projection.ts`), the ONE
 * place every client-bound frame passes through.
 *
 * **Opt-in capability, not default policy (capability, not opinion).**
 * Output bounding is OFF unless an adopter turns it on. This is a
 * deliberate split from the framework's SECURITY defaults — those protect
 * the OPERATOR and ship default-ON (our duty to enforce). Bounding tool
 * output is an app-UX POLICY: how large a payload a given app's transcript
 * should carry is the app developer's domain, not the framework's. So the
 * framework ships the CAPABILITY (a typed seam) OFF, with a good
 * overridable default the adopter opts into. Enable it on the gateway
 * ({@link TruncateToolResultsSetting}): `createGateway({ truncateToolResults: true })`
 * for the 32 KiB default ({@link DEFAULT_MAX_TOOL_RESULT_BYTES}),
 * `{ maxBytes }` to tune, or `{ truncate }` to replace the per-block
 * bounder. Bounding applies ONLY to content sent to clients over the wire —
 * the model and the durable store always receive the full content.
 *
 * **Honest truncation.** A bounded block always carries the marker AND a
 * human-readable suffix on the preview text, both naming the durable
 * store as the place the full content survives. Nothing disappears
 * silently — the client is told content was bounded and how to get the
 * rest (cross-references the future `timeline_history` read).
 *
 * @see docs/proposals/v2/STATUS.md ROADMAP A3
 * @verifiedBy packages/spec/src/__tests__/tool-output-bound.spec.ts
 */

import type { ContentBlock } from "./content-blocks.js";
import { foldContentBlockWith } from "./content-blocks.js";

/**
 * Default per-block ceiling for an inline tool-output payload projected to
 * a client: 32 KiB. Generous enough that ordinary results (JSON blobs,
 * short file reads, command output) pass through untouched, small enough
 * that a runaway `cat huge.log` never floods the browser. Tune via
 * {@link ToolOutputBoundOptions.maxToolResultBytes}.
 */
export const DEFAULT_MAX_TOOL_RESULT_BYTES = 32 * 1024;

/**
 * Key under {@link BaseContentBlock.metadata} where the bounding marker is
 * stamped. A client reads `block.metadata[BOUNDED_METADATA_KEY]` to learn
 * the block was truncated and by how much.
 */
export const BOUNDED_METADATA_KEY = "bounded";

/** Why a block was bounded. */
export type BoundedReason = "text-over-limit" | "inline-data-over-limit";

/**
 * The honest marker stamped on a bounded block's metadata. Machine-readable
 * twin of the human suffix appended to truncated preview text.
 */
export interface BoundedContentMarker {
  /** Always true — the block WAS truncated at the client projection. */
  readonly truncated: true;
  /** UTF-8 byte length of the ORIGINAL inline payload (what the store holds). */
  readonly originalBytes: number;
  /** UTF-8 byte length of the retained preview (0 for stripped binary). */
  readonly retainedBytes: number;
  readonly reason: BoundedReason;
  /** How to obtain the full content — the durable store / timeline_history. */
  readonly hint: string;
}

/**
 * Delegation context handed to a custom {@link ToolOutputBoundOptions.boundToolOutput}.
 * `bound` is the framework default — call it, then tweak, or ignore it and
 * do your own thing.
 */
export interface ToolOutputBoundCtx {
  readonly maxBytes: number;
  readonly bound: (block: ContentBlock) => ContentBlock;
}

/**
 * Replace the per-block bounder outright. Receives each tool-output block
 * and a {@link ToolOutputBoundCtx} whose `bound` is the framework default.
 * Return the block to keep it, or a bounded copy. This is the escape hatch
 * for domain-specific policy (keep the first N rows of a CSV, drop images
 * entirely, …). Honest bounding never silently DROPS a block — return a
 * marker-bearing replacement, not `null`.
 */
export type BoundToolOutput = (block: ContentBlock, ctx: ToolOutputBoundCtx) => ContentBlock;

/**
 * Adopter-facing options for the client tool-output projection (the seam).
 * Flat, per the v2 `withX` convention.
 */
export interface ToolOutputBoundOptions {
  /**
   * Per-block inline-payload ceiling in UTF-8 bytes. Default
   * {@link DEFAULT_MAX_TOOL_RESULT_BYTES}. `Infinity` disables bounding
   * (everything passes through).
   */
  readonly maxToolResultBytes?: number;
  /** Replace the per-block bounder outright — see {@link BoundToolOutput}. */
  readonly boundToolOutput?: BoundToolOutput;
}

/**
 * A resolved, ready-to-apply bounder. Held by the gateway
 * (`GatewayHarnessProtocol.clientProjection`) and applied at the transport
 * dispatch boundary.
 */
export interface ToolOutputBounder {
  readonly maxBytes: number;
  /**
   * Bound ONE block that IS tool output (recurses into a
   * `tool_result`'s `content` and a `tool_use`'s `toolResult`). Returns the
   * same reference when nothing exceeds the limit.
   */
  boundOutputBlock(block: ContentBlock): ContentBlock;
  /** Map {@link boundOutputBlock} over a raw tool-output array (identity when unchanged). */
  boundOutputBlocks(blocks: readonly ContentBlock[]): readonly ContentBlock[];
  /**
   * Bound tool output WITHIN a message-content array. Only `tool_result` /
   * `tool_use` blocks are inspected (and their inline payloads bounded);
   * plain user/assistant prose blocks pass through UNTOUCHED — a message
   * transcript's text is not tool output and is never truncated here.
   */
  boundMessageContent(blocks: readonly ContentBlock[]): readonly ContentBlock[];
}

// ─────────────────────────────────────────────────────────────────────────
// Byte helpers (platform-independent — TextEncoder/TextDecoder are global in
// Node and browsers). A size CHECK plus a boundary-safe UTF-8 truncation.
// ─────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}

/** Truncate to `budget` UTF-8 bytes at a safe char boundary. */
function truncateUtf8(s: string, budget: number): { text: string; retained: number } {
  const bytes = encoder.encode(s);
  if (bytes.length <= budget) return { text: s, retained: bytes.length };
  let text = decoder.decode(bytes.subarray(0, budget));
  // A split multibyte sequence at the cut becomes U+FFFD — drop it so the
  // preview is clean, valid text.
  if (text.endsWith("�")) text = text.slice(0, -1);
  return { text, retained: utf8Bytes(text) };
}

const HINT =
  "Bounded at the client projection — full content survives in the durable timeline store " +
  "(read via timeline_history).";

function stamp(block: ContentBlock, marker: BoundedContentMarker): ContentBlock {
  return {
    ...block,
    metadata: { ...(block.metadata ?? {}), [BOUNDED_METADATA_KEY]: marker },
  } as ContentBlock;
}

/**
 * Bound a text-bearing field: replace with a byte-budgeted preview plus an
 * honest suffix, stamp the marker. Returns the block unchanged when within
 * limit (same reference).
 */
function boundTextField<B extends ContentBlock>(
  block: B,
  text: string,
  maxBytes: number,
  set: (preview: string) => B,
): ContentBlock {
  const originalBytes = utf8Bytes(text);
  if (originalBytes <= maxBytes) return block;
  const { text: preview, retained } = truncateUtf8(text, maxBytes);
  const suffix = `\n\n… [truncated ${originalBytes - retained} of ${originalBytes} bytes — ${HINT}]`;
  const marker: BoundedContentMarker = {
    truncated: true,
    originalBytes,
    retainedBytes: retained,
    reason: "text-over-limit",
    hint: HINT,
  };
  return stamp(set(preview + suffix), marker);
}

/**
 * Bound an inline binary/base64 field: a partial base64 string is useless
 * to a client (it can't decode a truncated image), so strip it entirely and
 * mark. The full bytes survive in the durable store.
 */
function boundDataField<B extends ContentBlock>(
  block: B,
  data: string,
  maxBytes: number,
  set: (stripped: string) => B,
): ContentBlock {
  const originalBytes = utf8Bytes(data);
  if (originalBytes <= maxBytes) return block;
  const marker: BoundedContentMarker = {
    truncated: true,
    originalBytes,
    retainedBytes: 0,
    reason: "inline-data-over-limit",
    hint: HINT,
  };
  return stamp(set(""), marker);
}

function byteLenOf(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data) ?? undefined;
  } catch {
    return undefined; // unserializable — leave it be
  }
}

/**
 * The framework default per-block bounder. `recurse` bounds a nested array
 * (used for `tool_result.content`) — threading the RESOLVED bounder so a
 * custom override reaches nested blocks too.
 */
function defaultBoundOutputBlock(
  block: ContentBlock,
  maxBytes: number,
  recurse: (blocks: readonly ContentBlock[]) => readonly ContentBlock[],
  recurseOne: (block: ContentBlock) => ContentBlock,
): ContentBlock {
  return foldContentBlockWith<ContentBlock>(
    block,
    {
      // Textual — truncate the inline text.
      text: (b) => boundTextField(b, b.text, maxBytes, (t) => ({ ...b, text: t })),
      reasoning: (b) => boundTextField(b, b.text, maxBytes, (t) => ({ ...b, text: t })),
      xml: (b) => boundTextField(b, b.text, maxBytes, (t) => ({ ...b, text: t })),
      csv: (b) => boundTextField(b, b.text, maxBytes, (t) => ({ ...b, text: t })),
      html: (b) => boundTextField(b, b.text, maxBytes, (t) => ({ ...b, text: t })),
      code: (b) => boundTextField(b, b.text, maxBytes, (t) => ({ ...b, text: t })),
      executable_code: (b) => boundTextField(b, b.code, maxBytes, (c) => ({ ...b, code: c })),
      code_execution_result: (b) =>
        boundTextField(b, b.output, maxBytes, (o) => ({ ...b, output: o })),
      custom: (b) => boundTextField(b, b.content, maxBytes, (c) => ({ ...b, content: c })),
      // JSON — measure `data` (serialized) or `text`; on overflow drop the
      // structured `data` and keep a truncated textual preview.
      json: (b) => {
        const serialized = byteLenOf(b.data ?? b.text);
        if (serialized === undefined) return b;
        const originalBytes = utf8Bytes(serialized);
        if (originalBytes <= maxBytes) return b;
        const { text: preview, retained } = truncateUtf8(serialized, maxBytes);
        const marker: BoundedContentMarker = {
          truncated: true,
          originalBytes,
          retainedBytes: retained,
          reason: "text-over-limit",
          hint: HINT,
        };
        return stamp(
          { ...b, data: undefined, text: `${preview}\n\n… [truncated — ${HINT}]` },
          marker,
        );
      },
      // Inline binary — strip base64.
      generated_image: (b) => boundDataField(b, b.data, maxBytes, (d) => ({ ...b, data: d })),
      resource: (b) => {
        const r = b.resource;
        if ("text" in r) {
          return boundTextField(b, r.text, maxBytes, (t) => ({
            ...b,
            resource: { ...r, text: t },
          }));
        }
        return boundDataField(b, r.blob, maxBytes, (d) => ({ ...b, resource: { ...r, blob: d } }));
      },
      image: (b) => boundMediaSource(b, maxBytes),
      document: (b) => boundMediaSource(b, maxBytes),
      audio: (b) => boundMediaSource(b, maxBytes),
      video: (b) => boundMediaSource(b, maxBytes),
      // Tool blocks — recurse into the nested tool output.
      tool_result: (b) => {
        const content = recurse(b.content);
        return content === b.content ? b : { ...b, content };
      },
      tool_use: (b) => {
        if (!b.toolResult) return b;
        const toolResult = recurseOne(b.toolResult) as typeof b.toolResult;
        return toolResult === b.toolResult ? b : { ...b, toolResult };
      },
    },
    // Everything else (tool_use w/o result handled above, task_ref,
    // event blocks, generated_file (uri only), non-base64 media) carries no
    // oversized inline payload — pass through. Explicit, greppable, no
    // silent DROP.
    (b) => b,
  );
}

/** Bound a media block ONLY when its source is inline base64. */
function boundMediaSource<B extends ContentBlock & { readonly source: { readonly type: string } }>(
  block: B,
  maxBytes: number,
): ContentBlock {
  const source = block.source as { type: string; data?: string };
  if (source.type !== "base64" || typeof source.data !== "string") return block;
  return boundDataField(block, source.data, maxBytes, (d) => ({
    ...block,
    source: { ...source, data: d },
  }));
}

function mapChanged<T>(arr: readonly T[], fn: (t: T) => T): readonly T[] {
  let changed = false;
  const out = arr.map((t) => {
    const n = fn(t);
    if (n !== t) changed = true;
    return n;
  });
  return changed ? out : arr;
}

/**
 * Resolve {@link ToolOutputBoundOptions} into an applyable
 * {@link ToolOutputBounder}. The CORE options→bounder resolver — always
 * returns a live bounder (bounding IS on for the returned instance). With
 * no options, the {@link DEFAULT_MAX_TOOL_RESULT_BYTES} (32 KiB) ceiling.
 *
 * This does NOT decide the opt-in switch — a bounder always bounds. The
 * off-by-default gate lives in {@link resolveTruncateToolResults}, which
 * returns `undefined` (no bounder ⇒ no projection) when the adopter has
 * not opted in.
 */
export function resolveToolOutputBounder(options?: ToolOutputBoundOptions): ToolOutputBounder {
  const maxBytes = options?.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;

  // Forward-declared object so the tool_result/tool_use recursion and the
  // adopter override both resolve `boundOutputBlock` lazily (at call time).
  const bounder: ToolOutputBounder = {
    maxBytes,
    boundOutputBlock: (block) => boundOutputBlock(block),
    boundOutputBlocks: (blocks) => mapChanged(blocks, boundOutputBlock),
    boundMessageContent: (blocks) => mapChanged(blocks, boundMessageBlock),
  };

  const defaultBound = (block: ContentBlock): ContentBlock =>
    defaultBoundOutputBlock(block, maxBytes, bounder.boundOutputBlocks, bounder.boundOutputBlock);

  const boundOutputBlock: (block: ContentBlock) => ContentBlock =
    options?.boundToolOutput !== undefined
      ? (block) => options.boundToolOutput!(block, { maxBytes, bound: defaultBound })
      : defaultBound;

  // Message-content bounder: only tool output within the message is touched.
  const boundMessageBlock = (block: ContentBlock): ContentBlock => {
    if (block.type === "tool_result" || block.type === "tool_use") return boundOutputBlock(block);
    return block;
  };

  return bounder;
}

/**
 * The bounder used when an adopter enables bounding without tuning it —
 * `createGateway({ truncateToolResults: true })`. The 32 KiB
 * {@link DEFAULT_MAX_TOOL_RESULT_BYTES} ceiling. NOT applied unless opted
 * into (see {@link resolveTruncateToolResults}).
 */
export const defaultToolOutputBounder: ToolOutputBounder = resolveToolOutputBounder();

/** A disable — every block passes through untouched. */
export const passthroughToolOutputBounder: ToolOutputBounder = {
  maxBytes: Infinity,
  boundOutputBlock: (b) => b,
  boundOutputBlocks: (b) => b,
  boundMessageContent: (b) => b,
};

/**
 * The tuned form of the {@link TruncateToolResultsSetting} switch —
 * user-facing, self-describing keys (NOT the internal projection
 * vocabulary). Both fields optional; `{}` is "on at the default ceiling".
 */
export interface TruncateToolResultsOptions {
  /**
   * Per-block ceiling in UTF-8 bytes for tool-result content sent to a
   * client. Default {@link DEFAULT_MAX_TOOL_RESULT_BYTES} (32 KiB).
   */
  readonly maxBytes?: number;
  /**
   * Replace the per-block bounder outright (the full custom seam). Receives
   * each tool-output block and a {@link ToolOutputBoundCtx} whose `bound`
   * still delegates to the framework default. See {@link BoundToolOutput}.
   */
  readonly truncate?: BoundToolOutput;
}

/**
 * The `createGateway({ truncateToolResults })` switch — STRICTLY OPT-IN, the
 * exact twin of the `createApp({ telemetry })` switch (`boolean | options`,
 * off unless turned on). Bounds oversized tool-result content sent to
 * clients over the wire — NEVER the model path, NEVER the durable store.
 * Enable forms:
 *
 *   - `true` — on at the 32 KiB {@link DEFAULT_MAX_TOOL_RESULT_BYTES}
 *     default ({@link defaultToolOutputBounder}). The zero-config switch.
 *   - a {@link TruncateToolResultsOptions} — on, tuned (`{ maxBytes }`) or
 *     with a custom `{ truncate }` per-block bounder.
 *
 * `false` / omitted → OFF: no bounder, so the wire dispatch boundary skips
 * the projection entirely (zero overhead — the twin of telemetry's
 * off-path).
 */
export type TruncateToolResultsSetting = boolean | TruncateToolResultsOptions;

/**
 * Resolve the opt-in {@link TruncateToolResultsSetting} into a
 * {@link ToolOutputBounder}, or `undefined` when bounding is OFF. The
 * gateway holds the result on its (internal) `clientProjection` slot; the
 * wire dispatch boundary treats `undefined` as "skip projection" (zero
 * overhead). The off-by-default gate — mirrors `normalizeTelemetry`'s
 * `{ enabled: false }` off-path. Maps the user-facing keys
 * (`maxBytes` / `truncate`) onto the internal {@link ToolOutputBoundOptions}.
 *
 * @verifiedBy packages/spec/src/__tests__/tool-output-bound.spec.ts
 */
export function resolveTruncateToolResults(
  setting?: TruncateToolResultsSetting,
): ToolOutputBounder | undefined {
  if (setting === undefined || setting === false) return undefined; // OFF — zero overhead
  if (setting === true) return defaultToolOutputBounder; // ON — 32 KiB default
  return resolveToolOutputBounder({
    ...(setting.maxBytes !== undefined ? { maxToolResultBytes: setting.maxBytes } : {}),
    ...(setting.truncate !== undefined ? { boundToolOutput: setting.truncate } : {}),
  });
}
